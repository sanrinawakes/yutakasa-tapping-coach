BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='yutakasa_ticket_repair_jobs'
      AND c.relrowsecurity) OR
    has_table_privilege('anon','public.yutakasa_ticket_repair_jobs','SELECT') OR
    has_table_privilege('authenticated','public.yutakasa_ticket_repair_jobs','SELECT') OR
    NOT has_table_privilege('service_role','public.yutakasa_ticket_repair_jobs','SELECT') OR
    has_table_privilege('service_role','public.yutakasa_ticket_repair_jobs','INSERT') OR
    has_table_privilege('service_role','public.yutakasa_ticket_repair_jobs','UPDATE') OR
    has_table_privilege('service_role','public.yutakasa_ticket_repair_jobs','DELETE') OR
    has_table_privilege('service_role','public.yutakasa_ticket_repair_jobs','TRUNCATE') OR
    has_table_privilege('service_role','public.yutakasa_ticket_repair_jobs','REFERENCES') OR
    has_table_privilege('service_role','public.yutakasa_ticket_repair_jobs','TRIGGER') THEN
    RAISE EXCEPTION 'private ticket repair job permissions invalid';
  END IF;
END;
$$;
DO $$
DECLARE
  v_ticket UUID;
  v_user UUID;
  v_lock UUID := gen_random_uuid();
  v_work UUID := gen_random_uuid();
  v_version TIMESTAMPTZ;
  v_context JSONB;
  v_count INTEGER;
