-- Apply after ticket-completion.sql. The completion message and its notification
-- reservation commit together. Provider delivery remains a separate step.
BEGIN;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.yutakasa_ticket_completion_proofs p
    WHERE p.used_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'existing completion messages require notification reconciliation';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.yutakasa_ticket_completion_notices (
  work_id UUID PRIMARY KEY REFERENCES public.yutakasa_ticket_completion_proofs(work_id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  message_id UUID NOT NULL UNIQUE REFERENCES public.support_messages(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  ticket_subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','uncertain','accepted','suppressed','needs_review')),
  first_attempt_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  claim_token UUID,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 30),
  provider_email_id UUID,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,100}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='accepted')=(provider_email_id IS NOT NULL)),
  CHECK ((status='sending')=(claim_token IS NOT NULL AND claimed_at IS NOT NULL))
);
ALTER TABLE public.yutakasa_ticket_completion_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_ticket_completion_notices FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.yutakasa_ticket_completion_notices TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_yutakasa_ticket_completion_notice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_status TEXT;
BEGIN
  IF OLD.used_message_id IS NOT NULL THEN
    IF NEW.used_message_id IS DISTINCT FROM OLD.used_message_id THEN
      RAISE EXCEPTION 'completion proof use is immutable' USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.used_message_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id=NEW.ticket_id;
  IF NOT FOUND OR v_ticket.user_email IS NULL OR v_ticket.subject IS NULL
    OR position(chr(10) IN v_ticket.subject)>0
    OR position(chr(13) IN v_ticket.subject)>0 THEN
    RAISE EXCEPTION 'completion notice recipient invalid' USING ERRCODE='P0001';
  END IF;
  v_status:=CASE WHEN v_ticket.user_email ~* '^yutakasa-auto-smoke\+[^@]+@example\.invalid$'
    OR v_ticket.user_email ~* '^codex[-+.].*@silversense\.cc$'
    THEN 'suppressed' ELSE 'pending' END;
  INSERT INTO public.yutakasa_ticket_completion_notices(
    work_id,ticket_id,message_id,recipient_email,ticket_subject,idempotency_key,status
  ) VALUES(NEW.work_id,NEW.ticket_id,NEW.used_message_id,v_ticket.user_email,
    v_ticket.subject,'yutakasa-ticket-completion/'||NEW.work_id::TEXT,v_status);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reserve_yutakasa_ticket_completion_notice
  ON public.yutakasa_ticket_completion_proofs;
CREATE TRIGGER reserve_yutakasa_ticket_completion_notice
  AFTER UPDATE OF used_message_id ON public.yutakasa_ticket_completion_proofs
  FOR EACH ROW EXECUTE FUNCTION public.reserve_yutakasa_ticket_completion_notice();

CREATE OR REPLACE FUNCTION public.get_yutakasa_ticket_completion_context(p_work_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_work_id IS NULL THEN RAISE EXCEPTION 'invalid repair work' USING ERRCODE='22023'; END IF;
  RETURN (SELECT jsonb_build_object('work_id',p.work_id,'pr_number',p.pr_number,
    'merge_sha',p.merge_sha,'deployment_id',p.deployment_id,
    'scenario_key',p.scenario_key,'notice_ready',
      EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=
        'public.yutakasa_ticket_completion_proofs'::regclass
        AND t.tgname='reserve_yutakasa_ticket_completion_notice' AND t.tgenabled='O'))
    FROM public.yutakasa_ticket_completion_proofs p
    JOIN public.yutakasa_ticket_repair_jobs j ON j.work_id=p.work_id
    WHERE p.work_id=p_work_id AND p.used_message_id IS NULL AND j.status='pr_open');
END;
$$;

CREATE OR REPLACE FUNCTION public.list_due_yutakasa_completion_notices()
RETURNS TABLE(work_id UUID) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT n.work_id FROM public.yutakasa_ticket_completion_notices n
  WHERE n.status IN ('pending','needs_review')
    OR (n.status='uncertain' AND n.updated_at<clock_timestamp()-INTERVAL '1 minute')
    OR (n.status='sending' AND n.claimed_at<clock_timestamp()-INTERVAL '3 minutes')
  ORDER BY CASE WHEN n.status='needs_review' THEN 1 ELSE 0 END,
    n.created_at LIMIT 21;
$$;

