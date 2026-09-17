-- Run after support-automation-manual-review.sql in the isolated test DB.
DO $$
BEGIN
  IF has_function_privilege('anon',
      'public.finish_locked_support_ticket(uuid,uuid,timestamptz,uuid,text,text)', 'EXECUTE') OR
     has_function_privilege('authenticated',
      'public.finish_locked_support_ticket(uuid,uuid,timestamptz,uuid,text,text)', 'EXECUTE') OR
     NOT has_function_privilege('service_role',
      'public.finish_locked_support_ticket(uuid,uuid,timestamptz,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'manual review RPC grants are incorrect';
  END IF;
END;
$$;

INSERT INTO public.subscribers(email)
VALUES ('manual-review-test@example.invalid') ON CONFLICT (email) DO NOTHING;

INSERT INTO public.support_tickets (
  id,user_email,category,subject,status,automation_status,
  automation_locked_at,automation_lock_token,client_request_id,updated_at
) VALUES (
  'a8b13f75-5784-483c-a5c8-4309b41cedef','manual-review-test@example.invalid',
  'technical','添付ありの終端テスト','in_progress','investigating',
  '2026-09-16T04:00:00Z','a8b13f75-5784-483c-a5c8-4309b41cedf0',
  'a8b13f75-5784-483c-a5c8-4309b41cedf1','2026-09-16T04:00:00Z'
);
INSERT INTO public.support_messages (
  id,ticket_id,sender_type,sender_email,body,client_request_id,created_at
) VALUES (
  'a8b13f75-5784-483c-a5c8-4309b41cedf2',
  'a8b13f75-5784-483c-a5c8-4309b41cedef',
  'user','manual-review-test@example.invalid','添付した画面を見てください。',
  'a8b13f75-5784-483c-a5c8-4309b41cedf3','2026-09-16T04:00:00Z'
);

DO $$
DECLARE
  v_ticket UUID := 'a8b13f75-5784-483c-a5c8-4309b41cedef';
  v_lock UUID := 'a8b13f75-5784-483c-a5c8-4309b41cedf0';
  v_message UUID := 'a8b13f75-5784-483c-a5c8-4309b41cedf2';
  v_version TIMESTAMPTZ := '2026-09-16T04:00:00Z';
BEGIN
  IF EXISTS (SELECT 1 FROM public.finish_locked_support_ticket(
      v_ticket,gen_random_uuid(),v_version,v_message,'manual_review','wrong lock')) OR
     EXISTS (SELECT 1 FROM public.finish_locked_support_ticket(
      v_ticket,v_lock,v_version + interval '1 second',v_message,'manual_review','wrong version')) OR
     EXISTS (SELECT 1 FROM public.finish_locked_support_ticket(
      v_ticket,v_lock,v_version,gen_random_uuid(),'manual_review','wrong message')) OR
     (SELECT automation_status FROM public.support_tickets WHERE id=v_ticket) <> 'investigating' OR
     (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=v_ticket) <> 0 THEN
    RAISE EXCEPTION 'manual review CAS miss changed ticket';
  END IF;
END;
$$;

SET ROLE service_role;
DO $$
DECLARE v_row public.support_tickets%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.finish_locked_support_ticket(
    'a8b13f75-5784-483c-a5c8-4309b41cedef',
    'a8b13f75-5784-483c-a5c8-4309b41cedf0',
    '2026-09-16T04:00:00Z',
    'a8b13f75-5784-483c-a5c8-4309b41cedf2',
    'manual_review','担当者が添付ファイルを確認します。');
  IF NOT FOUND OR v_row.automation_status <> 'manual_review' OR
     v_row.decision_required OR v_row.automation_lock_token IS NOT NULL OR
     v_row.automation_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'manual review terminal result invalid';
  END IF;
END;
$$;
RESET ROLE;

DO $$
DECLARE
  v_ticket UUID := 'a8b13f75-5784-483c-a5c8-4309b41cedef';
BEGIN
  IF EXISTS (SELECT 1 FROM public.finish_locked_support_ticket(
      v_ticket,'a8b13f75-5784-483c-a5c8-4309b41cedf0',
      '2026-09-16T04:00:00Z','a8b13f75-5784-483c-a5c8-4309b41cedf2',
      'manual_review','duplicate retry')) OR
     (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=v_ticket
       AND event_type='automation_manual_review') <> 1 OR
     (SELECT count(*) FROM public.support_tickets WHERE id=v_ticket
       AND automation_status IN ('queued','failed')) <> 0 THEN
    RAISE EXCEPTION 'manual review was retried or left in the automation queue';
  END IF;
END;
$$;

SELECT 'manual review terminal assertions passed' AS result;
