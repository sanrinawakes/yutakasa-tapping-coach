-- A durable, one-email-per-user-message outbox for technical tickets that
-- have left automatic repair and require Codex investigation.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_ticket_technical_escalation_notices (
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  latest_user_message_id UUID NOT NULL REFERENCES public.support_messages(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','uncertain','accepted','needs_review')),
  first_attempt_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  claim_token UUID,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 30),
  provider_email_id UUID,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,100}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (ticket_id,latest_user_message_id),
  CHECK ((status='accepted')=(provider_email_id IS NOT NULL)),
  CHECK ((status='sending')=(claim_token IS NOT NULL AND claimed_at IS NOT NULL))
);
ALTER TABLE public.yutakasa_ticket_technical_escalation_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_ticket_technical_escalation_notices FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.yutakasa_ticket_technical_escalation_notices TO service_role;

CREATE OR REPLACE FUNCTION public.list_due_yutakasa_technical_escalation_notices()
RETURNS TABLE(ticket_id UUID,latest_user_message_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT t.id,m.id
  FROM public.support_tickets t
  JOIN LATERAL (
    SELECT sm.id FROM public.support_messages sm
    WHERE sm.ticket_id=t.id AND sm.sender_type='user'
    ORDER BY sm.created_at DESC,sm.id DESC LIMIT 1
  ) m ON true
  LEFT JOIN public.yutakasa_ticket_technical_escalation_notices n
    ON n.ticket_id=t.id AND n.latest_user_message_id=m.id
  WHERE t.category='technical' AND t.decision_required=FALSE
    AND t.status IN ('open','in_progress')
    AND t.automation_status='manual_review'
    AND t.user_email !~* '^yutakasa-auto-smoke\+[^@]+@example\.invalid$'
    AND t.user_email !~* '^codex[-+.].*@silversense\.cc$'
    AND (n.ticket_id IS NULL OR n.status='pending'
      OR (n.status='uncertain' AND n.updated_at<clock_timestamp()-INTERVAL '1 minute')
      OR (n.status='sending' AND n.claimed_at<clock_timestamp()-INTERVAL '3 minutes'))
  ORDER BY t.updated_at,t.id LIMIT 21;
$$;

CREATE OR REPLACE FUNCTION public.claim_yutakasa_technical_escalation_notice(
  p_ticket_id UUID,p_latest_user_message_id UUID,p_claim_token UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_notice public.yutakasa_ticket_technical_escalation_notices%ROWTYPE;
DECLARE v_latest UUID;
DECLARE v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
  IF p_ticket_id IS NULL OR p_latest_user_message_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'invalid technical escalation claim' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id=p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.category<>'technical' OR v_ticket.decision_required
    OR v_ticket.status NOT IN ('open','in_progress')
    OR v_ticket.automation_status<>'manual_review'
    OR v_ticket.user_email ~* '^yutakasa-auto-smoke\+[^@]+@example\.invalid$'
    OR v_ticket.user_email ~* '^codex[-+.].*@silversense\.cc$' THEN
    RETURN jsonb_build_object('status','suppressed');
  END IF;
  SELECT m.id INTO v_latest FROM public.support_messages m
    WHERE m.ticket_id=p_ticket_id AND m.sender_type='user'
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_latest_user_message_id THEN
    RETURN jsonb_build_object('status','suppressed');
  END IF;
  INSERT INTO public.yutakasa_ticket_technical_escalation_notices(
    ticket_id,latest_user_message_id,idempotency_key,status
  ) VALUES (p_ticket_id,p_latest_user_message_id,
    'yutakasa-technical-escalation/'||p_ticket_id::TEXT||'/'||p_latest_user_message_id::TEXT,
    'pending') ON CONFLICT DO NOTHING;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_technical_escalation_notices n
    WHERE n.ticket_id=p_ticket_id AND n.latest_user_message_id=p_latest_user_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'technical escalation notice missing' USING ERRCODE='P0002'; END IF;
  IF v_notice.status IN ('accepted','needs_review') THEN
    RETURN jsonb_build_object('status',v_notice.status);
  END IF;
  IF v_notice.status='sending' AND v_notice.claimed_at>v_now-INTERVAL '3 minutes' THEN
    RETURN jsonb_build_object('status','busy');
  END IF;
  -- Resend retains an idempotency key for 24 hours. Stop before that window closes.
  IF (v_notice.first_attempt_at IS NOT NULL AND
      v_notice.first_attempt_at<v_now-INTERVAL '23 hours') OR v_notice.attempt_count>=30 THEN
    UPDATE public.yutakasa_ticket_technical_escalation_notices n SET
      status='needs_review',claim_token=NULL,claimed_at=NULL,
      last_error_code='provider_outcome_uncertain',updated_at=v_now
      WHERE n.ticket_id=p_ticket_id AND n.latest_user_message_id=p_latest_user_message_id;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(p_ticket_id,'technical_escalation_notice_needs_review',
        '技術案件の管理者通知結果を確認できません。送信サービスと管理画面で照合が必要です。',
        jsonb_build_object('latest_user_message_id',p_latest_user_message_id));
    RETURN jsonb_build_object('status','needs_review');
  END IF;
  UPDATE public.yutakasa_ticket_technical_escalation_notices n SET
    status='sending',claim_token=p_claim_token,claimed_at=v_now,
    first_attempt_at=coalesce(n.first_attempt_at,v_now),
    attempt_count=n.attempt_count+1,updated_at=v_now
    WHERE n.ticket_id=p_ticket_id AND n.latest_user_message_id=p_latest_user_message_id;
  RETURN jsonb_build_object('status','sending','ticket_id',p_ticket_id,
    'latest_user_message_id',p_latest_user_message_id,
    'claim_token',p_claim_token,'idempotency_key',v_notice.idempotency_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_yutakasa_technical_escalation_notice(
  p_ticket_id UUID,p_latest_user_message_id UUID,p_claim_token UUID,p_provider_email_id UUID
)
RETURNS TABLE(status TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_technical_escalation_notices%ROWTYPE;
BEGIN
  IF p_ticket_id IS NULL OR p_latest_user_message_id IS NULL OR
     p_claim_token IS NULL OR p_provider_email_id IS NULL THEN
    RAISE EXCEPTION 'invalid technical escalation receipt' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_technical_escalation_notices n
    WHERE n.ticket_id=p_ticket_id AND n.latest_user_message_id=p_latest_user_message_id FOR UPDATE;
  IF NOT FOUND OR v_notice.status<>'sending' OR v_notice.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'technical escalation ownership lost' USING ERRCODE='P0001';
  END IF;
  UPDATE public.yutakasa_ticket_technical_escalation_notices n SET
    status='accepted',provider_email_id=p_provider_email_id,claim_token=NULL,
    claimed_at=NULL,last_error_code=NULL,updated_at=clock_timestamp()
    WHERE n.ticket_id=p_ticket_id AND n.latest_user_message_id=p_latest_user_message_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(p_ticket_id,'technical_escalation_notice_provider_accepted',
      '自動対応が停止した技術案件の管理者通知を送信サービスが受け付けました。配信完了は未確認です。',
      jsonb_build_object('latest_user_message_id',p_latest_user_message_id,
        'provider_email_id',p_provider_email_id));
  RETURN QUERY SELECT 'accepted'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_yutakasa_technical_escalation_notice_uncertain(
  p_ticket_id UUID,p_latest_user_message_id UUID,p_claim_token UUID,p_error_code TEXT
)
RETURNS TABLE(status TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_technical_escalation_notices%ROWTYPE;
BEGIN
  IF p_ticket_id IS NULL OR p_latest_user_message_id IS NULL OR p_claim_token IS NULL
    OR p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_]{0,100}$' THEN
    RAISE EXCEPTION 'invalid technical escalation failure' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_technical_escalation_notices n
    WHERE n.ticket_id=p_ticket_id AND n.latest_user_message_id=p_latest_user_message_id FOR UPDATE;
  IF NOT FOUND OR v_notice.status<>'sending' OR v_notice.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'technical escalation ownership lost' USING ERRCODE='P0001';
  END IF;
  UPDATE public.yutakasa_ticket_technical_escalation_notices n SET
    status='uncertain',claim_token=NULL,claimed_at=NULL,
    last_error_code=p_error_code,updated_at=clock_timestamp()
    WHERE n.ticket_id=p_ticket_id AND n.latest_user_message_id=p_latest_user_message_id;
  RETURN QUERY SELECT 'uncertain'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.list_due_yutakasa_technical_escalation_notices()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_yutakasa_technical_escalation_notice(UUID,UUID,UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_yutakasa_technical_escalation_notice(UUID,UUID,UUID,UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mark_yutakasa_technical_escalation_notice_uncertain(UUID,UUID,UUID,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_due_yutakasa_technical_escalation_notices() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_yutakasa_technical_escalation_notice(UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_yutakasa_technical_escalation_notice(UUID,UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_yutakasa_technical_escalation_notice_uncertain(UUID,UUID,UUID,TEXT) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