CREATE OR REPLACE FUNCTION public.claim_yutakasa_completion_notice(
  p_work_id UUID,p_claim_token UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_completion_notices%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
  IF p_work_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'invalid completion notice claim' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_completion_notices n
    WHERE n.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'completion notice missing' USING ERRCODE='P0002'; END IF;
  IF v_notice.status IN ('accepted','suppressed','needs_review') THEN
    RETURN jsonb_build_object('status',v_notice.status);
  END IF;
  IF v_notice.status='sending' AND v_notice.claimed_at>v_now-INTERVAL '3 minutes' THEN
    RETURN jsonb_build_object('status','busy');
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_notice.ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.user_email IS DISTINCT FROM v_notice.recipient_email THEN
    UPDATE public.yutakasa_ticket_completion_notices n SET
      status='needs_review',claim_token=NULL,claimed_at=NULL,
      last_error_code='recipient_changed',updated_at=v_now WHERE n.work_id=p_work_id;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(v_notice.ticket_id,'completion_notice_needs_review',
        '返信通知メールの宛先が変更されました。担当者の照合が必要です。',
        jsonb_build_object('work_id',p_work_id,'message_id',v_notice.message_id));
    RETURN jsonb_build_object('status','needs_review');
  END IF;
  -- Resend keeps idempotency keys for 24 hours. Keep one hour of margin.
  IF (v_notice.first_attempt_at IS NOT NULL AND
      v_notice.first_attempt_at<v_now-INTERVAL '23 hours') OR
      v_notice.attempt_count>=30 THEN
    UPDATE public.yutakasa_ticket_completion_notices n SET
      status='needs_review',claim_token=NULL,claimed_at=NULL,
      last_error_code='provider_outcome_uncertain',updated_at=v_now WHERE n.work_id=p_work_id;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(v_notice.ticket_id,'completion_notice_needs_review',
        '返信通知メールの送信結果を確認できません。担当者の照合が必要です。',
        jsonb_build_object('work_id',p_work_id,'message_id',v_notice.message_id));
    RETURN jsonb_build_object('status','needs_review');
  END IF;
  UPDATE public.yutakasa_ticket_completion_notices n SET
    status='sending',claim_token=p_claim_token,claimed_at=v_now,
    first_attempt_at=coalesce(n.first_attempt_at,v_now),
    attempt_count=n.attempt_count+1,updated_at=v_now WHERE n.work_id=p_work_id;
  RETURN jsonb_build_object('status','sending','work_id',p_work_id,
    'claim_token',p_claim_token,'recipient_email',v_notice.recipient_email,
    'ticket_subject',v_notice.ticket_subject,
    'idempotency_key',v_notice.idempotency_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_yutakasa_completion_notice(
  p_work_id UUID,p_claim_token UUID,p_provider_email_id UUID
)
RETURNS TABLE(status TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_completion_notices%ROWTYPE;
BEGIN
  IF p_work_id IS NULL OR p_claim_token IS NULL OR p_provider_email_id IS NULL THEN
    RAISE EXCEPTION 'invalid completion notice receipt' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_completion_notices n
    WHERE n.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND OR v_notice.status<>'sending' OR v_notice.claim_token IS DISTINCT FROM p_claim_token
    THEN RAISE EXCEPTION 'completion notice ownership lost' USING ERRCODE='P0001'; END IF;
  UPDATE public.yutakasa_ticket_completion_notices n SET
    status='accepted',provider_email_id=p_provider_email_id,
    claim_token=NULL,claimed_at=NULL,last_error_code=NULL,updated_at=clock_timestamp()
    WHERE n.work_id=p_work_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(v_notice.ticket_id,'completion_notice_provider_accepted',
      '返信通知メールを送信サービスが受け付けました。配信完了は未確認です。',
      jsonb_build_object('work_id',p_work_id,'message_id',v_notice.message_id,
        'provider_email_id',p_provider_email_id));
  RETURN QUERY SELECT 'accepted'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_yutakasa_completion_notice_uncertain(
  p_work_id UUID,p_claim_token UUID,p_error_code TEXT
)
RETURNS TABLE(status TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_completion_notices%ROWTYPE;
BEGIN
  IF p_work_id IS NULL OR p_claim_token IS NULL OR p_error_code IS NULL
    OR p_error_code !~ '^[a-z][a-z0-9_]{0,100}$' THEN
    RAISE EXCEPTION 'invalid completion notice failure' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_completion_notices n
    WHERE n.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND OR v_notice.status<>'sending' OR v_notice.claim_token IS DISTINCT FROM p_claim_token
    THEN RAISE EXCEPTION 'completion notice ownership lost' USING ERRCODE='P0001'; END IF;
  UPDATE public.yutakasa_ticket_completion_notices n SET
    status=CASE WHEN p_error_code='invalid_notice_payload' THEN 'needs_review' ELSE 'uncertain' END,
    claim_token=NULL,claimed_at=NULL,
    last_error_code=p_error_code,updated_at=clock_timestamp() WHERE n.work_id=p_work_id;
  IF p_error_code='invalid_notice_payload' THEN
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(v_notice.ticket_id,'completion_notice_needs_review',
        '返信通知メールの宛先または件名を確認できません。担当者の照合が必要です。',
        jsonb_build_object('work_id',p_work_id,'message_id',v_notice.message_id));
  END IF;
  RETURN QUERY SELECT CASE WHEN p_error_code='invalid_notice_payload'
    THEN 'needs_review' ELSE 'uncertain' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_yutakasa_ticket_completion_notice()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_yutakasa_ticket_completion_context(UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_due_yutakasa_completion_notices()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_yutakasa_completion_notice(UUID,UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_yutakasa_completion_notice(UUID,UUID,UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mark_yutakasa_completion_notice_uncertain(UUID,UUID,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_due_yutakasa_completion_notices() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_yutakasa_completion_notice(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_yutakasa_completion_notice(UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_yutakasa_completion_notice_uncertain(UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_yutakasa_ticket_completion_context(UUID) TO service_role;

COMMIT;
