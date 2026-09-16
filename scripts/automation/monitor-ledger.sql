-- Durable, metadata-only Railway monitor lease and run history.
-- Apply before enabling the monitor service. The daily report can read this table.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_monitor_runs (
  run_id UUID PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('scheduled', 'recheck')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'healthy', 'action_required', 'failed', 'abandoned')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9][A-Za-z0-9_]{0,127}$'),
  deployment_id TEXT CHECK (deployment_id IS NULL OR deployment_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  queue_start_exact INTEGER CHECK (queue_start_exact IS NULL OR queue_start_exact >= 0),
  queue_final_exact INTEGER CHECK (queue_final_exact IS NULL OR queue_final_exact >= 0),
  drive_start_count INTEGER CHECK (drive_start_count IS NULL OR drive_start_count >= 0),
  drive_final_count INTEGER CHECK (drive_final_count IS NULL OR drive_final_count >= 0),
  alert_dispatched BOOLEAN NOT NULL DEFAULT FALSE,
  repair_dispatched BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (cardinality(reason_codes) <= 32),
  CHECK (status <> 'healthy' OR (cardinality(reason_codes) = 0 AND error_code IS NULL)),
  CHECK (status <> 'action_required' OR cardinality(reason_codes) > 0),
  CHECK (status NOT IN ('failed', 'abandoned') OR error_code IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS yutakasa_monitor_one_running_idx
  ON public.yutakasa_monitor_runs ((TRUE)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS yutakasa_monitor_finished_idx
  ON public.yutakasa_monitor_runs (finished_at) WHERE finished_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.acquire_yutakasa_monitor_run(p_run_id UUID, p_run_kind TEXT)
RETURNS TABLE (acquired BOOLEAN, lease_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_running public.yutakasa_monitor_runs%ROWTYPE;
  v_now TIMESTAMPTZ;
  v_expiry TIMESTAMPTZ;
BEGIN
  IF p_run_id IS NULL OR p_run_kind IS NULL OR p_run_kind NOT IN ('scheduled', 'recheck') THEN
    RAISE EXCEPTION 'invalid monitor acquisition input' USING ERRCODE = '22023';
  END IF;
  -- Serializes competing acquisitions even when no running row exists yet.
  PERFORM pg_catalog.pg_advisory_xact_lock(938237, 12001);
  v_now := clock_timestamp();
  SELECT r.* INTO v_running
    FROM public.yutakasa_monitor_runs AS r
    WHERE r.status = 'running'
    FOR UPDATE;
  IF FOUND THEN
    IF v_running.lease_expires_at > v_now THEN
      RETURN QUERY SELECT FALSE, v_running.lease_expires_at;
      RETURN;
    END IF;
    UPDATE public.yutakasa_monitor_runs AS r
      SET status = 'abandoned', finished_at = v_now, lease_expires_at = NULL,
          reason_codes = ARRAY['lease_expired']::TEXT[], error_code = 'lease_expired'
      WHERE r.run_id = v_running.run_id;
  END IF;
  v_expiry := v_now + INTERVAL '2 minutes';
  INSERT INTO public.yutakasa_monitor_runs
    (run_id, run_kind, started_at, last_heartbeat_at, lease_expires_at, status)
    VALUES (p_run_id, p_run_kind, v_now, v_now, v_expiry, 'running');
  RETURN QUERY SELECT TRUE, v_expiry;
END;
$$;

-- Dispatch happens after the scheduled observation is finalized and its lease
-- released, so GitHub's recheck can acquire the same lease without racing it.
CREATE OR REPLACE FUNCTION public.record_yutakasa_monitor_dispatch(
  p_run_id UUID,
  p_alert_dispatched BOOLEAN,
  p_repair_dispatched BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_count INTEGER;
BEGIN
  IF p_run_id IS NULL OR p_alert_dispatched IS NULL OR p_repair_dispatched IS NULL
    OR NOT (p_alert_dispatched OR p_repair_dispatched)
  THEN
    RAISE EXCEPTION 'invalid monitor dispatch input' USING ERRCODE = '22023';
  END IF;
  UPDATE public.yutakasa_monitor_runs AS r
    SET alert_dispatched = r.alert_dispatched OR p_alert_dispatched,
        repair_dispatched = r.repair_dispatched OR p_repair_dispatched
    WHERE r.run_id = p_run_id AND r.run_kind = 'scheduled'
      AND r.status IN ('action_required', 'failed');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_yutakasa_monitor_run(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_count INTEGER;
BEGIN
  UPDATE public.yutakasa_monitor_runs AS r
    SET last_heartbeat_at = v_now,
        lease_expires_at = v_now + INTERVAL '2 minutes'
    WHERE r.run_id = p_run_id AND r.status = 'running'
      AND r.lease_expires_at > v_now;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_yutakasa_monitor_run(
  p_run_id UUID,
  p_status TEXT,
  p_reason_codes TEXT[],
  p_error_code TEXT,
  p_deployment_id TEXT,
  p_queue_start_exact INTEGER,
  p_queue_final_exact INTEGER,
  p_drive_start_count INTEGER,
  p_drive_final_count INTEGER,
  p_alert_dispatched BOOLEAN,
  p_repair_dispatched BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_count INTEGER;
BEGIN
  IF p_run_id IS NULL
    OR p_status IS NULL OR p_status NOT IN ('healthy', 'action_required', 'failed')
    OR p_reason_codes IS NULL OR cardinality(p_reason_codes) > 32
    OR EXISTS (SELECT 1 FROM unnest(p_reason_codes) AS code
               WHERE code IS NULL OR code !~ '^[A-Za-z0-9][A-Za-z0-9_]{0,127}$')
    OR (p_status = 'healthy' AND (cardinality(p_reason_codes) <> 0 OR p_error_code IS NOT NULL))
    OR (p_status = 'action_required' AND cardinality(p_reason_codes) = 0)
    OR (p_status = 'failed' AND p_error_code IS NULL)
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[A-Za-z0-9][A-Za-z0-9_]{0,127}$')
    OR (p_deployment_id IS NOT NULL AND p_deployment_id !~ '^[A-Za-z0-9_-]{1,128}$')
    OR (p_queue_start_exact IS NOT NULL AND p_queue_start_exact < 0)
    OR (p_queue_final_exact IS NOT NULL AND p_queue_final_exact < 0)
    OR (p_drive_start_count IS NOT NULL AND p_drive_start_count < 0)
    OR (p_drive_final_count IS NOT NULL AND p_drive_final_count < 0)
    OR p_alert_dispatched IS NULL OR p_repair_dispatched IS NULL
  THEN
    RAISE EXCEPTION 'invalid monitor finish input' USING ERRCODE = '22023';
  END IF;
  UPDATE public.yutakasa_monitor_runs AS r
    SET status = p_status, finished_at = v_now, lease_expires_at = NULL,
        reason_codes = p_reason_codes, error_code = p_error_code,
        deployment_id = p_deployment_id,
        queue_start_exact = p_queue_start_exact,
        queue_final_exact = p_queue_final_exact,
        drive_start_count = p_drive_start_count,
        drive_final_count = p_drive_final_count,
        alert_dispatched = p_alert_dispatched,
        repair_dispatched = p_repair_dispatched
    WHERE r.run_id = p_run_id AND r.status = 'running'
      AND r.lease_expires_at > v_now;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

ALTER TABLE public.yutakasa_monitor_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.yutakasa_monitor_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.yutakasa_monitor_runs TO service_role;
REVOKE ALL ON FUNCTION public.acquire_yutakasa_monitor_run(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_yutakasa_monitor_run(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_yutakasa_monitor_dispatch(UUID, BOOLEAN, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_yutakasa_monitor_run(UUID, TEXT, TEXT[], TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_yutakasa_monitor_run(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_yutakasa_monitor_run(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_yutakasa_monitor_dispatch(UUID, BOOLEAN, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_yutakasa_monitor_run(UUID, TEXT, TEXT[], TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN)
  TO service_role;

COMMIT;
