-- Integration assertions for the additive claimed-ticket terminal RPC.
DO $$
BEGIN
  IF has_function_privilege('anon',
    'public.finish_locked_support_ticket(uuid,uuid,timestamptz,uuid,text,text)', 'EXECUTE') OR
     has_function_privilege('authenticated',
    'public.finish_locked_support_ticket(uuid,uuid,timestamptz,uuid,text,text)', 'EXECUTE') OR
     NOT has_function_privilege('service_role',
    'public.finish_locked_support_ticket(uuid,uuid,timestamptz,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'terminal RPC grants are incorrect';
  END IF;
END;
$$;

-- A real customer follow-up clears ownership before a stale terminal call.
INSERT INTO support_tickets (
  id, user_email, category, subject, status, automation_status,
  automation_locked_at, automation_lock_token, client_request_id, updated_at
) VALUES (
  'caf4987d-f4c0-4333-9c22-31f797fb1823', 'member@example.com',
  'technical', '追記との競合テスト', 'in_progress', 'investigating',
  '2026-09-16T03:00:00Z', 'b82c4088-c784-4f36-9a4a-07b0e17cad71',
  '62289a1d-c839-4fee-8462-9118e2d5d7f1', '2026-09-16T03:00:00Z'
);
INSERT INTO support_messages (
  id, ticket_id, sender_type, sender_email, body, client_request_id, created_at
) VALUES (
  '449821fd-6d39-456f-aef3-d88437252e94',
  'caf4987d-f4c0-4333-9c22-31f797fb1823', 'user', 'member@example.com',
  '最初の問い合わせ。', '31289a1d-c839-4fee-8462-9118e2d5d7f1', '2026-09-16T03:00:00Z'
);
DO $$
BEGIN
  PERFORM * FROM append_support_user_message(
    'member@example.com', 'caf4987d-f4c0-4333-9c22-31f797fb1823',
    '追加で相談します。', '41289a1d-c839-4fee-8462-9118e2d5d7f1',
    FALSE, '[]'::jsonb);
  IF EXISTS (SELECT 1 FROM finish_locked_support_ticket(
    'caf4987d-f4c0-4333-9c22-31f797fb1823',
    'b82c4088-c784-4f36-9a4a-07b0e17cad71',
    '2026-09-16T03:00:00Z',
    '449821fd-6d39-456f-aef3-d88437252e94',
    'decision_required', '古い判断')) OR
     (SELECT automation_status FROM support_tickets
      WHERE id = 'caf4987d-f4c0-4333-9c22-31f797fb1823') <> 'queued' OR
     (SELECT count(*) FROM support_work_logs
      WHERE ticket_id = 'caf4987d-f4c0-4333-9c22-31f797fb1823') <> 0 THEN
    RAISE EXCEPTION 'customer follow-up was overwritten by stale terminal call';
  END IF;
END;
$$;

INSERT INTO support_tickets (
  id, user_email, category, subject, status, automation_status,
  automation_locked_at, automation_lock_token, client_request_id, updated_at
) VALUES (
  '2e4710db-9274-4e4c-96c4-59dc97e21c8d', 'member@example.com',
  'technical', '原子的な終端テスト', 'in_progress', 'investigating',
  '2026-09-16T01:00:00Z', '09919e11-742a-41b4-b3f2-8cc3ff86b5cd',
  '82289a1d-c839-4fee-8462-9118e2d5d7f1', '2026-09-16T01:00:00Z'
);
INSERT INTO support_messages (
  id, ticket_id, sender_type, sender_email, body, client_request_id, created_at
) VALUES (
  'a61fb99e-874b-4111-a95a-4f4cb268e48c',
  '2e4710db-9274-4e4c-96c4-59dc97e21c8d', 'user', 'member@example.com',
  '調査してください。', '11289a1d-c839-4fee-8462-9118e2d5d7f1', '2026-09-16T01:00:00Z'
);

DO $$
DECLARE
  v_ticket_id UUID := '2e4710db-9274-4e4c-96c4-59dc97e21c8d';
  v_lock UUID := '09919e11-742a-41b4-b3f2-8cc3ff86b5cd';
  v_latest UUID := 'a61fb99e-874b-4111-a95a-4f4cb268e48c';
  v_version TIMESTAMPTZ := '2026-09-16T01:00:00Z';
BEGIN
  IF EXISTS (SELECT 1 FROM finish_locked_support_ticket(
      v_ticket_id, gen_random_uuid(), v_version, v_latest, 'failed', 'wrong lock')) OR
     EXISTS (SELECT 1 FROM finish_locked_support_ticket(
      v_ticket_id, v_lock, v_version + interval '1 second', v_latest, 'failed', 'wrong version')) OR
     EXISTS (SELECT 1 FROM finish_locked_support_ticket(
      v_ticket_id, v_lock, v_version, gen_random_uuid(), 'failed', 'wrong message')) THEN
    RAISE EXCEPTION 'stale terminal request changed ticket';
  END IF;
  IF (SELECT automation_status FROM support_tickets WHERE id = v_ticket_id) <> 'investigating' OR
     (SELECT count(*) FROM support_work_logs WHERE ticket_id = v_ticket_id) <> 0 THEN
    RAISE EXCEPTION 'CAS miss changed ticket or work logs';
  END IF;
END;
$$;

SET ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.finish_locked_support_ticket(
      '2e4710db-9274-4e4c-96c4-59dc97e21c8d',
      '09919e11-742a-41b4-b3f2-8cc3ff86b5cd',
      '2026-09-16T01:00:00Z',
      'a61fb99e-874b-4111-a95a-4f4cb268e48c',
      'failed', 'not permitted');
    RAISE EXCEPTION 'anon executed terminal RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.finish_locked_support_ticket(
      '2e4710db-9274-4e4c-96c4-59dc97e21c8d',
      '09919e11-742a-41b4-b3f2-8cc3ff86b5cd',
      '2026-09-16T01:00:00Z',
      'a61fb99e-874b-4111-a95a-4f4cb268e48c',
      'failed', 'not permitted');
    RAISE EXCEPTION 'authenticated executed terminal RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE service_role;
