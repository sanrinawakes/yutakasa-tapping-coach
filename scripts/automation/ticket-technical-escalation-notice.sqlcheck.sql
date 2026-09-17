BEGIN;
DO $$
DECLARE v_ticket UUID:=gen_random_uuid();
DECLARE v_message UUID:=gen_random_uuid();
DECLARE v_followup UUID:=gen_random_uuid();
DECLARE v_claim UUID:=gen_random_uuid();
DECLARE v_retry UUID:=gen_random_uuid();
DECLARE v_provider UUID:=gen_random_uuid();
DECLARE v_other UUID:=gen_random_uuid();
DECLARE v_owner UUID:=gen_random_uuid();
DECLARE v_smoke UUID:=gen_random_uuid();
DECLARE v_notice JSONB;
DECLARE v_count INTEGER;
DECLARE v_rejected BOOLEAN:=FALSE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid='public.yutakasa_ticket_technical_escalation_notices'::regclass
      AND c.relrowsecurity)
    OR has_table_privilege('anon','public.yutakasa_ticket_technical_escalation_notices','SELECT')
    OR has_table_privilege('authenticated','public.yutakasa_ticket_technical_escalation_notices','SELECT')
    OR has_table_privilege('service_role','public.yutakasa_ticket_technical_escalation_notices','INSERT')
    OR NOT has_table_privilege('service_role','public.yutakasa_ticket_technical_escalation_notices','SELECT')
    OR has_function_privilege('authenticated',
      'public.claim_yutakasa_technical_escalation_notice(uuid,uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.claim_yutakasa_technical_escalation_notice(uuid,uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'technical escalation access invalid';
  END IF;

  INSERT INTO public.subscribers(email) VALUES('technical-escalation-test@example.invalid');
  INSERT INTO public.subscribers(email) VALUES
    ('yutakasa-auto-smoke+11111111-1111-4111-8111-111111111111@example.invalid');
  INSERT INTO public.support_tickets(id,user_email,category,subject,status,
    decision_required,automation_status,client_request_id)
    VALUES(v_ticket,'technical-escalation-test@example.invalid','technical',
      '画面が保存されない','in_progress',FALSE,'manual_review',gen_random_uuid());
  INSERT INTO public.support_messages(id,ticket_id,sender_type,body,client_request_id)
    VALUES(v_message,v_ticket,'user','保存できません',gen_random_uuid());
  INSERT INTO public.support_tickets(id,user_email,category,subject,status,
    decision_required,automation_status,client_request_id) VALUES
    (v_other,'technical-escalation-test@example.invalid','billing','請求',
      'in_progress',FALSE,'manual_review',gen_random_uuid()),
    (v_owner,'technical-escalation-test@example.invalid','technical','変更判断',
      'in_progress',TRUE,'manual_review',gen_random_uuid()),
    (v_smoke,'yutakasa-auto-smoke+11111111-1111-4111-8111-111111111111@example.invalid',
      'technical','スモーク','in_progress',FALSE,'manual_review',gen_random_uuid());
  INSERT INTO public.support_messages(ticket_id,sender_type,body,client_request_id)
    VALUES(v_other,'user','請求を確認したい',gen_random_uuid()),
      (v_owner,'user','変更したい',gen_random_uuid()),
      (v_smoke,'user','テスト',gen_random_uuid());
  IF EXISTS(SELECT 1 FROM public.list_due_yutakasa_technical_escalation_notices() d
    WHERE d.ticket_id IN (v_other,v_owner,v_smoke)) THEN
    RAISE EXCEPTION 'non-technical, owner-decision, or synthetic ticket was queued';
  END IF;
  SELECT count(*) INTO v_count FROM public.list_due_yutakasa_technical_escalation_notices() d
    WHERE d.ticket_id=v_ticket AND d.latest_user_message_id=v_message;
  IF v_count<>1 THEN RAISE EXCEPTION 'stopped technical ticket not listed'; END IF;

  v_notice:=public.claim_yutakasa_technical_escalation_notice(v_ticket,v_message,v_claim);
  IF v_notice->>'status'<>'sending' OR v_notice->>'ticket_id'<>v_ticket::TEXT OR
      v_notice->>'latest_user_message_id'<>v_message::TEXT OR
      v_notice->>'claim_token'<>v_claim::TEXT OR
      v_notice->>'idempotency_key'<>
        'yutakasa-technical-escalation/'||v_ticket::TEXT||'/'||v_message::TEXT THEN
    RAISE EXCEPTION 'technical escalation claim invalid';
  END IF;
  IF public.claim_yutakasa_technical_escalation_notice(v_ticket,v_message,gen_random_uuid())
      ->>'status'<>'busy' THEN RAISE EXCEPTION 'duplicate claim accepted'; END IF;
  BEGIN
    PERFORM * FROM public.finish_yutakasa_technical_escalation_notice(
      v_ticket,v_message,gen_random_uuid(),v_provider);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected:=TRUE;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'wrong claim token accepted'; END IF;
  PERFORM * FROM public.mark_yutakasa_technical_escalation_notice_uncertain(
    v_ticket,v_message,v_claim,'provider_request_uncertain');
  UPDATE public.yutakasa_ticket_technical_escalation_notices n SET
    updated_at=clock_timestamp()-INTERVAL '2 minutes'
    WHERE n.ticket_id=v_ticket AND n.latest_user_message_id=v_message;
  v_notice:=public.claim_yutakasa_technical_escalation_notice(v_ticket,v_message,v_retry);
  IF v_notice->>'status'<>'sending' OR v_notice->>'idempotency_key'<>
      'yutakasa-technical-escalation/'||v_ticket::TEXT||'/'||v_message::TEXT THEN
    RAISE EXCEPTION 'idempotent retry invalid';
  END IF;
  PERFORM * FROM public.finish_yutakasa_technical_escalation_notice(
    v_ticket,v_message,v_retry,v_provider);
  IF public.claim_yutakasa_technical_escalation_notice(v_ticket,v_message,gen_random_uuid())
      ->>'status'<>'accepted' OR EXISTS(
      SELECT 1 FROM public.list_due_yutakasa_technical_escalation_notices() d
      WHERE d.ticket_id=v_ticket) THEN
    RAISE EXCEPTION 'accepted notice was queued again';
  END IF;
  INSERT INTO public.support_messages(id,ticket_id,sender_type,body,client_request_id,created_at)
    VALUES(v_followup,v_ticket,'user','追加情報',gen_random_uuid(),
      clock_timestamp()+INTERVAL '1 second');
  IF NOT EXISTS(SELECT 1 FROM public.list_due_yutakasa_technical_escalation_notices() d
    WHERE d.ticket_id=v_ticket AND d.latest_user_message_id=v_followup) THEN
    RAISE EXCEPTION 'new customer message was not noticed';
  END IF;
  IF public.claim_yutakasa_technical_escalation_notice(v_ticket,v_message,gen_random_uuid())
      ->>'status'<>'suppressed' THEN
    RAISE EXCEPTION 'stale customer message could be sent';
  END IF;
  UPDATE public.support_tickets SET status='resolved' WHERE id=v_ticket;
  IF EXISTS(SELECT 1 FROM public.list_due_yutakasa_technical_escalation_notices() d
    WHERE d.ticket_id=v_ticket) OR
    public.claim_yutakasa_technical_escalation_notice(v_ticket,v_followup,gen_random_uuid())
      ->>'status'<>'suppressed' THEN
    RAISE EXCEPTION 'resolved ticket could be notified';
  END IF;
  SELECT count(*) INTO v_count FROM public.support_work_logs l
    WHERE l.ticket_id=v_ticket AND l.event_type='technical_escalation_notice_provider_accepted';
  IF v_count<>1 THEN RAISE EXCEPTION 'provider acceptance log missing or duplicated'; END IF;
END;
$$;
ROLLBACK;
