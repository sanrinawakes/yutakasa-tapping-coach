BEGIN;

DO $$
DECLARE
  v_old REGPROCEDURE;
  v_wrong_delete_count INTEGER;
BEGIN
  SELECT to_regprocedure('public.append_yutakasa_automation_reply(uuid,uuid,uuid,uuid,text,boolean,integer)')
    INTO v_old;
  IF v_old IS NOT NULL THEN RAISE EXCEPTION 'unsafe old reply overload remains'; END IF;
  SELECT count(*) INTO v_wrong_delete_count FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.yutakasa_repair_ticket_links'::regclass
      AND c.contype = 'f' AND c.confdeltype <> 'c';
  IF v_wrong_delete_count <> 0 THEN RAISE EXCEPTION 'customer link FK is not cascading'; END IF;
END;
$$;

DO $$
DECLARE
  v_ticket UUID;
  v_user UUID;
  v_request UUID := gen_random_uuid();
  v_lock UUID := gen_random_uuid();
  v_main TEXT := repeat('b',40);
  v_deployment TEXT := 'dpl_1234567890ABCDEF';
  v_first RECORD;
  v_retry RECORD;
  v_count INTEGER;
BEGIN
  INSERT INTO public.subscribers(email) VALUES ('atomic-reply-test@example.invalid');
  INSERT INTO public.support_tickets(
    user_email, category, subject, status, automation_status,
    automation_lock_token, automation_locked_at, client_request_id
  ) VALUES (
    'atomic-reply-test@example.invalid', 'technical', '送信できない',
    'in_progress', 'investigating', v_lock, clock_timestamp(), gen_random_uuid()
  ) RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','送信できません',gen_random_uuid()) RETURNING id INTO v_user;
  INSERT INTO public.yutakasa_repair_releases(
    pr_number, head_sha, merge_sha, status, verified_at, deployment_id
  ) VALUES (701, repeat('a',40), v_main, 'verified', clock_timestamp(), v_deployment);

  BEGIN
    PERFORM * FROM public.append_yutakasa_automation_reply(
      v_ticket,v_lock,v_user,gen_random_uuid(),'確認しました',TRUE,701,v_main,v_deployment);
    RAISE EXCEPTION 'unlinked repair was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  INSERT INTO public.yutakasa_repair_ticket_links(
    pr_number,ticket_id,latest_user_message_id
  ) VALUES (701,v_ticket,v_user);

  SELECT * INTO v_first FROM public.append_yutakasa_automation_reply(
    v_ticket,v_lock,v_user,v_request,'送信と保存を確認しました。',TRUE,701,v_main,v_deployment);
  IF NOT v_first.created OR v_first.message_id IS NULL THEN
    RAISE EXCEPTION 'first reply was not created';
  END IF;
  SELECT * INTO v_retry FROM public.append_yutakasa_automation_reply(
    v_ticket,v_lock,v_user,v_request,'送信と保存を確認しました。',TRUE,701,v_main,v_deployment);
  IF v_retry.created OR v_retry.message_id <> v_first.message_id THEN
    RAISE EXCEPTION 'retry was not idempotent';
  END IF;
  SELECT count(*) INTO v_count FROM public.support_messages
    WHERE ticket_id = v_ticket AND sender_type = 'admin';
  IF v_count <> 1 THEN RAISE EXCEPTION 'reply count %', v_count; END IF;
  SELECT count(*) INTO v_count FROM public.support_work_logs
    WHERE ticket_id = v_ticket AND event_type = 'automation_resolved';
  IF v_count <> 1 THEN RAISE EXCEPTION 'work log count %', v_count; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.support_tickets
    WHERE id = v_ticket AND status = 'resolved' AND automation_status = 'completed'
      AND automation_lock_token IS NULL) THEN
    RAISE EXCEPTION 'terminal ticket state missing';
  END IF;
  BEGIN
    PERFORM * FROM public.append_yutakasa_automation_reply(
      v_ticket,v_lock,v_user,v_request,'changed reply',TRUE,701,v_main,v_deployment);
    RAISE EXCEPTION 'conflicting retry was accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.append_yutakasa_automation_reply(
      v_ticket,v_lock,v_user,v_request,'送信と保存を確認しました。',TRUE,702,v_main,v_deployment);
    RAISE EXCEPTION 'different release was accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;

  INSERT INTO public.support_tickets(
    user_email, category, subject, status, automation_status,
    automation_lock_token, automation_locked_at, client_request_id
  ) VALUES (
    'atomic-reply-test@example.invalid', 'technical', '再読込できない',
    'in_progress', 'investigating', v_lock, clock_timestamp(), gen_random_uuid()
  ) RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','再読込できません',gen_random_uuid()) RETURNING id INTO v_user;
  INSERT INTO public.yutakasa_repair_ticket_links(
    pr_number,ticket_id,latest_user_message_id
  ) VALUES (701,v_ticket,v_user);
  INSERT INTO public.yutakasa_repair_releases(
    pr_number,head_sha,merge_sha,status,verified_at,deployment_id
  ) VALUES (702,repeat('c',40),repeat('d',40),'verified',clock_timestamp(),'dpl_ABCDEFGHIJ123456');
  INSERT INTO public.yutakasa_repair_ticket_links(
    pr_number,ticket_id,latest_user_message_id
  ) VALUES (702,v_ticket,v_user);
  BEGIN
    PERFORM * FROM public.append_yutakasa_automation_reply(
      v_ticket,v_lock,v_user,gen_random_uuid(),'直りました',TRUE,701,
      repeat('e',40),v_deployment);
    RAISE EXCEPTION 'outdated main SHA was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.append_yutakasa_automation_reply(
      v_ticket,v_lock,v_user,gen_random_uuid(),'直りました',TRUE,701,
      v_main,'dpl_CHANGED12345678');
    RAISE EXCEPTION 'outdated production deployment was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','まだ直っていません',gen_random_uuid());
  BEGIN
    PERFORM * FROM public.append_yutakasa_automation_reply(
      v_ticket,v_lock,v_user,gen_random_uuid(),'直りました',TRUE,701,v_main,v_deployment);
    RAISE EXCEPTION 'stale user message was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  UPDATE public.support_tickets SET automation_lock_token = gen_random_uuid()
    WHERE id = v_ticket;
  BEGIN
    PERFORM * FROM public.append_yutakasa_automation_reply(
      v_ticket,v_lock,v_user,gen_random_uuid(),'直りました',TRUE,701,v_main,v_deployment);
    RAISE EXCEPTION 'lost lock was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  DELETE FROM public.support_tickets WHERE id = v_ticket;
  SELECT count(*) INTO v_count FROM public.yutakasa_repair_ticket_links
    WHERE ticket_id = v_ticket;
  IF v_count <> 0 THEN RAISE EXCEPTION 'customer link survived deletion'; END IF;
END;
$$;

ROLLBACK;
