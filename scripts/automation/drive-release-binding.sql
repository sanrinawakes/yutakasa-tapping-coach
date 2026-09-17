-- Dormant, owner-recorded binding from one Drive revision to one release.
-- No scheduled caller or API role may insert, edit, or delete a binding.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_drive_release_bindings (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^drive_[a-f0-9]{32}$'),
  file_id TEXT NOT NULL CHECK (
    file_id ~ '^[A-Za-z0-9_-]+$' AND length(file_id) BETWEEN 1 AND 256
  ),
  modified_time TIMESTAMPTZ NOT NULL,
  drive_version TEXT NOT NULL CHECK (drive_version ~ '^[0-9]{1,20}$'),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  report_sha256 TEXT NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
  release_pr_number INTEGER NOT NULL
    REFERENCES public.yutakasa_repair_releases(pr_number),
  report JSONB NOT NULL CHECK (
    jsonb_typeof(report) = 'object' AND
    octet_length(report::TEXT) BETWEEN 2 AND 65536 AND
    report->>'eventId' = event_id
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'rejected')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  verified_at TIMESTAMPTZ,
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  UNIQUE (file_id, modified_time, drive_version),
  UNIQUE (file_id, content_sha256, drive_version)
);

ALTER TABLE public.yutakasa_drive_release_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.yutakasa_drive_release_bindings
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.yutakasa_drive_release_bindings TO service_role;

COMMIT;
