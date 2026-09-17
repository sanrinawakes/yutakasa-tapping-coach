-- Reserve a customer notification in the same transaction as the fixed
-- clarification. Install after ticket-clarification.sql, before either flag.
BEGIN;
LOCK TABLE public.yutakasa_ticket_clarifications IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.yutakasa_ticket_clarification_notices (
  ticket_id UUID PRIMARY KEY REFERENCES public.yutakasa_ticket_clarifications(ticket_id) ON DELETE CASCADE,
  message_id UUID NOT NULL UNIQUE REFERENCES public.support_messages(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
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
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.yutakasa_ticket_clarifications c
    LEFT JOIN public.yutakasa_ticket_clarification_notices n
      ON n.ticket_id=c.ticket_id AND n.message_id=c.reply_message_id
    WHERE n.ticket_id IS NULL) THEN
    RAISE EXCEPTION 'existing clarification messages require notification reconciliation';
  END IF;
END $$;
ALTER TABLE public.yutakasa_ticket_clarification_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_ticket_clarification_notices FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.yutakasa_ticket_clarification_notices TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_yutakasa_ticket_clarification_notice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_message public.support_messages%ROWTYPE;
DECLARE v_status TEXT;
BEGIN
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id=NEW.ticket_id;
  SELECT * INTO v_message FROM public.support_messages m WHERE m.id=NEW.reply_message_id;
  IF NOT FOUND OR v_ticket.user_email IS NULL OR char_length(v_ticket.user_email)>254
    OR v_ticket.user_email !~
      '^[^[:space:]@,;<>"[:cntrl:]]+@[^[:space:]@,;<>"[:cntrl:]]+\.[^[:space:]@,;<>"[:cntrl:]]+$'
    OR v_ticket.category<>'technical' OR v_ticket.subject NOT IN
      ('使えない','動かない','エラー','ログインできない','チャットが使えない',
       '送信できない','保存できない','画面が開かない','表示されない')
    OR v_message.ticket_id IS DISTINCT FROM NEW.ticket_id
    OR v_message.sender_type<>'admin'
    OR v_message.body IS DISTINCT FROM
      'お問い合わせありがとうございます。状況を確認するため、問題が起きた画面、直前に行った操作、表示されたエラー文（あれば）、発生した日時を教えてください。パスワードや認証コードは送らないでください。' THEN
    RAISE EXCEPTION 'clarification notice cannot be reserved' USING ERRCODE='P0001';
  END IF;
  v_status:=CASE WHEN v_ticket.user_email ~* '^yutakasa-auto-smoke\+[^@]+@example\.invalid$'
    OR v_ticket.user_email ~* '^codex[-+.].*@silversense\.cc$'
    THEN 'suppressed' ELSE 'pending' END;
  INSERT INTO public.yutakasa_ticket_clarification_notices(
    ticket_id,message_id,recipient_email,idempotency_key,status
  ) VALUES(NEW.ticket_id,NEW.reply_message_id,v_ticket.user_email,
    'yutakasa-ticket-clarification/'||NEW.ticket_id::TEXT,v_status);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reserve_yutakasa_ticket_clarification_notice
  ON public.yutakasa_ticket_clarifications;
CREATE TRIGGER reserve_yutakasa_ticket_clarification_notice
  AFTER INSERT ON public.yutakasa_ticket_clarifications
  FOR EACH ROW EXECUTE FUNCTION public.reserve_yutakasa_ticket_clarification_notice();

CREATE OR REPLACE FUNCTION public.yutakasa_clarification_notice_ready()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=
    'public.yutakasa_ticket_clarifications'::regclass AND
    t.tgname='reserve_yutakasa_ticket_clarification_notice' AND t.tgenabled='O');
$$;

-- A disabled reservation trigger must abort the reply transaction as well as
-- failing the API readiness probe. Both triggers are installed in one commit.
CREATE OR REPLACE FUNCTION public.require_yutakasa_clarification_notice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT public.yutakasa_clarification_notice_ready() THEN
    RAISE EXCEPTION 'clarification notice reservation unavailable' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS require_yutakasa_clarification_notice
  ON public.yutakasa_ticket_clarifications;
CREATE TRIGGER require_yutakasa_clarification_notice
  BEFORE INSERT ON public.yutakasa_ticket_clarifications
  FOR EACH ROW EXECUTE FUNCTION public.require_yutakasa_clarification_notice();

CREATE OR REPLACE FUNCTION public.list_due_yutakasa_clarification_notices()
RETURNS TABLE(ticket_id UUID) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT n.ticket_id FROM public.yutakasa_ticket_clarification_notices n
  WHERE n.status IN ('pending','needs_review')
    OR (n.status='uncertain' AND n.updated_at<clock_timestamp()-INTERVAL '1 minute')
    OR (n.status='sending' AND n.claimed_at<clock_timestamp()-INTERVAL '3 minutes')
  ORDER BY CASE WHEN n.status='needs_review' THEN 1 ELSE 0 END,
    n.created_at LIMIT 21;
$$;

