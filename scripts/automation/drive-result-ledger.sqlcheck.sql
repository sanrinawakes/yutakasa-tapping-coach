DO $$
DECLARE
  v_event TEXT := 'release_test_123456';
  v_sha TEXT := repeat('a', 64);
  v_name TEXT := '豊かさBOT_対応結果_release_test_123456.pdf';
BEGIN
  IF public.reserve_yutakasa_drive_result(v_event, v_sha, v_name) <> 'reserved' THEN
    RAISE EXCEPTION 'first publication must reserve';
  END IF;
  IF public.reserve_yutakasa_drive_result(v_event, v_sha, v_name) <> 'pending' THEN
    RAISE EXCEPTION 'second publication must not POST';
  END IF;
  IF public.reserve_yutakasa_drive_result(v_event, repeat('b', 64), v_name) <> 'conflict' THEN
    RAISE EXCEPTION 'changed bytes must not use same event';
  END IF;
  IF NOT public.mark_yutakasa_drive_result_uncertain(v_event, v_sha) THEN
    RAISE EXCEPTION 'uncertain publication not marked';
  END IF;
  IF public.reserve_yutakasa_drive_result(v_event, v_sha, v_name) <> 'pending' THEN
    RAISE EXCEPTION 'uncertain publication must not auto-retry';
  END IF;
  IF NOT public.confirm_yutakasa_drive_result(v_event, v_sha, 'drive_file_123') THEN
    RAISE EXCEPTION 'verified readback must confirm';
  END IF;
  IF NOT public.confirm_yutakasa_drive_result(v_event, v_sha, 'drive_file_123') THEN
    RAISE EXCEPTION 'same readback must be idempotent';
  END IF;
  IF public.confirm_yutakasa_drive_result(v_event, v_sha, 'different_drive_file') THEN
    RAISE EXCEPTION 'different Drive file must not confirm';
  END IF;
  IF public.reserve_yutakasa_drive_result(v_event, v_sha, v_name) <> 'confirmed' THEN
    RAISE EXCEPTION 'confirmed publication must not POST';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.yutakasa_drive_result_publications p
      WHERE p.event_id = v_event
        AND (p.status <> 'confirmed' OR p.file_id <> 'drive_file_123')
  ) THEN
    RAISE EXCEPTION 'confirmed publication row mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = 'public.yutakasa_drive_result_publications'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'publication ledger RLS missing';
  END IF;
  IF pg_catalog.has_table_privilege('anon', 'public.yutakasa_drive_result_publications', 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', 'public.yutakasa_drive_result_publications', 'SELECT')
    OR pg_catalog.has_table_privilege('service_role', 'public.yutakasa_drive_result_publications', 'INSERT')
    OR pg_catalog.has_table_privilege('service_role', 'public.yutakasa_drive_result_publications', 'UPDATE')
  THEN
    RAISE EXCEPTION 'publication ledger table grants too broad';
  END IF;
  IF pg_catalog.has_function_privilege('anon',
       'public.reserve_yutakasa_drive_result(text,text,text)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated',
       'public.confirm_yutakasa_drive_result(text,text,text)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('service_role',
       'public.reserve_yutakasa_drive_result(text,text,text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'publication ledger RPC grants invalid';
  END IF;
END;
$$;
