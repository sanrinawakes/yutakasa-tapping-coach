BEGIN;
DO $$
DECLARE v_ticket UUID;
DECLARE v_user UUID;
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_claim UUID:=gen_random_uuid();
DECLARE v_provider UUID:=gen_random_uuid();
DECLARE v_version TIMESTAMPTZ;
DECLARE v_created RECORD;
DECLARE v_reply RECORD;
DECLARE v_retry RECORD;
DECLARE v_notice JSONB;
DECLARE v_count INTEGER;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='yutakasa_ticket_clarification_notices'
      AND c.relrowsecurity)
    OR has_table_privilege('anon','public.yutakasa_ticket_clarification_notices','SELECT')
    OR has_table_privilege('authenticated','public.yutakasa_ticket_clarification_notices','SELECT')
    OR NOT has_table_privilege('service_role','public.yutakasa_ticket_clarification_notices','SELECT')
    OR has_table_privilege('service_role','public.yutakasa_ticket_clarification_notices','INSERT')
    OR has_table_privilege('service_role','public.yutakasa_ticket_clarification_notices','UPDATE')
    OR has_function_privilege('authenticated',
      'public.claim_yutakasa_clarification_notice(uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.claim_yutakasa_clarification_notice(uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.yutakasa_clarification_notice_ready()','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.yutakasa_clarification_notice_ready()','EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=
      'public.yutakasa_ticket_clarifications'::regclass AND
      t.tgname='reserve_yutakasa_ticket_clarification_notice' AND t.tgenabled='O')
    OR NOT public.yutakasa_clarification_notice_ready() THEN
    RAISE EXCEPTION 'clarification notice access or trigger invalid';
  END IF;

  INSERT INTO public.subscribers(email) VALUES('clarification-notice-test@example.invalid');
  SELECT * INTO v_created FROM public.create_support_ticket_with_message(
    'clarification-notice-test@example.invalid','technical','使えない','使えない',
    gen_random_uuid(),FALSE,'[]'::jsonb);
  v_ticket:=v_created.ticket_id;
  v_user:=v_created.message_id;
  SELECT t.updated_at INTO v_version FROM public.claim_support_ticket_with_log(v_ticket,v_lock) t;
  SELECT * INTO v_reply FROM public.append_yutakasa_ticket_clarification(
    v_ticket,v_lock,v_user,v_version);
  SELECT * INTO v_retry FROM public.append_yutakasa_ticket_clarification(
    v_ticket,v_lock,v_user,v_version);
  IF NOT v_reply.created OR v_retry.created OR v_retry.message_id<>v_reply.message_id THEN
    RAISE EXCEPTION 'clarification idempotency invalid';
  END IF;
  SELECT count(*) INTO v_count FROM public.yutakasa_ticket_clarification_notices n
    WHERE n.ticket_id=v_ticket AND n.message_id=v_reply.message_id
      AND n.recipient_email='clarification-notice-test@example.invalid'
      AND n.idempotency_key='yutakasa-ticket-clarification/'||v_ticket::TEXT
      AND n.status='pending';
  IF v_count<>1 THEN RAISE EXCEPTION 'clarification outbox not reserved atomically'; END IF;
  v_notice:=public.claim_yutakasa_clarification_notice(v_ticket,v_claim);
  IF v_notice->>'status'<>'sending' OR v_notice->>'ticket_id'<>v_ticket::TEXT OR
    v_notice->>'claim_token'<>v_claim::TEXT OR
    v_notice->>'recipient_email'<>'clarification-notice-test@example.invalid' THEN
    RAISE EXCEPTION 'clarification notice claim invalid';
  END IF;
  IF public.claim_yutakasa_clarification_notice(v_ticket,gen_random_uuid())->>'status'<>'busy' THEN
    RAISE EXCEPTION 'duplicate clarification notice claim accepted';
  END IF;
  BEGIN
    PERFORM * FROM public.finish_yutakasa_clarification_notice(
      v_ticket,gen_random_uuid(),v_provider);
    RAISE EXCEPTION 'wrong notification claim accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  PERFORM * FROM public.finish_yutakasa_clarification_notice(v_ticket,v_claim,v_provider);
  IF public.claim_yutakasa_clarification_notice(v_ticket,gen_random_uuid())->>'status'<>'accepted'
    OR EXISTS(SELECT 1 FROM public.list_due_yutakasa_clarification_notices() d
      WHERE d.ticket_id=v_ticket) THEN
    RAISE EXCEPTION 'provider receipt or queue terminal state invalid';
  END IF;
END;
$$;
ALTER TABLE public.yutakasa_ticket_clarifications
  DISABLE TRIGGER reserve_yutakasa_ticket_clarification_notice;
DO $$ BEGIN
  IF public.yutakasa_clarification_notice_ready() THEN
    RAISE EXCEPTION 'disabled reservation trigger reported ready';
  END IF;
END $$;
ROLLBACK;