BEGIN
  INSERT INTO public.subscribers(email) VALUES ('ticket-bridge-test@example.invalid');
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('ticket-bridge-test@example.invalid','technical','送信できない',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','画面から送信できません',gen_random_uuid()) RETURNING id INTO v_user;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,v_work);
  IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE id=v_ticket
    AND automation_status='awaiting_repair' AND automation_lock_token IS NULL) THEN
    RAISE EXCEPTION 'atomic handoff missing';
  END IF;
  SELECT count(*) INTO v_count FROM public.yutakasa_ticket_repair_jobs WHERE work_id=v_work;
  IF v_count<>1 THEN RAISE EXCEPTION 'work row missing'; END IF;
  BEGIN
    PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,gen_random_uuid());
    RAISE EXCEPTION 'duplicate handoff succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  v_context:=public.claim_yutakasa_ticket_repair_context(v_work,123);
  IF v_context->>'ticket_id'<>v_ticket::text OR
    v_context->'messages'->0->>'body'<>'画面から送信できません' OR
    v_context ? 'user_email' THEN
    RAISE EXCEPTION 'private context mismatch';
  END IF;
  BEGIN
    PERFORM public.claim_yutakasa_ticket_repair_context(v_work,124);
    RAISE EXCEPTION 'duplicate claim succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(v_work,123,901,repeat('a',40));
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(v_work,123,901,repeat('a',40));
  SELECT count(*) INTO v_count FROM public.yutakasa_repair_ticket_links
    WHERE pr_number=901 AND ticket_id=v_ticket AND latest_user_message_id=v_user;
  IF v_count<>1 THEN RAISE EXCEPTION 'idempotent link failed'; END IF;
  BEGIN
    PERFORM * FROM public.link_yutakasa_ticket_repair_pr(v_work,123,902,repeat('b',40));
    RAISE EXCEPTION 'conflicting PR link succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF to_regprocedure('public.append_verified_yutakasa_ticket_reply(uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'generic smoke must not enable customer reply';
  END IF;
  UPDATE public.yutakasa_repair_releases SET
    merge_sha=repeat('b',40),status='verified',
    merge_recorded_at=clock_timestamp()-INTERVAL '30 minutes',
    first_healthy_at=clock_timestamp()-INTERVAL '21 minutes',
    last_healthy_at=clock_timestamp(),healthy_count=3,
    verified_at=clock_timestamp(),deployment_id='dpl_1234567890ABCDEF'
    WHERE pr_number=901;
  IF NOT EXISTS (SELECT 1 FROM public.verify_yutakasa_ticket_repair_pr(901,repeat('a',40))
    WHERE work_id=v_work) THEN RAISE EXCEPTION 'private PR link not verified'; END IF;
  PERFORM * FROM public.review_yutakasa_ticket_repair_release(v_work);
  PERFORM * FROM public.review_yutakasa_ticket_repair_release(v_work);
  SELECT count(*) INTO v_count FROM public.support_messages m
    WHERE m.ticket_id=v_ticket AND m.sender_type='admin' AND m.client_request_id=v_work;
  IF v_count<>0 THEN RAISE EXCEPTION 'generic smoke sent customer reply'; END IF;
  SELECT count(*) INTO v_count FROM public.support_work_logs l
    WHERE l.ticket_id=v_ticket AND l.event_type='repair_manual_review';
  IF v_count<>1 THEN RAISE EXCEPTION 'release review dedupe failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE id=v_ticket
    AND automation_status='manual_review') THEN
    RAISE EXCEPTION 'verified release did not request ticket-specific review';
  END IF;
  PERFORM * FROM public.append_support_user_message(
    'ticket-bridge-test@example.invalid',v_ticket,'症状が変わりました',
    gen_random_uuid(),FALSE,'[]'::jsonb);
  IF EXISTS (SELECT 1 FROM public.support_tickets WHERE id=v_ticket
    AND automation_status='awaiting_repair') THEN
    RAISE EXCEPTION 'new customer message did not invalidate old work';
  END IF;
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('ticket-bridge-test@example.invalid','technical','再現できない',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','原因がわからない',gen_random_uuid()) RETURNING id INTO v_user;
  v_work:=gen_random_uuid();
  PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,v_work);
  v_context:=public.claim_yutakasa_ticket_repair_context(v_work,124);
  IF v_context IS NULL THEN RAISE EXCEPTION 'second work claim failed'; END IF;
  PERFORM * FROM public.fail_yutakasa_ticket_repair_work(v_work,124,'insufficient_repair_evidence');
  IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE id=v_ticket
    AND automation_status='manual_review') THEN
    RAISE EXCEPTION 'manual review state missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.list_due_yutakasa_ticket_repair_jobs()
    WHERE work_id=v_work) THEN RAISE EXCEPTION 'failed work was redispatched'; END IF;
  IF has_function_privilege('anon',
    'public.review_yutakasa_ticket_repair_release(uuid)','EXECUTE') OR
    NOT has_function_privilege('service_role',
    'public.review_yutakasa_ticket_repair_release(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'review RPC grants invalid';
  END IF;
END;
$$;
DO $$
DECLARE v_ticket UUID; v_user UUID; v_work UUID; v_lock UUID;
DECLARE v_version TIMESTAMPTZ; v_context JSONB; v_count INTEGER;
BEGIN
  -- A 501-message history must terminate instead of dispatching forever.
  v_lock:=gen_random_uuid(); v_work:=gen_random_uuid();
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('ticket-bridge-test@example.invalid','technical','長い履歴',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    SELECT v_ticket,'admin','履歴',gen_random_uuid() FROM generate_series(1,500);
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','送信できません',gen_random_uuid()) RETURNING id INTO v_user;
  SELECT updated_at INTO v_version FROM public.support_tickets WHERE id=v_ticket;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,v_work);
  v_context:=public.claim_yutakasa_ticket_repair_context(v_work,500);
  IF v_context IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.support_tickets
    WHERE id=v_ticket AND automation_status='manual_review') OR
    NOT EXISTS (SELECT 1 FROM public.yutakasa_ticket_repair_jobs
    WHERE work_id=v_work AND status='failed') THEN
    RAISE EXCEPTION 'oversized context did not enter manual review';
  END IF;

  -- Final timed-out attempt must also leave the queue with an audit event.
  v_lock:=gen_random_uuid(); v_work:=gen_random_uuid();
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('ticket-bridge-test@example.invalid','technical','再試行上限',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','送信できません',gen_random_uuid()) RETURNING id INTO v_user;
  SELECT updated_at INTO v_version FROM public.support_tickets WHERE id=v_ticket;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,v_work);
  FOR v_count IN 1..3 LOOP
    IF v_count>1 THEN
      UPDATE public.yutakasa_ticket_repair_jobs SET
        claimed_at=clock_timestamp()-INTERVAL '3 hours' WHERE work_id=v_work;
    END IF;
    v_context:=public.claim_yutakasa_ticket_repair_context(v_work,500+v_count);
    IF v_context IS NULL THEN RAISE EXCEPTION 'retry claim missing'; END IF;
  END LOOP;
  UPDATE public.yutakasa_ticket_repair_jobs SET
    claimed_at=clock_timestamp()-INTERVAL '3 hours' WHERE work_id=v_work;
  PERFORM * FROM public.recover_yutakasa_ticket_repair_jobs();
  IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE id=v_ticket
    AND automation_status='manual_review') OR
    NOT EXISTS (SELECT 1 FROM public.yutakasa_ticket_repair_jobs
    WHERE work_id=v_work AND status='failed') OR
    NOT EXISTS (SELECT 1 FROM public.support_work_logs
    WHERE ticket_id=v_ticket AND event_type='repair_manual_review'
      AND metadata->>'reason_code'='repair_claim_exhausted') OR
    EXISTS (SELECT 1 FROM public.list_due_yutakasa_ticket_repair_jobs()
      WHERE work_id=v_work) THEN
    RAISE EXCEPTION 'exhausted claim remained stuck';
  END IF;

  -- A decision added after handoff cannot leave an orphan awaiting_repair.
  v_lock:=gen_random_uuid(); v_work:=gen_random_uuid();
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('ticket-bridge-test@example.invalid','technical','運営判断が必要',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','送信できません',gen_random_uuid()) RETURNING id INTO v_user;
  SELECT updated_at INTO v_version FROM public.support_tickets WHERE id=v_ticket;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,v_work);
  UPDATE public.support_tickets SET decision_required=TRUE WHERE id=v_ticket;
  v_context:=public.claim_yutakasa_ticket_repair_context(v_work,777);
  IF v_context IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.support_tickets
    WHERE id=v_ticket AND automation_status='blocked_decision') OR
    NOT EXISTS (SELECT 1 FROM public.support_work_logs
      WHERE ticket_id=v_ticket AND event_type='repair_context_stale') THEN
    RAISE EXCEPTION 'stale decision did not enter owner review';
  END IF;
END;
$$;
ROLLBACK;
