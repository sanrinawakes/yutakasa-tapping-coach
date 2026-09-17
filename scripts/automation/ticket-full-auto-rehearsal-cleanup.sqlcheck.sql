-- Integration test: only the completed fixed-symptom, no-payment synthetic
-- ticket may be deleted. Every fixture rolls back with this transaction.
BEGIN;

DO $$
DECLARE
  v_run UUID:=gen_random_uuid();
  v_email TEXT;
  v_account public.subscribers%ROWTYPE;
  v_ticket public.support_tickets%ROWTYPE;
  v_claim public.support_tickets%ROWTYPE;
  v_work UUID:=gen_random_uuid();
  v_lock UUID:=gen_random_uuid();
  v_ticket_id UUID;
  v_user_message_id UUID;
  v_admin_message_id UUID;
  v_pr INTEGER:=99123;
  v_head TEXT:=repeat('a',40);
  v_merge TEXT:=repeat('b',40);
  v_deploy TEXT:='dpl_FullRehearsal1234';
  v_slot BIGINT:=floor(extract(epoch FROM clock_timestamp())/600)::BIGINT;
  v_observed TIMESTAMPTZ;
  v_deleted RECORD;
  v_rejected BOOLEAN;
BEGIN
  IF NOT has_function_privilege('service_role',
      'public.cleanup_yutakasa_full_auto_rehearsal(uuid,uuid,timestamptz,uuid,timestamptz,uuid,integer,text,text,text,uuid)',
      'EXECUTE') OR
     has_function_privilege('anon',
      'public.cleanup_yutakasa_full_auto_rehearsal(uuid,uuid,timestamptz,uuid,timestamptz,uuid,integer,text,text,text,uuid)',
      'EXECUTE') OR
     has_function_privilege('authenticated',
      'public.cleanup_yutakasa_full_auto_rehearsal(uuid,uuid,timestamptz,uuid,timestamptz,uuid,integer,text,text,text,uuid)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'full rehearsal cleanup grants invalid';
  END IF;
  v_email:='yutakasa-auto-smoke+'||v_run::TEXT||'@example.invalid';
  INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
    VALUES(v_email,'System monitor test identity (no customer, no payment)',
      'active','active',jsonb_build_object(
        'automation_test_identity','yutakasa-ai-repair-smoke-v1',
        'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT))
    RETURNING * INTO v_account;
  SELECT ticket_id INTO v_ticket_id FROM public.create_support_ticket_with_message(
    v_email,'technical','チャットの見出しが空白になる',
    'チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。',
    gen_random_uuid(),FALSE,'[]'::jsonb);
  SELECT id INTO v_user_message_id FROM public.support_messages
    WHERE ticket_id=v_ticket_id AND sender_type='user';
  SELECT * INTO v_claim FROM public.claim_support_ticket_with_log(v_ticket_id,v_lock);
  PERFORM * FROM public.begin_yutakasa_ticket_repair(
    v_ticket_id,v_lock,v_user_message_id,v_claim.updated_at,v_work);
  PERFORM public.claim_yutakasa_ticket_repair_context(v_work,123);
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(v_work,123,v_pr,v_head);
  v_observed:=to_timestamp(v_slot*600+1);
  UPDATE public.yutakasa_repair_releases
    SET status='verified',merge_sha=v_merge,
      ticket_before_after_run_id=125,
      ticket_regression_artifact_sha256=repeat('5',64),
      merge_recorded_at=v_observed-INTERVAL '35 minutes',
      deployment_id=v_deploy,first_healthy_at=v_observed-INTERVAL '20 minutes',
      last_healthy_at=v_observed,healthy_count=3,verified_at=v_observed
    WHERE pr_number=v_pr;
  FOR i IN 0..2 LOOP
    INSERT INTO public.yutakasa_repair_observations(
      pr_number,workflow_run_id,observed_at,cron_slot,deployment_id,healthy)
    VALUES(v_pr,100+i,v_observed-(2-i)*INTERVAL '10 minutes',
      v_slot-2+i,v_deploy,TRUE);
  END LOOP;
  INSERT INTO public.yutakasa_ticket_completion_proofs(
    work_id,ticket_id,latest_user_message_id,user_message_sha256,
    pr_number,head_sha,merge_sha,deployment_id,scenario_key,scenario_sha256,
    before_failure_sha256,after_success_sha256,production_success_sha256,
    before_after_run_id,production_run_id)
    VALUES(v_work,v_ticket_id,v_user_message_id,
      (SELECT encode(sha256(convert_to(body,'UTF8')),'hex')
       FROM public.support_messages WHERE id=v_user_message_id),
      v_pr,v_head,v_merge,v_deploy,'chat_title_zero_width',
      repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),125,126);
  SELECT message_id INTO v_admin_message_id
    FROM public.append_yutakasa_verified_ticket_completion(v_work,v_merge,v_deploy);
  SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
  IF v_admin_message_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.yutakasa_ticket_completion_notices
    WHERE work_id=v_work AND status='suppressed' AND provider_email_id IS NULL) THEN
    RAISE EXCEPTION 'full rehearsal fixture did not complete';
  END IF;

  v_rejected:=FALSE;
  BEGIN
    UPDATE public.subscribers SET first_payment_date=clock_timestamp()
      WHERE id=v_account.id;
    PERFORM * FROM public.cleanup_yutakasa_full_auto_rehearsal(
      v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
      v_work,v_pr,v_head,v_merge,v_deploy,v_admin_message_id);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected:=TRUE;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'paid account was deleted'; END IF;

  v_rejected:=FALSE;
  BEGIN
    UPDATE public.yutakasa_ticket_completion_notices
      SET status='needs_review' WHERE work_id=v_work;
    PERFORM * FROM public.cleanup_yutakasa_full_auto_rehearsal(
      v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
      v_work,v_pr,v_head,v_merge,v_deploy,v_admin_message_id);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected:=TRUE;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'changed notice was deleted'; END IF;

  v_rejected:=FALSE;
  BEGIN
    INSERT INTO public.support_messages(ticket_id,sender_type,sender_email,body,client_request_id)
      VALUES(v_ticket_id,'admin','operator@example.invalid','changed',gen_random_uuid());
    PERFORM * FROM public.cleanup_yutakasa_full_auto_rehearsal(
      v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
      v_work,v_pr,v_head,v_merge,v_deploy,v_admin_message_id);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected:=TRUE;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'changed messages were deleted'; END IF;

  v_rejected:=FALSE;
  BEGIN
    UPDATE public.yutakasa_repair_releases SET status='failed',verified_at=NULL,
      error_code='test_failure' WHERE pr_number=v_pr;
    PERFORM * FROM public.cleanup_yutakasa_full_auto_rehearsal(
      v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
      v_work,v_pr,v_head,v_merge,v_deploy,v_admin_message_id);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected:=TRUE;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'failed release was deleted'; END IF;

  IF NOT EXISTS(SELECT 1 FROM public.subscribers WHERE id=v_account.id) OR
     NOT EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket_id) THEN
    RAISE EXCEPTION 'rejected cleanup deleted data';
  END IF;
  SELECT * INTO v_deleted FROM public.cleanup_yutakasa_full_auto_rehearsal(
    v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
    v_work,v_pr,v_head,v_merge,v_deploy,v_admin_message_id);
  IF NOT v_deleted.ticket_deleted OR NOT v_deleted.subscriber_deleted OR
     NOT v_deleted.release_deleted OR
     EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket_id) OR
     EXISTS(SELECT 1 FROM public.subscribers WHERE id=v_account.id) OR
     EXISTS(SELECT 1 FROM public.support_messages WHERE ticket_id=v_ticket_id) OR
     EXISTS(SELECT 1 FROM public.yutakasa_ticket_repair_jobs WHERE work_id=v_work) OR
     EXISTS(SELECT 1 FROM public.yutakasa_ticket_completion_proofs WHERE work_id=v_work) OR
     EXISTS(SELECT 1 FROM public.yutakasa_ticket_completion_notices WHERE work_id=v_work) OR
     EXISTS(SELECT 1 FROM public.yutakasa_repair_releases WHERE pr_number=v_pr) OR
     EXISTS(SELECT 1 FROM public.yutakasa_repair_observations WHERE pr_number=v_pr) THEN
    RAISE EXCEPTION 'full rehearsal cleanup incomplete';
  END IF;
END;
$$;

ROLLBACK;
