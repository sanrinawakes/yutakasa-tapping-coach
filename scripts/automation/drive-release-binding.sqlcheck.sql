-- Local synthetic fixture only. Never apply this file to production.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = 'public.yutakasa_drive_release_bindings'::regclass AND relrowsecurity)
    OR NOT has_table_privilege('service_role',
      'public.yutakasa_drive_release_bindings', 'SELECT')
    OR has_table_privilege('service_role',
      'public.yutakasa_drive_release_bindings', 'INSERT')
    OR has_table_privilege('service_role',
      'public.yutakasa_drive_release_bindings', 'UPDATE')
    OR has_table_privilege('service_role',
      'public.yutakasa_drive_release_bindings', 'DELETE')
    OR has_table_privilege('anon',
      'public.yutakasa_drive_release_bindings', 'SELECT')
    OR has_table_privilege('authenticated',
      'public.yutakasa_drive_release_bindings', 'SELECT') THEN
    RAISE EXCEPTION 'Drive release binding RLS or grants invalid';
  END IF;
END;
$$;

INSERT INTO public.yutakasa_repair_releases(pr_number, head_sha, status)
  VALUES (987654321, repeat('a', 40), 'pending_merge');

INSERT INTO public.yutakasa_drive_release_bindings(
  event_id, file_id, modified_time, drive_version, content_sha256,
  report_sha256, release_pr_number, report, status, verified_at
) VALUES (
  'drive_' || repeat('a', 32), 'synthetic_file_1',
  '2026-09-17T02:00:00.000Z', '42', repeat('b', 64),
  repeat('c', 64), 987654321,
  jsonb_build_object('eventId', 'drive_' || repeat('a', 32)),
  'verified', clock_timestamp()
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.yutakasa_drive_release_bindings
      WHERE file_id = 'synthetic_file_1') <> 1 THEN
    RAISE EXCEPTION 'Drive release binding insert failed';
  END IF;
  BEGIN
    INSERT INTO public.yutakasa_drive_release_bindings(
      event_id, file_id, modified_time, drive_version, content_sha256,
      report_sha256, release_pr_number, report, status, verified_at
    ) VALUES (
      'drive_' || repeat('d', 32), 'synthetic_file_1',
      '2026-09-17T02:01:00.000Z', '42', repeat('b', 64),
      repeat('c', 64), 987654321,
      jsonb_build_object('eventId', 'drive_' || repeat('d', 32)),
      'verified', clock_timestamp()
    );
    RAISE EXCEPTION 'duplicate file version and hash was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;
ROLLBACK;
