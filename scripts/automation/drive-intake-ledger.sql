-- Dormant per-file intake ledger. No scheduler or Drive side effect calls these RPCs.
-- An expired claim becomes needs_review, never an automatically retryable claim.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_drive_intake_items (
  file_id TEXT NOT NULL CHECK (length(file_id) BETWEEN 1 AND 256 AND file_id ~ '^[A-Za-z0-9_-]+$'),
  modified_time TIMESTAMPTZ NOT NULL,
  drive_version TEXT CHECK (drive_version IS NULL OR drive_version ~ '^[0-9]{1,20}$'),
  claim_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'needs_review')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN
    ('lease_expired', 'source_changed', 'processing_failed', 'external_outcome_unknown')),
  PRIMARY KEY (file_id, modified_time),
  CHECK ((status = 'processing') = (lease_expires_at IS NOT NULL)),
  CHECK ((status = 'processing') = (finished_at IS NULL)),
  CHECK ((status = 'needs_review') = (failure_code IS NOT NULL)),
  CHECK (status <> 'processed' OR failure_code IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS yutakasa_drive_intake_one_processing_per_file_idx
  ON public.yutakasa_drive_intake_items (file_id) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS yutakasa_drive_intake_attention_idx
  ON public.yutakasa_drive_intake_items (claimed_at) WHERE status = 'needs_review';

CREATE OR REPLACE FUNCTION public.claim_yutakasa_drive_intake(
  p_file_id TEXT, p_modified_time TIMESTAMPTZ, p_drive_version TEXT, p_claim_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_item public.yutakasa_drive_intake_items%ROWTYPE;
BEGIN
  IF p_file_id IS NULL OR length(p_file_id) NOT BETWEEN 1 AND 256
    OR p_file_id !~ '^[A-Za-z0-9_-]+$'
    OR p_modified_time IS NULL OR p_claim_id IS NULL
    OR (p_drive_version IS NOT NULL AND p_drive_version !~ '^[0-9]{1,20}$')
  THEN
    RAISE EXCEPTION 'invalid Drive intake claim' USING ERRCODE = '22023';
  END IF;
  -- Serializes all revisions of one file, including the first insert.
  PERFORM pg_catalog.pg_advisory_xact_lock(937518, pg_catalog.hashtext(p_file_id));
  -- Renewal and completion use the row lock without the advisory lock.
  -- Wait for them before deciding whether the existing lease has expired.
  PERFORM 1 FROM public.yutakasa_drive_intake_items AS i
    WHERE i.file_id = p_file_id AND i.status = 'processing'
    FOR UPDATE;
  v_now := clock_timestamp();
  IF p_modified_time > v_now + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'invalid Drive intake timestamp' USING ERRCODE = '22023';
  END IF;

  UPDATE public.yutakasa_drive_intake_items AS i
    SET status = 'needs_review', finished_at = v_now, lease_expires_at = NULL,
        failure_code = 'lease_expired'
    WHERE i.file_id = p_file_id AND i.status = 'processing'
      AND i.lease_expires_at <= v_now;
  IF EXISTS (SELECT 1 FROM public.yutakasa_drive_intake_items AS i
             WHERE i.file_id = p_file_id AND i.status = 'needs_review') THEN
    RETURN 'needs_review';
  END IF;
  IF EXISTS (SELECT 1 FROM public.yutakasa_drive_intake_items AS i
             WHERE i.file_id = p_file_id AND i.status = 'processing') THEN
    RETURN 'busy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.yutakasa_drive_intake_items AS i
             WHERE i.file_id = p_file_id AND i.modified_time > p_modified_time) THEN
    RETURN 'stale';
  END IF;
  SELECT * INTO v_item FROM public.yutakasa_drive_intake_items AS i
    WHERE i.file_id = p_file_id AND i.modified_time = p_modified_time;
  IF FOUND THEN
    IF v_item.drive_version IS DISTINCT FROM p_drive_version THEN
      RETURN 'revision_conflict';
    END IF;
    RETURN 'processed';
  END IF;

  INSERT INTO public.yutakasa_drive_intake_items
    (file_id, modified_time, drive_version, claim_id, status, claimed_at,
     last_heartbeat_at, lease_expires_at)
    VALUES (p_file_id, p_modified_time, p_drive_version, p_claim_id,
            'processing', v_now, v_now, v_now + INTERVAL '2 minutes');
  RETURN 'acquired';
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_yutakasa_drive_intake(
  p_file_id TEXT, p_modified_time TIMESTAMPTZ, p_claim_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_item public.yutakasa_drive_intake_items%ROWTYPE;
BEGIN
  IF p_file_id IS NULL OR length(p_file_id) NOT BETWEEN 1 AND 256
    OR p_file_id !~ '^[A-Za-z0-9_-]+$'
    OR p_modified_time IS NULL OR p_claim_id IS NULL THEN
    RAISE EXCEPTION 'invalid Drive intake renewal' USING ERRCODE = '22023';
  END IF;
  -- Wait for the row lock before sampling time. A contender must not renew a
  -- lease that expired while another transaction held the row lock.
  SELECT * INTO v_item FROM public.yutakasa_drive_intake_items AS i
    WHERE i.file_id = p_file_id AND i.modified_time = p_modified_time
      AND i.claim_id = p_claim_id AND i.status = 'processing'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  v_now := clock_timestamp();
  IF v_item.lease_expires_at <= v_now THEN RETURN FALSE; END IF;
  UPDATE public.yutakasa_drive_intake_items AS i
    SET last_heartbeat_at = v_now, lease_expires_at = v_now + INTERVAL '2 minutes'
    WHERE i.file_id = p_file_id AND i.modified_time = p_modified_time
      AND i.claim_id = p_claim_id AND i.status = 'processing';
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_yutakasa_drive_intake(
  p_file_id TEXT, p_modified_time TIMESTAMPTZ, p_claim_id UUID,
  p_status TEXT, p_failure_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_item public.yutakasa_drive_intake_items%ROWTYPE;
BEGIN
  IF p_file_id IS NULL OR length(p_file_id) NOT BETWEEN 1 AND 256
    OR p_file_id !~ '^[A-Za-z0-9_-]+$'
    OR p_modified_time IS NULL OR p_claim_id IS NULL
    OR p_status IS NULL OR p_status NOT IN ('processed', 'needs_review')
    OR (p_status = 'processed' AND p_failure_code IS NOT NULL)
    OR (p_status = 'needs_review' AND (p_failure_code IS NULL OR p_failure_code NOT IN
      ('source_changed', 'processing_failed', 'external_outcome_unknown')))
  THEN
    RAISE EXCEPTION 'invalid Drive intake finish' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.yutakasa_drive_intake_items AS i
    WHERE i.file_id = p_file_id AND i.modified_time = p_modified_time
      AND i.claim_id = p_claim_id AND i.status = 'processing'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  v_now := clock_timestamp();
  IF v_item.lease_expires_at <= v_now THEN RETURN FALSE; END IF;
  UPDATE public.yutakasa_drive_intake_items AS i
    SET status = p_status, failure_code = p_failure_code,
        finished_at = v_now, lease_expires_at = NULL
    WHERE i.file_id = p_file_id AND i.modified_time = p_modified_time
      AND i.claim_id = p_claim_id AND i.status = 'processing';
  RETURN TRUE;
END;
$$;

ALTER TABLE public.yutakasa_drive_intake_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.yutakasa_drive_intake_items
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.yutakasa_drive_intake_items TO service_role;
REVOKE ALL ON FUNCTION public.claim_yutakasa_drive_intake(TEXT,TIMESTAMPTZ,TEXT,UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_yutakasa_drive_intake(TEXT,TIMESTAMPTZ,UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_yutakasa_drive_intake(TEXT,TIMESTAMPTZ,UUID,TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_yutakasa_drive_intake(TEXT,TIMESTAMPTZ,TEXT,UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_yutakasa_drive_intake(TEXT,TIMESTAMPTZ,UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_yutakasa_drive_intake(TEXT,TIMESTAMPTZ,UUID,TEXT,TEXT)
  TO service_role;

COMMIT;