DO $$
DECLARE v_row RECORD;
BEGIN
  SELECT * INTO v_row FROM public.finish_locked_support_ticket(
    '2e4710db-9274-4e4c-96c4-59dc97e21c8d',
    '09919e11-742a-41b4-b3f2-8cc3ff86b5cd',
    '2026-09-16T01:00:00Z',
    'a61fb99e-874b-4111-a95a-4f4cb268e48c',
    'decision_required', '運営判断を依頼します。');
  IF v_row.automation_status <> 'blocked_decision' OR
     v_row.decision_required <> TRUE OR v_row.automation_lock_token IS NOT NULL THEN
    RAISE EXCEPTION 'service role terminal result incorrect';
  END IF;
END;
$$;
RESET ROLE;

DO $$
DECLARE
  v_ticket_id UUID := '2e4710db-9274-4e4c-96c4-59dc97e21c8d';
  v_lock UUID := '09919e11-742a-41b4-b3f2-8cc3ff86b5cd';
  v_latest UUID := 'a61fb99e-874b-4111-a95a-4f4cb268e48c';
  v_version TIMESTAMPTZ := '2026-09-16T01:00:00Z';
BEGIN
  IF (SELECT count(*) FROM support_work_logs WHERE ticket_id = v_ticket_id
      AND event_type = 'owner_decision_required') <> 1 THEN
    RAISE EXCEPTION 'atomic decision work log missing or duplicated';
  END IF;
  IF EXISTS (SELECT 1 FROM finish_locked_support_ticket(
      v_ticket_id, v_lock, v_version, v_latest, 'decision_required', 'duplicate retry')) OR
     (SELECT count(*) FROM support_work_logs WHERE ticket_id = v_ticket_id) <> 1 THEN
    RAISE EXCEPTION 'duplicate terminal call changed state or inserted another log';
  END IF;
END;
$$;

INSERT INTO support_tickets (
  id, user_email, category, subject, status, automation_status,
  automation_locked_at, automation_lock_token, client_request_id, updated_at
) VALUES (
  'b647e8d3-5a7c-471d-bf1c-e16b6520ea0d', 'member@example.com',
  'technical', 'ロールバックテスト', 'in_progress', 'investigating',
  '2026-09-16T02:00:00Z', '340c4f7d-b8a2-48fd-8ad1-a4057288105c',
  '52289a1d-c839-4fee-8462-9118e2d5d7f1', '2026-09-16T02:00:00Z'
);
INSERT INTO support_messages (
  id, ticket_id, sender_type, sender_email, body, client_request_id, created_at
) VALUES (
  'f41fb99e-874b-4111-a95a-4f4cb268e48c',
  'b647e8d3-5a7c-471d-bf1c-e16b6520ea0d', 'user', 'member@example.com',
  '再調査してください。', '21289a1d-c839-4fee-8462-9118e2d5d7f1', '2026-09-16T02:00:00Z'
);

CREATE FUNCTION reject_terminal_test_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.summary = 'force rollback' THEN
    RAISE EXCEPTION 'forced log insert failure' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_terminal_test_log_trigger
  BEFORE INSERT ON support_work_logs FOR EACH ROW
  EXECUTE FUNCTION reject_terminal_test_log();

DO $$
BEGIN
  BEGIN
    PERFORM * FROM finish_locked_support_ticket(
      'b647e8d3-5a7c-471d-bf1c-e16b6520ea0d',
      '340c4f7d-b8a2-48fd-8ad1-a4057288105c',
      '2026-09-16T02:00:00Z',
      'f41fb99e-874b-4111-a95a-4f4cb268e48c',
      'failed', 'force rollback');
    RAISE EXCEPTION 'forced log failure did not abort terminal RPC';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF (SELECT automation_status FROM support_tickets
      WHERE id = 'b647e8d3-5a7c-471d-bf1c-e16b6520ea0d') <> 'investigating' OR
     (SELECT automation_lock_token FROM support_tickets
      WHERE id = 'b647e8d3-5a7c-471d-bf1c-e16b6520ea0d') <>
        '340c4f7d-b8a2-48fd-8ad1-a4057288105c'::uuid OR
     (SELECT count(*) FROM support_work_logs
      WHERE ticket_id = 'b647e8d3-5a7c-471d-bf1c-e16b6520ea0d') <> 0 THEN
    RAISE EXCEPTION 'terminal update was not rolled back with failed log';
  END IF;
END;
$$;

DROP TRIGGER reject_terminal_test_log_trigger ON support_work_logs;
DROP FUNCTION reject_terminal_test_log();

DO $$
DECLARE v_row RECORD;
BEGIN
  SELECT * INTO v_row FROM finish_locked_support_ticket(
    'b647e8d3-5a7c-471d-bf1c-e16b6520ea0d',
    '340c4f7d-b8a2-48fd-8ad1-a4057288105c',
    '2026-09-16T02:00:00Z',
    'f41fb99e-874b-4111-a95a-4f4cb268e48c',
    'failed', '再調査が必要です。');
  IF v_row.automation_status <> 'failed' OR
     (SELECT count(*) FROM support_work_logs
      WHERE ticket_id = v_row.id AND event_type = 'automation_failed') <> 1 THEN
    RAISE EXCEPTION 'terminal retry after rollback failed';
  END IF;
END;
$$;

SELECT 'atomic support terminal migration assertions passed' AS result;
