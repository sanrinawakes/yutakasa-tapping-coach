-- Ephemeral PostgreSQL fixture for two independent connections racing to use
-- the same private reply draft. The test container is deleted after the run.
DO $$
DECLARE v_ticket CONSTANT UUID := '10000000-0000-4000-8000-000000000001';
DECLARE v_user CONSTANT UUID := '20000000-0000-4000-8000-000000000001';
DECLARE v_work CONSTANT UUID := '30000000-0000-4000-8000-000000000001';
DECLARE v_lock CONSTANT UUID := '40000000-0000-4000-8000-000000000001';
DECLARE v_version TIMESTAMPTZ;
BEGIN
  INSERT INTO public.subscribers(email) VALUES('draft-race-test@example.invalid');
  INSERT INTO public.support_tickets(id,user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES(v_ticket,'draft-race-test@example.invalid','technical','送信できない',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING updated_at INTO v_version;
  INSERT INTO public.support_messages(id,ticket_id,sender_type,body,client_request_id)
    VALUES(v_user,v_ticket,'user','送信できません',gen_random_uuid());
  PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,v_work);
  PERFORM public.claim_yutakasa_ticket_repair_context(v_work,124);
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(v_work,124,904,repeat('a',40));
  UPDATE public.yutakasa_repair_releases SET merge_sha=repeat('b',40),
    status='verified',merge_recorded_at=clock_timestamp()-INTERVAL '30 minutes',
    first_healthy_at=clock_timestamp()-INTERVAL '21 minutes',
    last_healthy_at=clock_timestamp(),healthy_count=3,
    verified_at=clock_timestamp(),deployment_id='dpl_1234567890ABCDEF'
    WHERE pr_number=904;
  PERFORM * FROM public.save_yutakasa_ticket_reply_draft(
    v_work,v_user,904,'画面と時刻を教えてください。');
  PERFORM * FROM public.review_yutakasa_ticket_repair_release(v_work);
  IF NOT EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.id=v_ticket
    AND t.automation_status='manual_review' AND t.status='in_progress') THEN
    RAISE EXCEPTION 'draft race fixture did not enter manual review';
  END IF;
END;
$$;
