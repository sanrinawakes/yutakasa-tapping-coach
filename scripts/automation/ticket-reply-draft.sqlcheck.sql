BEGIN;

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='yutakasa_ticket_reply_drafts' AND c.relrowsecurity)
    OR has_table_privilege('anon','public.yutakasa_ticket_reply_drafts','SELECT')
    OR has_table_privilege('authenticated','public.yutakasa_ticket_reply_drafts','SELECT')
    OR NOT has_table_privilege('service_role','public.yutakasa_ticket_reply_drafts','SELECT')
    OR has_function_privilege('anon','public.save_yutakasa_ticket_reply_draft(uuid,uuid,integer,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.get_yutakasa_ticket_reply_draft_context(uuid)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.append_support_admin_message_checked(uuid,text,uuid,boolean,uuid,uuid)','EXECUTE')
    OR to_regprocedure('public.append_support_admin_message_checked(uuid,text,uuid,boolean,uuid)') IS NOT NULL
    OR has_function_privilege('service_role',
      'public.append_yutakasa_automation_reply(uuid,uuid,uuid,uuid,text,boolean,integer,text,text)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'private reply draft permissions invalid';
  END IF;
END;
$$;

DO $$
DECLARE v_ticket UUID;
DECLARE v_user UUID;
DECLARE v_work UUID:=gen_random_uuid();
DECLARE v_lock UUID:=gen_random_uuid();
DECLARE v_version TIMESTAMPTZ;
DECLARE v_context JSONB;
DECLARE v_receipt RECORD;
DECLARE v_count INTEGER;
DECLARE v_request UUID:=gen_random_uuid();
BEGIN
  INSERT INTO public.subscribers(email) VALUES('ticket-reply-draft-test@example.invalid');
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,automation_lock_token,automation_locked_at,client_request_id)
    VALUES('ticket-reply-draft-test@example.invalid','technical','送信できない',
      'in_progress','investigating',v_lock,clock_timestamp(),gen_random_uuid())
    RETURNING id,updated_at INTO v_ticket,v_version;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','画面から送信できません',gen_random_uuid()) RETURNING id INTO v_user;
  PERFORM * FROM public.begin_yutakasa_ticket_repair(v_ticket,v_lock,v_user,v_version,v_work);
  PERFORM public.claim_yutakasa_ticket_repair_context(v_work,123);
  PERFORM * FROM public.link_yutakasa_ticket_repair_pr(v_work,123,903,repeat('a',40));
  IF public.get_yutakasa_ticket_reply_draft_context(v_work) IS NOT NULL THEN
    RAISE EXCEPTION 'unverified release exposed a draft context';
  END IF;
  UPDATE public.yutakasa_repair_releases SET merge_sha=repeat('b',40),
    status='verified',merge_recorded_at=clock_timestamp()-INTERVAL '30 minutes',
    first_healthy_at=clock_timestamp()-INTERVAL '21 minutes',
    last_healthy_at=clock_timestamp(),healthy_count=3,
    verified_at=clock_timestamp(),deployment_id='dpl_1234567890ABCDEF'
    WHERE pr_number=903;
  v_context:=public.get_yutakasa_ticket_reply_draft_context(v_work);
  IF v_context->>'ticket_id'<>v_ticket::TEXT OR
    v_context->>'latest_user_message_id'<>v_user::TEXT OR
    v_context->'messages'->0->>'body'<>'画面から送信できません' OR
    v_context->>'draft_exists'<>'false' THEN
    RAISE EXCEPTION 'private draft context mismatch';
  END IF;
  SELECT * INTO v_receipt FROM public.save_yutakasa_ticket_reply_draft(
    v_work,v_user,903,'現在の表示と操作した時刻を教えてください。');
  IF NOT v_receipt.created THEN RAISE EXCEPTION 'draft not created'; END IF;
  IF public.get_yutakasa_ticket_reply_draft_context(v_work)->>'draft_exists'<>'true' THEN
    RAISE EXCEPTION 'saved draft not visible for dedupe';
  END IF;
  PERFORM * FROM public.review_yutakasa_ticket_repair_release(v_work);
  SELECT * INTO v_receipt FROM public.save_yutakasa_ticket_reply_draft(
    v_work,v_user,903,'現在の表示と操作した時刻を教えてください。');
  IF v_receipt.created THEN RAISE EXCEPTION 'draft retry duplicated'; END IF;
  BEGIN
    PERFORM * FROM public.save_yutakasa_ticket_reply_draft(
      v_work,v_user,903,'別の返信案');
    RAISE EXCEPTION 'conflicting draft retry accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;
  SELECT count(*) INTO v_count FROM public.support_messages m
    WHERE m.ticket_id=v_ticket AND m.sender_type='admin';
  IF v_count<>0 THEN RAISE EXCEPTION 'review-only draft sent customer reply'; END IF;
  SELECT count(*) INTO v_count FROM public.support_work_logs w
    WHERE w.ticket_id=v_ticket AND w.event_type='repair_reply_draft';
  IF v_count<>1 THEN RAISE EXCEPTION 'draft work log duplicated'; END IF;
  SELECT * INTO v_receipt FROM public.append_support_admin_message_checked(
    v_ticket,'画面と時刻を教えてください。',v_request,FALSE,v_user,v_work);
  IF NOT v_receipt.created THEN RAISE EXCEPTION 'checked draft reply not created'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.yutakasa_ticket_reply_drafts d
    WHERE d.work_id=v_work AND d.used_message_id=v_receipt.message_id) THEN
    RAISE EXCEPTION 'draft consumption receipt missing';
  END IF;
  SELECT * INTO v_receipt FROM public.append_support_admin_message_checked(
    v_ticket,'画面と時刻を教えてください。',v_request,FALSE,v_user,v_work);
  IF v_receipt.created THEN RAISE EXCEPTION 'checked draft retry duplicated'; END IF;
  BEGIN
    PERFORM * FROM public.append_support_admin_message_checked(
      v_ticket,'画面と時刻を教えてください。',gen_random_uuid(),FALSE,v_user,v_work);
    RAISE EXCEPTION 'second draft send with new request id accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.append_support_admin_message_checked(
      v_ticket,'画面と時刻を教えてください。',gen_random_uuid(),TRUE,v_user,v_work);
    RAISE EXCEPTION 'draft reply resolved without proof';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  PERFORM * FROM public.append_support_user_message(
    'ticket-reply-draft-test@example.invalid',v_ticket,'症状が変わりました',
    gen_random_uuid(),FALSE,'[]'::jsonb);
  IF public.get_yutakasa_ticket_reply_draft_context(v_work) IS NOT NULL THEN
    RAISE EXCEPTION 'stale customer context remained available';
  END IF;
  SELECT * INTO v_receipt FROM public.append_support_admin_message_checked(
    v_ticket,'画面と時刻を教えてください。',v_request,FALSE,v_user,v_work);
  IF v_receipt.created THEN RAISE EXCEPTION 'retry after user followup duplicated'; END IF;
  DELETE FROM public.support_tickets WHERE id=v_ticket;
  SELECT count(*) INTO v_count FROM public.yutakasa_ticket_reply_drafts d WHERE d.ticket_id=v_ticket;
  IF v_count<>0 THEN RAISE EXCEPTION 'draft survived ticket deletion'; END IF;

  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,client_request_id)
    VALUES('ticket-reply-draft-test@example.invalid','technical','別の確認',
      'in_progress','manual_review',gen_random_uuid()) RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','現在の表示を確認してください',gen_random_uuid()) RETURNING id INTO v_user;
  BEGIN
    PERFORM * FROM public.append_support_admin_message_checked(
      v_ticket,'画面と時刻を教えてください。',gen_random_uuid(),FALSE,v_user,gen_random_uuid());
    RAISE EXCEPTION 'checked reply accepted without a matching draft';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
END;
$$;

ROLLBACK;
