-- Local test only. Do not apply this file to production.
BEGIN;
DO $$
DECLARE
  v_time TIMESTAMPTZ := '2025-09-16T12:34:56.000Z';
  v_next TIMESTAMPTZ := '2025-09-17T12:34:56.000Z';
  v_claim UUID := '11111111-1111-4111-8111-111111111111';
  v_other UUID := '22222222-2222-4222-8222-222222222222';
BEGIN
  IF public.claim_yutakasa_drive_intake('test-file-one', v_time, '1', v_claim) <> 'acquired' THEN
    RAISE EXCEPTION 'first revision must acquire';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-one', v_time, '1', v_other) <> 'busy' THEN
    RAISE EXCEPTION 'second worker must not acquire active revision';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-one', v_next, '2', v_other) <> 'busy' THEN
    RAISE EXCEPTION 'new revision must wait for prior claim';
  END IF;
  IF public.renew_yutakasa_drive_intake('test-file-one', v_time, v_other) THEN
    RAISE EXCEPTION 'other owner renewed claim';
  END IF;
  IF public.finish_yutakasa_drive_intake('test-file-one', v_time, v_other, 'processed', NULL) THEN
    RAISE EXCEPTION 'other owner finished claim';
  END IF;
  IF NOT public.renew_yutakasa_drive_intake('test-file-one', v_time, v_claim) THEN
    RAISE EXCEPTION 'owner must renew claim';
  END IF;
  IF NOT public.finish_yutakasa_drive_intake('test-file-one', v_time, v_claim, 'processed', NULL) THEN
    RAISE EXCEPTION 'owner must finish claim';
  END IF;
  IF public.finish_yutakasa_drive_intake('test-file-one', v_time, v_claim, 'processed', NULL) THEN
    RAISE EXCEPTION 'double finish must be rejected';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-one', v_time, '1', v_other) <> 'processed' THEN
    RAISE EXCEPTION 'processed revision must not reacquire';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-one', v_time, '2', v_other) <> 'revision_conflict' THEN
    RAISE EXCEPTION 'changed version at same modified time must not reacquire';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-one', v_next, '2', v_other) <> 'acquired' THEN
    RAISE EXCEPTION 'new revision after completed one must acquire';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-one', v_time, '1',
       '33333333-3333-4333-8333-333333333333') <> 'busy' THEN
    RAISE EXCEPTION 'old revision must not run while newer active';
  END IF;
  IF NOT public.finish_yutakasa_drive_intake('test-file-one', v_next, v_other, 'processed', NULL) THEN
    RAISE EXCEPTION 'new revision could not finish';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-one', v_time, '1',
       '33333333-3333-4333-8333-333333333333') <> 'stale' THEN
    RAISE EXCEPTION 'older revision must not process after newer one';
  END IF;

  IF public.claim_yutakasa_drive_intake('test-file-two', v_time, NULL,
       '44444444-4444-4444-8444-444444444444') <> 'acquired' THEN
    RAISE EXCEPTION 'modified-time-only claim must acquire';
  END IF;
  -- Simulate a crash. An expired lease is never silently recycled.
  UPDATE public.yutakasa_drive_intake_items
    SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
    WHERE file_id = 'test-file-two';
  IF public.renew_yutakasa_drive_intake('test-file-two', v_time,
       '44444444-4444-4444-8444-444444444444') THEN
    RAISE EXCEPTION 'expired owner renewed claim';
  END IF;
  IF public.finish_yutakasa_drive_intake('test-file-two', v_time,
       '44444444-4444-4444-8444-444444444444', 'processed', NULL) THEN
    RAISE EXCEPTION 'expired owner finished claim';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-two', v_time, NULL,
       '55555555-5555-4555-8555-555555555555') <> 'needs_review' THEN
    RAISE EXCEPTION 'expired claim must need review';
  END IF;
  IF public.claim_yutakasa_drive_intake('test-file-two', v_next, '2',
       '55555555-5555-4555-8555-555555555555') <> 'needs_review' THEN
    RAISE EXCEPTION 'newer version must not bypass uncertain old version';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.yutakasa_drive_intake_items
    WHERE file_id = 'test-file-two' AND status = 'needs_review'
      AND failure_code = 'lease_expired' AND lease_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'expired claim terminal state mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'yutakasa_drive_intake_items'
      AND column_name IN ('name', 'content', 'body', 'email', 'customer_id')
  ) THEN
    RAISE EXCEPTION 'customer data column in intake ledger';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = 'public.yutakasa_drive_intake_items'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'intake ledger RLS missing';
  END IF;
  IF pg_catalog.has_table_privilege('anon', 'public.yutakasa_drive_intake_items', 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.yutakasa_drive_intake_items', 'SELECT')
    OR pg_catalog.has_table_privilege('service_role', 'public.yutakasa_drive_intake_items', 'INSERT')
    OR pg_catalog.has_table_privilege('service_role', 'public.yutakasa_drive_intake_items', 'UPDATE')
    OR pg_catalog.has_function_privilege('anon',
      'public.claim_yutakasa_drive_intake(text,timestamptz,text,uuid)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('service_role',
      'public.claim_yutakasa_drive_intake(text,timestamptz,text,uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'intake ledger grants too broad or missing';
  END IF;
END;
$$;
ROLLBACK;