CREATE OR REPLACE FUNCTION public.claim_yutakasa_clarification_notice(
  p_ticket_id UUID,p_claim_token UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_clarification_notices%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
  IF p_ticket_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'invalid clarification notice claim' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_clarification_notices n
    WHERE n.ticket_id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'clarification notice missing' USING ERRCODE='P0002'; END IF;
  IF v_notice.status IN ('accepted','suppressed','needs_review') THEN
    RETURN jsonb_build_object('status',v_notice.status);
  END IF;
  IF v_notice.status='sending' AND v_notice.claimed_at>v_now-INTERVAL '3 minutes' THEN
    RETURN jsonb_build_object('status','busy');
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id=p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.user_email IS DISTINCT FROM v_notice.recipient_email
    OR v_ticket.status<>'waiting_user' OR v_ticket.automation_status<>'completed' THEN
    UPDATE public.yutakasa_ticket_clarification_notices n SET
      status='needs_review',claim_token=NULL,claimed_at=NULL,
      last_error_code='ticket_changed',updated_at=v_now WHERE n.ticket_id=p_ticket_id;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(p_ticket_id,'clarification_notice_needs_review',
        '追加情報の質問通知は問い合わせ状態が変わったため、担当者の照合が必要です。',
        jsonb_build_object('message_id',v_notice.message_id));
    RETURN jsonb_build_object('status','needs_review');
  END IF;
  -- Resend keeps idempotency keys for 24 hours; leave one hour of margin.
  IF (v_notice.first_attempt_at IS NOT NULL AND
      v_notice.first_attempt_at<v_now-INTERVAL '23 hours') OR
      v_notice.attempt_count>=30 THEN
    UPDATE public.yutakasa_ticket_clarification_notices n SET
      status='needs_review',claim_token=NULL,claimed_at=NULL,
      last_error_code='provider_outcome_uncertain',updated_at=v_now WHERE n.ticket_id=p_ticket_id;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(p_ticket_id,'clarification_notice_needs_review',
        '追加情報の質問通知の送信結果を確認できません。担当者の照合が必要です。',
        jsonb_build_object('message_id',v_notice.message_id));
    RETURN jsonb_build_object('status','needs_review');
  END IF;
  UPDATE public.yutakasa_ticket_clarification_notices n SET
    status='sending',claim_token=p_claim_token,claimed_at=v_now,
    first_attempt_at=coalesce(n.first_attempt_at,v_now),
    attempt_count=n.attempt_count+1,updated_at=v_now WHERE n.ticket_id=p_ticket_id;
  RETURN jsonb_build_object('status','sending','ticket_id',p_ticket_id,
    'claim_token',p_claim_token,'recipient_email',v_notice.recipient_email,
    'idempotency_key',v_notice.idempotency_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_yutakasa_clarification_notice(
  p_ticket_id UUID,p_claim_token UUID,p_provider_email_id UUID
)
RETURNS TABLE(status TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_clarification_notices%ROWTYPE;
BEGIN
  IF p_ticket_id IS NULL OR p_claim_token IS NULL OR p_provider_email_id IS NULL THEN
    RAISE EXCEPTION 'invalid clarification notice receipt' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_clarification_notices n
    WHERE n.ticket_id=p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_notice.status<>'sending' OR v_notice.claim_token IS DISTINCT FROM p_claim_token
    THEN RAISE EXCEPTION 'clarification notice ownership lost' USING ERRCODE='P0001'; END IF;
  UPDATE public.yutakasa_ticket_clarification_notices n SET
    status='accepted',provider_email_id=p_provider_email_id,
    claim_token=NULL,claimed_at=NULL,last_error_code=NULL,updated_at=clock_timestamp()
    WHERE n.ticket_id=p_ticket_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(p_ticket_id,'clarification_notice_provider_accepted',
      '追加情報の質問通知メールを送信サービスが受け付けました。配信完了は未確認です。',
      jsonb_build_object('message_id',v_notice.message_id,
        'provider_email_id',p_provider_email_id));
  RETURN QUERY SELECT 'accepted'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_yutakasa_clarification_notice_uncertain(
  p_ticket_id UUID,p_claim_token UUID,p_error_code TEXT
)
RETURNS TABLE(status TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_notice public.yutakasa_ticket_clarification_notices%ROWTYPE;
BEGIN
  IF p_ticket_id IS NULL OR p_claim_token IS NULL OR p_error_code IS NULL
    OR p_error_code !~ '^[a-z][a-z0-9_]{0,100}$' THEN
    RAISE EXCEPTION 'invalid clarification notice failure' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_clarification_notices n
    WHERE n.ticket_id=p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_notice.status<>'sending' OR v_notice.claim_token IS DISTINCT FROM p_claim_token
    THEN RAISE EXCEPTION 'clarification notice ownership lost' USING ERRCODE='P0001'; END IF;
  UPDATE public.yutakasa_ticket_clarification_notices n SET
    status=CASE WHEN p_error_code='invalid_notice_payload' THEN 'needs_review' ELSE 'uncertain' END,
    claim_token=NULL,claimed_at=NULL,last_error_code=p_error_code,updated_at=clock_timestamp()
    WHERE n.ticket_id=p_ticket_id;
  IF p_error_code='invalid_notice_payload' THEN
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(p_ticket_id,'clarification_notice_needs_review',
        '追加情報の質問通知の宛先を確認できません。担当者の照合が必要です。',
        jsonb_build_object('message_id',v_notice.message_id));
  END IF;
  RETURN QUERY SELECT CASE WHEN p_error_code='invalid_notice_payload'
    THEN 'needs_review' ELSE 'uncertain' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_yutakasa_ticket_clarification_notice()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.require_yutakasa_clarification_notice()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.yutakasa_clarification_notice_ready()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_due_yutakasa_clarification_notices()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_yutakasa_clarification_notice(UUID,UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_yutakasa_clarification_notice(UUID,UUID,UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mark_yutakasa_clarification_notice_uncertain(UUID,UUID,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_due_yutakasa_clarification_notices() TO service_role;
GRANT EXECUTE ON FUNCTION public.yutakasa_clarification_notice_ready() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_yutakasa_clarification_notice(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_yutakasa_clarification_notice(UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_yutakasa_clarification_notice_uncertain(UUID,UUID,TEXT) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
