-- Integration assertions for the additive atomic claim RPC.
DO $$
BEGIN
  IF has_function_privilege('anon',
    'public.claim_support_ticket_with_log(uuid,uuid)', 'EXECUTE') OR
     has_function_privilege('authenticated',
    'public.claim_support_ticket_with_log(uuid,uuid)', 'EXECUTE') OR
     NOT has_function_privilege('service_role',
    'public.claim_support_ticket_with_log(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'claim RPC grants are incorrect';
  END IF;
END;
$$;

INSERT INTO support_tickets (
  id, user_email, category, subject, status, automation_status, client_request_id
) VALUES (
  '13a0928d-a677-4817-bd2b-803e2920e744', 'member@example.com',
  'technical', '原子的claimテスト', 'open', 'queued',
  '8131f4ac-c882-43a7-bf69-1268c164f5ee'
);

SET ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.claim_support_ticket_with_log(
      '13a0928d-a677-4817-bd2b-803e2920e744',
      'd7c7817c-8c5b-4a18-a415-7e9f9f965589');
    RAISE EXCEPTION 'anon executed claim RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.claim_support_ticket_with_log(
      '13a0928d-a677-4817-bd2b-803e2920e744',
      'd7c7817c-8c5b-4a18-a415-7e9f9f965589');
    RAISE EXCEPTION 'authenticated executed claim RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE service_role;
DO $$
DECLARE v_row RECORD;
BEGIN
  SELECT * INTO v_row FROM public.claim_support_ticket_with_log(
    '13a0928d-a677-4817-bd2b-803e2920e744',
    'd7c7817c-8c5b-4a18-a415-7e9f9f965589');
  IF v_row.automation_status <> 'investigating' OR
     v_row.status <> 'in_progress' OR
     v_row.automation_lock_token <>
       'd7c7817c-8c5b-4a18-a415-7e9f9f965589'::uuid THEN
    RAISE EXCEPTION 'service role claim result incorrect';
  END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM support_work_logs
      WHERE ticket_id = '13a0928d-a677-4817-bd2b-803e2920e744'
        AND event_type = 'automation_claimed') <> 1 OR
     EXISTS (SELECT 1 FROM claim_support_ticket_with_log(
       '13a0928d-a677-4817-bd2b-803e2920e744',
       'd7c7817c-8c5b-4a18-a415-7e9f9f965589')) OR
     (SELECT count(*) FROM support_work_logs
      WHERE ticket_id = '13a0928d-a677-4817-bd2b-803e2920e744') <> 1 THEN
    RAISE EXCEPTION 'claim retry changed state or duplicated log';
  END IF;
END;
$$;

INSERT INTO support_tickets (
  id, user_email, category, subject, status, automation_status, client_request_id
) VALUES (
  '72813c30-82ab-4e8c-a99e-e40b4d392c3b', 'member@example.com',
  'technical', 'claimロールバックテスト', 'open', 'queued',
  '9131f4ac-c882-43a7-bf69-1268c164f5ee'
);

CREATE FUNCTION reject_claim_test_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ticket_id = '72813c30-82ab-4e8c-a99e-e40b4d392c3b'::uuid AND
     NEW.event_type = 'automation_claimed' THEN
    RAISE EXCEPTION 'forced claim log failure' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_claim_test_log_trigger
  BEFORE INSERT ON support_work_logs FOR EACH ROW
  EXECUTE FUNCTION reject_claim_test_log();

DO $$
BEGIN
  BEGIN
    PERFORM * FROM claim_support_ticket_with_log(
      '72813c30-82ab-4e8c-a99e-e40b4d392c3b',
      'f11d869b-e339-4adf-aee8-3813b02b6010');
    RAISE EXCEPTION 'forced claim log failure did not abort RPC';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  IF (SELECT automation_status FROM support_tickets
      WHERE id = '72813c30-82ab-4e8c-a99e-e40b4d392c3b') <> 'queued' OR
     (SELECT automation_lock_token FROM support_tickets
      WHERE id = '72813c30-82ab-4e8c-a99e-e40b4d392c3b') IS NOT NULL OR
     (SELECT count(*) FROM support_work_logs
      WHERE ticket_id = '72813c30-82ab-4e8c-a99e-e40b4d392c3b') <> 0 THEN
    RAISE EXCEPTION 'failed claim log stranded the ticket';
  END IF;
END;
$$;

DROP TRIGGER reject_claim_test_log_trigger ON support_work_logs;
DROP FUNCTION reject_claim_test_log();

DO $$
DECLARE v_row RECORD;
BEGIN
  SELECT * INTO v_row FROM claim_support_ticket_with_log(
    '72813c30-82ab-4e8c-a99e-e40b4d392c3b',
    'f11d869b-e339-4adf-aee8-3813b02b6010');
  IF v_row.automation_status <> 'investigating' OR
     (SELECT count(*) FROM support_work_logs
      WHERE ticket_id = v_row.id AND event_type = 'automation_claimed') <> 1 THEN
    RAISE EXCEPTION 'claim retry after rollback failed';
  END IF;
END;
$$;

SELECT 'atomic support claim migration assertions passed' AS result;
