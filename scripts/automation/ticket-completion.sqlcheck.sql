-- Local PostgreSQL fixture only. All synthetic rows roll back.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=
      'public.yutakasa_ticket_completion_proofs'::regclass AND c.relrowsecurity)
    OR has_table_privilege('anon','public.yutakasa_ticket_completion_proofs','SELECT')
    OR has_table_privilege('authenticated','public.yutakasa_ticket_completion_proofs','SELECT')
    OR has_table_privilege('service_role','public.yutakasa_ticket_completion_proofs','INSERT')
    OR has_table_privilege('service_role','public.yutakasa_ticket_completion_proofs','UPDATE')
    OR NOT has_table_privilege('service_role','public.yutakasa_ticket_completion_proofs','SELECT')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=
      'public.yutakasa_ticket_completion_notices'::regclass AND c.relrowsecurity)
    OR has_table_privilege('anon','public.yutakasa_ticket_completion_notices','SELECT')
    OR has_table_privilege('authenticated','public.yutakasa_ticket_completion_notices','SELECT')
    OR has_table_privilege('service_role','public.yutakasa_ticket_completion_notices','INSERT')
    OR NOT has_table_privilege('service_role','public.yutakasa_ticket_completion_notices','SELECT')
    OR has_function_privilege('anon',
      'public.claim_yutakasa_completion_notice(uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.claim_yutakasa_completion_notice(uuid,uuid)','EXECUTE')
    OR has_function_privilege('anon',
      'public.append_yutakasa_verified_ticket_completion(uuid,text,text)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.record_yutakasa_ticket_completion_proof(uuid,uuid,integer,text,text,text,text,text,text,text,text,bigint,bigint)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.append_yutakasa_verified_ticket_completion(uuid,text,text)','EXECUTE')
    OR has_function_privilege('service_role',
      'public.append_yutakasa_automation_reply(uuid,uuid,uuid,uuid,text,boolean,integer,text,text)','EXECUTE')
  THEN RAISE EXCEPTION 'completion permissions invalid'; END IF;
END;
$$;

