-- Local-only transaction: exercise the cleanup RPC, then roll back fixtures.
BEGIN;

DO $$
DECLARE v_run UUID:='11111111-1111-4111-8111-111111111111';
DECLARE v_request UUID:='22222222-2222-4222-8222-222222222222';
DECLARE v_email TEXT:='yutakasa-auto-smoke+11111111-1111-4111-8111-111111111111@example.invalid';
DECLARE v_ticket UUID;
DECLARE v_user UUID;
DECLARE v_version TIMESTAMPTZ;
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_result RECORD;
BEGIN
  IF NOT has_function_privilege('service_role',
      'public.cleanup_yutakasa_ticket_clarification_smoke(uuid,uuid,uuid)','EXECUTE') OR
    has_function_privilege('anon',
      'public.cleanup_yutakasa_ticket_clarification_smoke(uuid,uuid,uuid)','EXECUTE') OR
    has_function_privilege('authenticated',
      'public.cleanup_yutakasa_ticket_clarification_smoke(uuid,uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'cleanup privilege invalid';
  END IF;
  SELECT * INTO v_result FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
  IF v_result.cleaned THEN RAISE EXCEPTION 'absent fixture reported deleted'; END IF;
  INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
  VALUES(v_email,'System monitor clarification test (no customer, no payment)',
    'active','active',jsonb_build_object(
    'automation_test_identity','yutakasa-clarification-smoke-v1',
    'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT));
  SELECT * INTO v_result FROM public.create_support_ticket_with_message(
    v_email,'technical','使えない','使えない',v_request,FALSE,'[]'::jsonb);
  v_ticket:=v_result.ticket_id;
  v_user:=v_result.message_id;
  SELECT t.updated_at INTO v_version FROM public.claim_support_ticket_with_log(v_ticket,v_lock) t;
  IF v_version IS NULL THEN RAISE EXCEPTION 'claim failed'; END IF;
  SELECT * INTO v_result FROM public.append_yutakasa_ticket_clarification(
    v_ticket,v_lock,v_user,v_version);
  IF NOT v_result.created THEN RAISE EXCEPTION 'clarification failed'; END IF;
  UPDATE public.support_work_logs SET metadata=jsonb_build_object('extra','operator')
    WHERE ticket_id=v_ticket AND event_type='automation_claimed';
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
    RAISE EXCEPTION 'changed claim metadata was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) THEN
    RAISE EXCEPTION 'changed claim metadata removed ticket';
  END IF;
  UPDATE public.support_work_logs SET metadata='{}'::jsonb
    WHERE ticket_id=v_ticket AND event_type='automation_claimed';
  UPDATE public.support_work_logs SET metadata=metadata||jsonb_build_object('extra','operator')
    WHERE ticket_id=v_ticket AND event_type='automation_clarification_sent';
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
    RAISE EXCEPTION 'changed clarification metadata was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) THEN
    RAISE EXCEPTION 'changed clarification metadata removed ticket';
  END IF;
  UPDATE public.support_work_logs SET metadata=metadata-'extra'
    WHERE ticket_id=v_ticket AND event_type='automation_clarification_sent';
  SELECT * INTO v_result FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
  IF NOT v_result.cleaned OR v_result.ticket_id<>v_ticket OR
    EXISTS(SELECT 1 FROM public.subscribers s WHERE s.email=v_email) OR
    EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.id=v_ticket) OR
    EXISTS(SELECT 1 FROM public.support_messages m WHERE m.ticket_id=v_ticket) OR
    EXISTS(SELECT 1 FROM public.support_work_logs w WHERE w.ticket_id=v_ticket) OR
    EXISTS(SELECT 1 FROM public.yutakasa_ticket_clarifications c WHERE c.ticket_id=v_ticket) THEN
    RAISE EXCEPTION 'completed fixture not fully removed';
  END IF;
  SELECT * INTO v_result FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
  IF v_result.cleaned THEN RAISE EXCEPTION 'cleanup retry removed another row'; END IF;
END;
$$;

DO $$
DECLARE v_run UUID:='33333333-3333-4333-8333-333333333333';
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_request UUID:='44444444-4444-4444-8444-444444444444';
DECLARE v_email TEXT:='yutakasa-auto-smoke+33333333-3333-4333-8333-333333333333@example.invalid';
DECLARE v_ticket UUID;
DECLARE v_result RECORD;
BEGIN
  INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
  VALUES(v_email,'System monitor clarification test (no customer, no payment)',
    'active','active',jsonb_build_object(
    'automation_test_identity','yutakasa-clarification-smoke-v1',
    'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT));
  SELECT * INTO v_result FROM public.create_support_ticket_with_message(
    v_email,'technical','使えない','使えない',v_request,FALSE,'[]'::jsonb);
  v_ticket:=v_result.ticket_id;
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(
      v_run,gen_random_uuid(),v_lock);
    RAISE EXCEPTION 'wrong request id deleted ticket';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) THEN
    RAISE EXCEPTION 'wrong request id changed ticket';
  END IF;
  UPDATE public.subscribers SET myasp_data=myasp_data||jsonb_build_object('billing_event','unexpected')
    WHERE email=v_email;
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
    RAISE EXCEPTION 'extra account metadata was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) OR
    NOT EXISTS(SELECT 1 FROM public.subscribers WHERE email=v_email) THEN
    RAISE EXCEPTION 'metadata rejection deleted rows';
  END IF;
  UPDATE public.subscribers SET myasp_data=myasp_data-'billing_event'
    WHERE email=v_email;
  UPDATE public.subscribers SET subscription_started_at=clock_timestamp()
    WHERE email=v_email;
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
    RAISE EXCEPTION 'subscription start was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) OR
    NOT EXISTS(SELECT 1 FROM public.subscribers WHERE email=v_email) THEN
    RAISE EXCEPTION 'subscription start rejection deleted rows';
  END IF;
  UPDATE public.subscribers SET subscription_started_at=NULL,
    subscription_last_event_at=clock_timestamp() WHERE email=v_email;
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
    RAISE EXCEPTION 'subscription event was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) OR
    NOT EXISTS(SELECT 1 FROM public.subscribers WHERE email=v_email) THEN
    RAISE EXCEPTION 'subscription event rejection deleted rows';
  END IF;
  UPDATE public.subscribers SET subscription_last_event_at=NULL WHERE email=v_email;
  SELECT * INTO v_result FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
  IF NOT v_result.cleaned OR EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) THEN
    RAISE EXCEPTION 'queued fixture not removed';
  END IF;
END;
$$;

DO $$
DECLARE v_run UUID:='77777777-7777-4777-8777-777777777777';
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_request UUID:='88888888-8888-4888-8888-888888888888';
DECLARE v_email TEXT:='yutakasa-auto-smoke+77777777-7777-4777-8777-777777777777@example.invalid';
DECLARE v_ticket UUID;
DECLARE v_result RECORD;
BEGIN
  INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
  VALUES(v_email,'System monitor clarification test (no customer, no payment)',
    'active','active',jsonb_build_object(
    'automation_test_identity','yutakasa-clarification-smoke-v1',
    'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT));
  SELECT * INTO v_result FROM public.create_support_ticket_with_message(
    v_email,'technical','使えない','使えない',v_request,FALSE,'[]'::jsonb);
  v_ticket:=v_result.ticket_id;
  PERFORM * FROM public.claim_support_ticket_with_log(v_ticket,v_lock);
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(
      v_run,v_request,gen_random_uuid());
    RAISE EXCEPTION 'foreign claim lock was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) OR
    NOT EXISTS(SELECT 1 FROM public.subscribers WHERE email=v_email) THEN
    RAISE EXCEPTION 'foreign claim lock rejection removed rows';
  END IF;
  SELECT * INTO v_result FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
  IF NOT v_result.cleaned OR EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) THEN
    RAISE EXCEPTION 'claimed fixture not removed';
  END IF;
END;
$$;

DO $$
DECLARE v_run UUID:='55555555-5555-4555-8555-555555555555';
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_request UUID:='66666666-6666-4666-8666-666666666666';
DECLARE v_email TEXT:='yutakasa-auto-smoke+55555555-5555-4555-8555-555555555555@example.invalid';
DECLARE v_ticket UUID;
DECLARE v_result RECORD;
BEGIN
  INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
  VALUES(v_email,'System monitor clarification test (no customer, no payment)',
    'active','active',jsonb_build_object(
    'automation_test_identity','yutakasa-clarification-smoke-v1',
    'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT));
  SELECT * INTO v_result FROM public.create_support_ticket_with_message(
    v_email,'technical','使えない','使えない',v_request,FALSE,'[]'::jsonb);
  v_ticket:=v_result.ticket_id;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'admin','unexpected',gen_random_uuid());
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
    RAISE EXCEPTION 'tampered fixture was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket) OR
    NOT EXISTS(SELECT 1 FROM public.subscribers WHERE email=v_email) THEN
    RAISE EXCEPTION 'tamper rejection removed fixture';
  END IF;
END;
$$;

DO $$
DECLARE v_run UUID:='99999999-9999-4999-8999-999999999999';
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_request UUID:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DECLARE v_email TEXT:='yutakasa-auto-smoke+99999999-9999-4999-8999-999999999999@example.invalid';
DECLARE v_result RECORD;
BEGIN
  INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
  VALUES(v_email,'System monitor clarification test (no customer, no payment)',
    'active','active',jsonb_build_object(
    'automation_test_identity','other-smoke-run',
    'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT));
  BEGIN
    PERFORM * FROM public.cleanup_yutakasa_ticket_clarification_smoke(v_run,v_request,v_lock);
    RAISE EXCEPTION 'foreign marker was deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.subscribers WHERE email=v_email) THEN
    RAISE EXCEPTION 'foreign marker did not survive';
  END IF;
END;
$$;

ROLLBACK;
