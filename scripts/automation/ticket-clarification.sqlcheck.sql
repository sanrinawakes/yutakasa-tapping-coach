BEGIN;

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='yutakasa_ticket_clarifications' AND c.relrowsecurity)
    OR has_table_privilege('anon','public.yutakasa_ticket_clarifications','SELECT')
    OR has_table_privilege('authenticated','public.yutakasa_ticket_clarifications','SELECT')
    OR has_function_privilege('authenticated',
      'public.append_yutakasa_ticket_clarification(uuid,uuid,uuid,timestamptz)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.append_yutakasa_ticket_clarification(uuid,uuid,uuid,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'clarification access control invalid';
  END IF;
END;
$$;

DO $$
DECLARE v_ticket UUID;
DECLARE v_user UUID;
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_version TIMESTAMPTZ;
DECLARE v_first RECORD;
DECLARE v_retry RECORD;
DECLARE v_count INTEGER;
BEGIN
  INSERT INTO public.subscribers(email) VALUES('clarification-test@example.invalid');
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('clarification-test@example.invalid','technical','使えない',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','使えない',gen_random_uuid()) RETURNING id INTO v_user;
  SELECT * INTO v_first FROM public.append_yutakasa_ticket_clarification(
    v_ticket,v_lock,v_user,v_version);
  IF NOT v_first.created OR v_first.message_id IS NULL THEN
    RAISE EXCEPTION 'first clarification not created';
  END IF;
  SELECT * INTO v_retry FROM public.append_yutakasa_ticket_clarification(
    v_ticket,v_lock,v_user,v_version);
  IF v_retry.created OR v_retry.message_id<>v_first.message_id THEN
    RAISE EXCEPTION 'clarification retry was not idempotent';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.id=v_ticket
    AND t.status='waiting_user' AND t.automation_status='completed'
    AND t.automation_lock_token IS NULL) THEN
    RAISE EXCEPTION 'clarification terminal state missing';
  END IF;
  SELECT count(*) INTO v_count FROM public.support_messages m
    WHERE m.ticket_id=v_ticket AND m.sender_type='admin';
  IF v_count<>1 THEN RAISE EXCEPTION 'clarification message count %',v_count; END IF;
  SELECT count(*) INTO v_count FROM public.support_work_logs w
    WHERE w.ticket_id=v_ticket AND w.event_type='automation_clarification_sent';
  IF v_count<>1 THEN RAISE EXCEPTION 'clarification log count %',v_count; END IF;
  PERFORM * FROM public.append_support_user_message(
    'clarification-test@example.invalid',v_ticket,'まだ動きません',
    gen_random_uuid(),FALSE,'[]'::jsonb);
  BEGIN
    PERFORM * FROM public.append_yutakasa_ticket_clarification(
      v_ticket,v_lock,gen_random_uuid(),v_version);
    RAISE EXCEPTION 'repeat clarification after customer followup accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;

  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('clarification-test@example.invalid','technical','返金したい',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','使えない',gen_random_uuid()) RETURNING id INTO v_user;
  BEGIN
    PERFORM * FROM public.append_yutakasa_ticket_clarification(
      v_ticket,v_lock,v_user,v_version);
    RAISE EXCEPTION 'financial request accepted as technical clarification';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;

  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('clarification-test@example.invalid','technical','使えない',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','使えない',gen_random_uuid()) RETURNING id INTO v_user;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','動かない',gen_random_uuid());
  BEGIN
    PERFORM * FROM public.append_yutakasa_ticket_clarification(
      v_ticket,v_lock,v_user,v_version);
    RAISE EXCEPTION 'two-message ticket accepted for first clarification';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  UPDATE public.support_tickets t SET automation_lock_token=gen_random_uuid() WHERE t.id=v_ticket;
  BEGIN
    PERFORM * FROM public.append_yutakasa_ticket_clarification(
      v_ticket,v_lock,v_user,v_version);
    RAISE EXCEPTION 'lost lock accepted for clarification';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
END;
$$;

ROLLBACK;
