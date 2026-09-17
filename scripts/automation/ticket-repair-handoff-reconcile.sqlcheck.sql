-- Synthetic local PostgreSQL fixture. No HTTP, provider calls, or customer send.
-- The surrounding transaction rolls back every inserted ticket and repair row.
BEGIN;

INSERT INTO public.subscribers(email) VALUES ('repair-handoff-fixture@example.invalid');

DO $$
DECLARE
  v_ticket UUID;
  v_user UUID;
  v_lock UUID := gen_random_uuid();
  v_work UUID := gen_random_uuid();
  v_version TIMESTAMPTZ;
  v_context JSONB;
BEGIN
  -- A customer reply between handoff and claim makes the old work stale.
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
  VALUES ('repair-handoff-fixture@example.invalid','technical','送信エラー',
    'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
  RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','送信時にエラーが出る',gen_random_uuid())
    RETURNING id INTO v_user;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(
    v_ticket,v_lock,v_user,v_version,v_work);
  PERFORM * FROM public.append_support_user_message(
    'repair-handoff-fixture@example.invalid',v_ticket,
    'エラーの表示が変わった',gen_random_uuid(),FALSE,'[]'::jsonb);
  v_context := public.claim_yutakasa_ticket_repair_context(v_work,9801);
  IF v_context IS NOT NULL OR
    NOT EXISTS (SELECT 1 FROM public.yutakasa_ticket_repair_jobs
      WHERE work_id=v_work AND status='stale') OR
    NOT EXISTS (SELECT 1 FROM public.support_tickets
      WHERE id=v_ticket AND automation_status='queued') OR
    EXISTS (SELECT 1 FROM public.list_due_yutakasa_ticket_repair_jobs()
      WHERE work_id=v_work) THEN
    RAISE EXCEPTION 'new customer message did not invalidate queued repair';
  END IF;
  IF EXISTS (SELECT 1 FROM public.support_messages
    WHERE ticket_id=v_ticket AND sender_type='admin') THEN
    RAISE EXCEPTION 'stale repair sent a customer message';
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
  v_rejected BOOLEAN := FALSE;
BEGIN
  -- Category/attachment changes after AI claim must fail the PR link CAS.
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
  VALUES ('repair-handoff-fixture@example.invalid','technical','表示エラー',
    'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
  RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','画面の表示が崩れる',gen_random_uuid())
    RETURNING id INTO v_user;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(
    v_ticket,v_lock,v_user,v_version,v_work);
  PERFORM public.claim_yutakasa_ticket_repair_context(v_work,9802);
  UPDATE public.support_tickets SET category='billing' WHERE id=v_ticket;
  BEGIN
    PERFORM * FROM public.link_yutakasa_ticket_repair_pr(
      v_work,9802,9802,repeat('a',40));
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := TRUE;
  END;
  IF NOT v_rejected OR EXISTS (SELECT 1 FROM public.yutakasa_repair_releases
    WHERE pr_number=9802) THEN
    RAISE EXCEPTION 'changed ticket category was linked to a repair PR';
  END IF;
  UPDATE public.support_tickets SET category='technical' WHERE id=v_ticket;
  INSERT INTO public.support_attachments(ticket_id,message_id,storage_path,
    filename,content_type,size_bytes)
  VALUES (v_ticket,v_user,'fixture/' || v_work::text,'fixture.png','image/png',1);
  v_rejected := FALSE;
  BEGIN
    PERFORM * FROM public.link_yutakasa_ticket_repair_pr(
      v_work,9802,9802,repeat('a',40));
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := TRUE;
  END;
  IF NOT v_rejected OR EXISTS (SELECT 1 FROM public.yutakasa_repair_releases
    WHERE pr_number=9802) THEN
    RAISE EXCEPTION 'new ticket attachment was linked to a repair PR';
  END IF;
  DELETE FROM public.support_attachments WHERE ticket_id=v_ticket;
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(
    v_work,9802,9802,repeat('a',40));
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(
    v_work,9802,9802,repeat('a',40));
  UPDATE public.support_tickets SET category='billing' WHERE id=v_ticket;
  v_rejected := FALSE;
  BEGIN
    PERFORM * FROM public.link_yutakasa_ticket_repair_pr(
      v_work,9802,9802,repeat('a',40));
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'idempotent PR link bypassed current ticket eligibility';
  END IF;
  IF EXISTS (SELECT 1 FROM public.support_messages
    WHERE ticket_id=v_ticket AND sender_type='admin') THEN
    RAISE EXCEPTION 'ineligible repair sent a customer message';
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
  v_receipt TEXT;
BEGIN
  -- A later owner decision outranks ordinary manual review on terminal failure.
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
  VALUES ('repair-handoff-fixture@example.invalid','technical','原因調査',
    'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
  RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','操作後に停止する',gen_random_uuid())
    RETURNING id INTO v_user;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(
    v_ticket,v_lock,v_user,v_version,v_work);
  PERFORM public.claim_yutakasa_ticket_repair_context(v_work,9803);
  UPDATE public.support_tickets SET decision_required=TRUE WHERE id=v_ticket;
  SELECT status INTO v_receipt FROM public.fail_yutakasa_ticket_repair_work(
    v_work,9803,'insufficient_repair_evidence');
  IF v_receipt<>'failed' OR NOT EXISTS (
    SELECT 1 FROM public.support_tickets WHERE id=v_ticket
      AND automation_status='blocked_decision') OR
    NOT EXISTS (SELECT 1 FROM public.yutakasa_ticket_repair_jobs
      WHERE work_id=v_work AND status='failed') OR
    (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=v_ticket
      AND event_type='repair_manual_review')<>1 THEN
    RAISE EXCEPTION 'owner decision was lost on repair failure';
  END IF;
  IF EXISTS (SELECT 1 FROM public.support_messages
    WHERE ticket_id=v_ticket AND sender_type='admin') THEN
    RAISE EXCEPTION 'failed repair sent a customer message';
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
  v_status TEXT;
BEGIN
  -- A verified release still needs ticket-specific proof and an owner decision.
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
  VALUES ('repair-handoff-fixture@example.invalid','technical','保存できない',
    'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
  RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','保存ボタンが動かない',gen_random_uuid())
    RETURNING id INTO v_user;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(
    v_ticket,v_lock,v_user,v_version,v_work);
  PERFORM public.claim_yutakasa_ticket_repair_context(v_work,9804);
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(
    v_work,9804,9804,repeat('b',40));
  SELECT status INTO v_status FROM public.review_yutakasa_ticket_repair_release(v_work);
  IF v_status<>'pending' OR NOT EXISTS (
    SELECT 1 FROM public.support_tickets WHERE id=v_ticket
      AND automation_status='awaiting_repair') THEN
    RAISE EXCEPTION 'unverified repair left the pending queue early';
  END IF;
  UPDATE public.yutakasa_repair_releases SET status='verified',
    merge_sha=repeat('c',40),merge_recorded_at=clock_timestamp(),
    first_healthy_at=clock_timestamp()-INTERVAL '21 minutes',
    last_healthy_at=clock_timestamp(),healthy_count=3,
    verified_at=clock_timestamp(),deployment_id='dpl_Fixture12345678'
  WHERE pr_number=9804;
  UPDATE public.support_tickets SET decision_required=TRUE WHERE id=v_ticket;
  SELECT status INTO v_status FROM public.review_yutakasa_ticket_repair_release(v_work);
  IF v_status<>'manual_review' OR NOT EXISTS (
    SELECT 1 FROM public.support_tickets WHERE id=v_ticket
      AND automation_status='blocked_decision') OR
    NOT EXISTS (SELECT 1 FROM public.yutakasa_ticket_repair_jobs
      WHERE work_id=v_work AND status='failed') OR
    (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=v_ticket
      AND event_type='repair_manual_review')<>1 THEN
    RAISE EXCEPTION 'verified release displaced owner decision';
  END IF;
  PERFORM * FROM public.review_yutakasa_ticket_repair_release(v_work);
  IF (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=v_ticket
    AND event_type='repair_manual_review')<>1 OR
    EXISTS (SELECT 1 FROM public.support_messages
      WHERE ticket_id=v_ticket AND sender_type='admin') THEN
    RAISE EXCEPTION 'verified release review duplicated work or sent reply';
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
  v_attempt INTEGER;
BEGIN
  -- The third expired claim routes to the owner even after the category changes.
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
  VALUES ('repair-handoff-fixture@example.invalid','technical','通信エラー',
    'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
  RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES (v_ticket,'user','通信が中断される',gen_random_uuid())
    RETURNING id INTO v_user;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(
    v_ticket,v_lock,v_user,v_version,v_work);
  FOR v_attempt IN 1..3 LOOP
    IF v_attempt>1 THEN
      UPDATE public.yutakasa_ticket_repair_jobs
        SET claimed_at=clock_timestamp()-INTERVAL '3 hours' WHERE work_id=v_work;
    END IF;
    v_context := public.claim_yutakasa_ticket_repair_context(v_work,9804+v_attempt);
    IF v_context IS NULL THEN RAISE EXCEPTION 'claim attempt missing'; END IF;
  END LOOP;
  UPDATE public.yutakasa_ticket_repair_jobs
    SET claimed_at=clock_timestamp()-INTERVAL '3 hours' WHERE work_id=v_work;
  UPDATE public.support_tickets SET decision_required=TRUE WHERE id=v_ticket;
  PERFORM * FROM public.recover_yutakasa_ticket_repair_jobs();
  IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE id=v_ticket
    AND automation_status='blocked_decision') OR
    NOT EXISTS (SELECT 1 FROM public.yutakasa_ticket_repair_jobs
    WHERE work_id=v_work AND status='failed') OR
    (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=v_ticket
      AND event_type='repair_manual_review'
      AND metadata->>'reason_code'='repair_claim_exhausted')<>1 OR
    EXISTS (SELECT 1 FROM public.support_messages
      WHERE ticket_id=v_ticket AND sender_type='admin') THEN
    RAISE EXCEPTION 'expired claim displaced owner decision or sent reply';
  END IF;
END;
$$;

ROLLBACK;