DO $$
DECLARE v_ticket UUID;
DECLARE v_user UUID;
DECLARE v_work UUID:=gen_random_uuid();
DECLARE v_head TEXT:=repeat('a',40);
DECLARE v_main TEXT:=repeat('b',40);
DECLARE v_deployment TEXT:='dpl_1234567890ABCDEF';
DECLARE v_slot BIGINT:=floor(extract(epoch FROM clock_timestamp())/600)::BIGINT;
DECLARE v_first TIMESTAMPTZ:=to_timestamp((v_slot-2)*600);
DECLARE v_second TIMESTAMPTZ:=to_timestamp((v_slot-1)*600);
DECLARE v_last TIMESTAMPTZ:=to_timestamp(v_slot*600);
DECLARE v_receipt RECORD;
DECLARE v_count INTEGER;
DECLARE v_claim UUID:=gen_random_uuid();
DECLARE v_notice JSONB;
DECLARE v_provider UUID:=gen_random_uuid();
BEGIN
  INSERT INTO public.subscribers(email) VALUES('completion-test@example.invalid');
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,client_request_id)
    VALUES('completion-test@example.invalid','technical','チャットの見出しが空白になる',
      'in_progress','awaiting_repair',gen_random_uuid()) RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。',gen_random_uuid())
    RETURNING id INTO v_user;
  INSERT INTO public.yutakasa_ticket_repair_jobs(work_id,ticket_id,latest_user_message_id,
    status,pr_number,head_sha)
    VALUES(v_work,v_ticket,v_user,'pr_open',9701,v_head);
  INSERT INTO public.yutakasa_repair_releases(pr_number,head_sha,merge_sha,status,
    merge_recorded_at,ticket_before_after_run_id,ticket_regression_artifact_sha256)
    VALUES(9701,v_head,v_main,'observing',clock_timestamp()-INTERVAL '30 minutes',
      101,repeat('1',64));
  INSERT INTO public.yutakasa_repair_ticket_links(pr_number,ticket_id,latest_user_message_id)
    VALUES(9701,v_ticket,v_user);
  BEGIN
    UPDATE public.yutakasa_repair_releases
      SET ticket_before_after_run_id=999 WHERE pr_number=9701;
    RAISE EXCEPTION 'trusted regression run was mutable';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  -- A release link and generic smoke are not ticket-specific proof.
  BEGIN
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(v_work,v_main,v_deployment);
    RAISE EXCEPTION 'missing proof sent a customer message';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_yutakasa_ticket_completion_proof(
      v_work,v_user,9701,v_head,v_main,v_deployment,'chat_send_reload_persistence',
      repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),101,102);
    RAISE EXCEPTION 'generic symptom proof accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  SELECT * INTO v_receipt FROM public.record_yutakasa_ticket_completion_proof(
    v_work,v_user,9701,v_head,v_main,v_deployment,'chat_title_zero_width',
    repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),101,102);
  IF v_receipt.created IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'proof not recorded'; END IF;
  IF (public.get_yutakasa_ticket_completion_context(v_work)->>'notice_ready')<>'true' THEN
    RAISE EXCEPTION 'completion context lacks enabled notification trigger';
  END IF;
  SELECT * INTO v_receipt FROM public.record_yutakasa_ticket_completion_proof(
    v_work,v_user,9701,v_head,v_main,v_deployment,'chat_title_zero_width',
    repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),101,102);
  IF v_receipt.created IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'proof retry not idempotent'; END IF;
  BEGIN
    PERFORM * FROM public.record_yutakasa_ticket_completion_proof(
      v_work,v_user,9701,v_head,v_main,v_deployment,'chat_title_zero_width',
      repeat('c',64),repeat('d',64),repeat('e',64),repeat('0',64),101,102);
    RAISE EXCEPTION 'conflicting proof accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(v_work,v_main,v_deployment);
    RAISE EXCEPTION 'unverified release sent a customer message';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  INSERT INTO public.yutakasa_repair_observations(
    pr_number,workflow_run_id,observed_at,cron_slot,deployment_id,healthy)
    VALUES(9701,201,v_first,v_slot-2,v_deployment,TRUE),
      (9701,202,v_second,v_slot-1,v_deployment,TRUE),
      (9701,203,v_last,v_slot,v_deployment,TRUE);
  UPDATE public.yutakasa_repair_releases SET status='verified',
    first_healthy_at=v_first,last_healthy_at=v_last,healthy_count=3,
    deployment_id=v_deployment,verified_at=clock_timestamp() WHERE pr_number=9701;
  BEGIN
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(v_work,repeat('9',40),v_deployment);
    RAISE EXCEPTION 'wrong production SHA accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(v_work,v_main,'dpl_WRONG1234567890');
    RAISE EXCEPTION 'wrong production deployment accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  -- Count and release fields are insufficient if the third persisted observation
  -- is unhealthy, missing, or from a different deployment.
  UPDATE public.yutakasa_repair_observations SET healthy=FALSE
    WHERE pr_number=9701 AND workflow_run_id=202;
  BEGIN
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(v_work,v_main,v_deployment);
    RAISE EXCEPTION 'broken observation chain accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  UPDATE public.yutakasa_repair_observations SET healthy=TRUE
    WHERE pr_number=9701 AND workflow_run_id=202;
  BEGIN
    INSERT INTO public.subscribers(email) VALUES('invalid-recipient');
    UPDATE public.support_tickets SET user_email='invalid-recipient' WHERE id=v_ticket;
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(
      v_work,v_main,v_deployment);
    RAISE EXCEPTION 'invalid recipient received completion'
      USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  BEGIN
    UPDATE public.support_tickets SET subject='会話'||chr(9)||'が消える'
      WHERE id=v_ticket;
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(
      v_work,v_main,v_deployment);
    RAISE EXCEPTION 'control-character subject received completion'
      USING ERRCODE='ZX002';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  BEGIN
    UPDATE public.support_tickets SET subject=repeat('a',121) WHERE id=v_ticket;
    RAISE EXCEPTION 'oversized subject entered support ticket'
      USING ERRCODE='ZX003';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  SELECT * INTO v_receipt FROM public.append_yutakasa_verified_ticket_completion(
    v_work,v_main,v_deployment);
  IF v_receipt.created IS DISTINCT FROM TRUE OR v_receipt.message_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.id=v_ticket
      AND t.status='resolved' AND t.automation_status='completed')
    OR NOT EXISTS(SELECT 1 FROM public.yutakasa_ticket_repair_jobs j
      WHERE j.work_id=v_work AND j.status='replied') THEN
    RAISE EXCEPTION 'atomic completion missing';
  END IF;
  SELECT * INTO v_receipt FROM public.append_yutakasa_verified_ticket_completion(
    v_work,v_main,v_deployment);
  IF v_receipt.created IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'retry duplicated send'; END IF;
  SELECT count(*) INTO v_count FROM public.support_messages m
    WHERE m.ticket_id=v_ticket AND m.sender_type='admin' AND m.client_request_id=v_work;
  IF v_count<>1 THEN RAISE EXCEPTION 'completion message count %',v_count; END IF;
  SELECT count(*) INTO v_count FROM public.support_work_logs l
    WHERE l.ticket_id=v_ticket AND l.event_type='repair_ticket_specific_completed';
  IF v_count<>1 THEN RAISE EXCEPTION 'completion log count %',v_count; END IF;
  SELECT count(*) INTO v_count FROM public.yutakasa_ticket_completion_notices n
    WHERE n.work_id=v_work AND n.ticket_id=v_ticket AND n.message_id=v_receipt.message_id
      AND n.status='pending';
  IF v_count<>1 THEN RAISE EXCEPTION 'atomic notification reservation missing'; END IF;
  -- A recipient change between the reply and email claim must stop delivery.
  -- Roll back this isolated check so the same fixture can test normal delivery.
  BEGIN
    INSERT INTO public.subscribers(email) VALUES('completion-drift@example.invalid');
    UPDATE public.support_tickets SET user_email='completion-drift@example.invalid'
      WHERE id=v_ticket;
    v_notice:=public.claim_yutakasa_completion_notice(v_work,gen_random_uuid());
    IF v_notice->>'status'<>'needs_review' OR NOT EXISTS(
      SELECT 1 FROM public.yutakasa_ticket_completion_notices n
      WHERE n.work_id=v_work AND n.status='needs_review'
        AND n.last_error_code='recipient_changed') THEN
      RAISE EXCEPTION 'recipient drift did not stop notification';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.list_due_yutakasa_completion_notices() d
      WHERE d.work_id=v_work) THEN
      RAISE EXCEPTION 'notification review stopped alerting';
    END IF;
    RAISE EXCEPTION 'recipient drift rollback' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
  v_notice:=public.claim_yutakasa_completion_notice(v_work,v_claim);
  IF v_notice->>'status'<>'sending' OR v_notice->>'claim_token'<>v_claim::TEXT
    OR v_notice->>'idempotency_key'<>'yutakasa-ticket-completion/'||v_work::TEXT THEN
    RAISE EXCEPTION 'notification claim invalid';
  END IF;
  IF (public.claim_yutakasa_completion_notice(v_work,gen_random_uuid())->>'status')<>'busy' THEN
    RAISE EXCEPTION 'parallel notification claim accepted';
  END IF;
  PERFORM * FROM public.mark_yutakasa_completion_notice_uncertain(
    v_work,v_claim,'provider_request_uncertain');
  v_claim:=gen_random_uuid();
  v_notice:=public.claim_yutakasa_completion_notice(v_work,v_claim);
  IF v_notice->>'status'<>'sending' OR
    v_notice->>'idempotency_key'<>'yutakasa-ticket-completion/'||v_work::TEXT THEN
    RAISE EXCEPTION 'uncertain notification retry changed key';
  END IF;
  PERFORM * FROM public.finish_yutakasa_completion_notice(v_work,v_claim,v_provider);
  IF (public.claim_yutakasa_completion_notice(v_work,gen_random_uuid())->>'status')<>'accepted'
    OR NOT EXISTS(SELECT 1 FROM public.yutakasa_ticket_completion_notices n
      WHERE n.work_id=v_work AND n.provider_email_id=v_provider AND n.status='accepted') THEN
    RAISE EXCEPTION 'provider acceptance not durable';
  END IF;

  -- A newly added user message makes an otherwise valid proof stale.
  v_work:=gen_random_uuid();
  v_main:=repeat('e',40);
  v_deployment:='dpl_ABCDEF1234567890';
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,client_request_id)
    VALUES('completion-test@example.invalid','technical','チャットの見出しが空白になる',
      'in_progress','awaiting_repair',gen_random_uuid()) RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。',gen_random_uuid()) RETURNING id INTO v_user;
  INSERT INTO public.yutakasa_repair_releases(pr_number,head_sha,merge_sha,status,
    merge_recorded_at,first_healthy_at,last_healthy_at,healthy_count,verified_at,deployment_id,
    ticket_before_after_run_id,ticket_regression_artifact_sha256)
    VALUES(9702,v_head,v_main,'verified',clock_timestamp()-INTERVAL '30 minutes',
      v_first,v_last,3,clock_timestamp(),v_deployment,301,repeat('2',64));
  INSERT INTO public.yutakasa_repair_observations(
    pr_number,workflow_run_id,observed_at,cron_slot,deployment_id,healthy)
    VALUES(9702,301,v_first,v_slot-2,v_deployment,TRUE),
      (9702,302,v_second,v_slot-1,v_deployment,TRUE),
      (9702,303,v_last,v_slot,v_deployment,TRUE);
  INSERT INTO public.yutakasa_ticket_repair_jobs(work_id,ticket_id,latest_user_message_id,
    status,pr_number,head_sha) VALUES(v_work,v_ticket,v_user,'pr_open',9702,v_head);
  INSERT INTO public.yutakasa_repair_ticket_links(pr_number,ticket_id,latest_user_message_id)
    VALUES(9702,v_ticket,v_user);
  PERFORM * FROM public.record_yutakasa_ticket_completion_proof(
    v_work,v_user,9702,v_head,v_main,v_deployment,'chat_title_zero_width',
    repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),301,302);
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','まだ消えます。',gen_random_uuid());
  BEGIN
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(v_work,v_main,v_deployment);
    RAISE EXCEPTION 'stale customer message accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  UPDATE public.support_tickets SET decision_required=TRUE WHERE id=v_ticket;
  BEGIN
    PERFORM * FROM public.append_yutakasa_verified_ticket_completion(v_work,v_main,v_deployment);
    RAISE EXCEPTION 'decision-required ticket accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;

  -- Category, payment/contract terms, and attachments each block proof creation.
  v_work:=gen_random_uuid();
  v_main:=repeat('f',40);
  v_deployment:='dpl_0987654321ABCDEF';
  INSERT INTO public.support_tickets(user_email,category,subject,status,
    automation_status,client_request_id)
    VALUES('completion-test@example.invalid','technical','返金と会話',
      'in_progress','awaiting_repair',gen_random_uuid()) RETURNING id INTO v_ticket;
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_ticket,'user','チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。',gen_random_uuid()) RETURNING id INTO v_user;
  INSERT INTO public.yutakasa_repair_releases(pr_number,head_sha,merge_sha,status,
    merge_recorded_at,ticket_before_after_run_id,ticket_regression_artifact_sha256)
    VALUES(9703,v_head,v_main,'observing',clock_timestamp()-INTERVAL '30 minutes',
      401,repeat('3',64));
  INSERT INTO public.yutakasa_ticket_repair_jobs(work_id,ticket_id,latest_user_message_id,
    status,pr_number,head_sha) VALUES(v_work,v_ticket,v_user,'pr_open',9703,v_head);
  INSERT INTO public.yutakasa_repair_ticket_links(pr_number,ticket_id,latest_user_message_id)
    VALUES(9703,v_ticket,v_user);
  BEGIN
    PERFORM * FROM public.record_yutakasa_ticket_completion_proof(
      v_work,v_user,9703,v_head,v_main,v_deployment,'chat_title_zero_width',
      repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),401,402);
    RAISE EXCEPTION 'payment subject accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  UPDATE public.support_tickets SET subject='チャットの見出しが空白になる' WHERE id=v_ticket;
  UPDATE public.support_messages SET body='会話を再読み込みすると消えます。契約の相談もあります。'
    WHERE id=v_user;
  BEGIN
    PERFORM * FROM public.record_yutakasa_ticket_completion_proof(
      v_work,v_user,9703,v_head,v_main,v_deployment,'chat_title_zero_width',
      repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),401,402);
    RAISE EXCEPTION 'contract message accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  UPDATE public.support_messages SET body='チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。' WHERE id=v_user;
  UPDATE public.support_tickets SET category='billing' WHERE id=v_ticket;
  BEGIN
    PERFORM * FROM public.record_yutakasa_ticket_completion_proof(
      v_work,v_user,9703,v_head,v_main,v_deployment,'chat_title_zero_width',
      repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),401,402);
    RAISE EXCEPTION 'billing category accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  UPDATE public.support_tickets SET category='technical' WHERE id=v_ticket;
  INSERT INTO public.support_attachments(ticket_id,message_id,storage_path,filename,
    content_type,size_bytes) VALUES(v_ticket,v_user,'completion-test/path','image.png','image/png',1);
  BEGIN
    PERFORM * FROM public.record_yutakasa_ticket_completion_proof(
      v_work,v_user,9703,v_head,v_main,v_deployment,'chat_title_zero_width',
      repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),401,402);
    RAISE EXCEPTION 'attachment accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
END;
$$;

ROLLBACK;
