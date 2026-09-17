-- Metadata-only evidence for automated source repairs. No ticket IDs or content.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_repair_releases (
  pr_number INTEGER PRIMARY KEY CHECK (pr_number > 0),
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  merge_sha TEXT UNIQUE CHECK (merge_sha IS NULL OR merge_sha ~ '^[a-f0-9]{40}$'),
  status TEXT NOT NULL CHECK (status IN ('pending_merge', 'observing', 'verified', 'failed', 'abandoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  merge_recorded_at TIMESTAMPTZ,
  deployment_id TEXT CHECK (deployment_id IS NULL OR deployment_id ~ '^dpl_[A-Za-z0-9]{8,160}$'),
  first_healthy_at TIMESTAMPTZ,
  last_healthy_at TIMESTAMPTZ,
  healthy_count INTEGER NOT NULL DEFAULT 0 CHECK (healthy_count >= 0),
  verified_at TIMESTAMPTZ,
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,100}$'),
  CHECK ((status IN ('pending_merge', 'abandoned')) = (merge_sha IS NULL)),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CHECK ((healthy_count = 0) = (first_healthy_at IS NULL AND last_healthy_at IS NULL)),
  CHECK ((healthy_count > 0) = (first_healthy_at IS NOT NULL AND last_healthy_at IS NOT NULL))
);

-- A ticket release records the completed before/after run selected at the
-- merge gate, so the production proof runner cannot choose a different run.
ALTER TABLE public.yutakasa_repair_releases
  ADD COLUMN IF NOT EXISTS ticket_before_after_run_id BIGINT UNIQUE
    CHECK (ticket_before_after_run_id IS NULL OR ticket_before_after_run_id > 0);
ALTER TABLE public.yutakasa_repair_releases
  ADD COLUMN IF NOT EXISTS ticket_regression_artifact_sha256 TEXT
    CHECK (ticket_regression_artifact_sha256 IS NULL OR
      ticket_regression_artifact_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE public.yutakasa_repair_releases
  DROP CONSTRAINT IF EXISTS yutakasa_repair_releases_ticket_provenance_pair_check;
ALTER TABLE public.yutakasa_repair_releases
  ADD CONSTRAINT yutakasa_repair_releases_ticket_provenance_pair_check
  CHECK ((ticket_before_after_run_id IS NULL) =
    (ticket_regression_artifact_sha256 IS NULL));

CREATE OR REPLACE FUNCTION public.lock_yutakasa_ticket_regression_provenance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.ticket_before_after_run_id IS NOT NULL AND
    (NEW.ticket_before_after_run_id IS DISTINCT FROM OLD.ticket_before_after_run_id OR
     NEW.ticket_regression_artifact_sha256 IS DISTINCT FROM OLD.ticket_regression_artifact_sha256)
    THEN RAISE EXCEPTION 'ticket regression provenance is immutable' USING ERRCODE='P0001';
  END IF;
  IF OLD.status<>'pending_merge' AND
    (NEW.ticket_before_after_run_id IS DISTINCT FROM OLD.ticket_before_after_run_id OR
     NEW.ticket_regression_artifact_sha256 IS DISTINCT FROM OLD.ticket_regression_artifact_sha256)
    THEN RAISE EXCEPTION 'ticket regression provenance added after merge' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS lock_yutakasa_ticket_regression_provenance
  ON public.yutakasa_repair_releases;
CREATE TRIGGER lock_yutakasa_ticket_regression_provenance
  BEFORE UPDATE OF ticket_before_after_run_id,ticket_regression_artifact_sha256
  ON public.yutakasa_repair_releases
  FOR EACH ROW EXECUTE FUNCTION public.lock_yutakasa_ticket_regression_provenance();

CREATE TABLE IF NOT EXISTS public.yutakasa_repair_observations (
  pr_number INTEGER NOT NULL REFERENCES public.yutakasa_repair_releases(pr_number) ON DELETE CASCADE,
  workflow_run_id BIGINT NOT NULL CHECK (workflow_run_id > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  cron_slot BIGINT NOT NULL,
  deployment_id TEXT,
  healthy BOOLEAN NOT NULL,
  error_code TEXT,
  PRIMARY KEY (pr_number, workflow_run_id),
  UNIQUE (pr_number, cron_slot)
);

CREATE OR REPLACE FUNCTION public.record_yutakasa_repair_observation(
  p_pr_number INTEGER,
  p_merge_sha TEXT,
  p_deployment_id TEXT,
  p_observed_at TIMESTAMPTZ,
  p_healthy BOOLEAN,
  p_error_code TEXT,
  p_workflow_run_id BIGINT
)
RETURNS TABLE (status TEXT, healthy_count INTEGER, verified_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_release public.yutakasa_repair_releases%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_first TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  IF p_pr_number IS NULL OR p_merge_sha IS NULL OR p_merge_sha !~ '^[a-f0-9]{40}$'
    OR (p_healthy AND (p_deployment_id IS NULL OR p_deployment_id !~ '^dpl_[A-Za-z0-9]{8,160}$'))
    OR (NOT p_healthy AND p_deployment_id IS NOT NULL AND p_deployment_id !~ '^dpl_[A-Za-z0-9]{8,160}$')
    OR p_observed_at IS NULL OR abs(extract(epoch FROM (v_now - p_observed_at))) > 120
    OR p_workflow_run_id IS NULL OR p_workflow_run_id < 1
    OR p_healthy IS NULL OR (p_healthy AND p_error_code IS NOT NULL)
    OR (NOT p_healthy AND (p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_]{0,100}$'))
  THEN
    RAISE EXCEPTION 'invalid repair observation' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_release FROM public.yutakasa_repair_releases r
    WHERE r.pr_number = p_pr_number FOR UPDATE;
  IF NOT FOUND OR v_release.status <> 'observing' OR v_release.merge_sha <> p_merge_sha THEN
    RAISE EXCEPTION 'repair release not observing' USING ERRCODE = '22023';
  END IF;
  IF v_release.last_healthy_at IS NOT NULL AND p_observed_at <= v_release.last_healthy_at THEN
    RAISE EXCEPTION 'repair observation not newer' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.yutakasa_repair_observations(
    pr_number,workflow_run_id,observed_at,cron_slot,deployment_id,healthy,error_code
  ) VALUES (
    p_pr_number,p_workflow_run_id,p_observed_at,
    floor(extract(epoch FROM p_observed_at) / 600)::BIGINT,
    p_deployment_id,p_healthy,p_error_code
  );
  IF NOT p_healthy THEN
    UPDATE public.yutakasa_repair_releases r
      SET first_healthy_at = NULL, last_healthy_at = NULL, healthy_count = 0,
          status = 'failed', error_code = p_error_code
      WHERE r.pr_number = p_pr_number;
  ELSE
    -- GitHub runs may be delayed. Only adjacent UTC ten-minute cron slots can
    -- count as consecutive; an unrecorded failed/missed slot breaks the chain.
    IF v_release.last_healthy_at IS NULL OR
       v_release.deployment_id IS DISTINCT FROM p_deployment_id OR
       floor(extract(epoch FROM p_observed_at) / 600) <>
       floor(extract(epoch FROM v_release.last_healthy_at) / 600) + 1 THEN
      v_first := p_observed_at;
      v_count := 1;
    ELSE
      v_first := v_release.first_healthy_at;
      v_count := v_release.healthy_count + 1;
    END IF;
    UPDATE public.yutakasa_repair_releases r
      SET first_healthy_at = v_first,
          last_healthy_at = p_observed_at,
          healthy_count = v_count,
          deployment_id = p_deployment_id,
          status = CASE WHEN v_count >= 3 AND p_observed_at - v_first >= INTERVAL '20 minutes'
                   THEN 'verified' ELSE 'observing' END,
          verified_at = CASE WHEN v_count >= 3 AND p_observed_at - v_first >= INTERVAL '20 minutes'
                        THEN p_observed_at ELSE NULL END,
          error_code = NULL
      WHERE r.pr_number = p_pr_number;
  END IF;
  RETURN QUERY SELECT r.status, r.healthy_count, r.verified_at
    FROM public.yutakasa_repair_releases r WHERE r.pr_number = p_pr_number;
END;
$$;

REVOKE ALL ON public.yutakasa_repair_releases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_yutakasa_ticket_regression_provenance()
  FROM PUBLIC, anon, authenticated;
ALTER TABLE public.yutakasa_repair_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.yutakasa_repair_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_repair_observations FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.record_yutakasa_repair_observation(INTEGER,TEXT,TEXT,TIMESTAMPTZ,BOOLEAN,TEXT);
REVOKE ALL ON FUNCTION public.record_yutakasa_repair_observation(INTEGER,TEXT,TEXT,TIMESTAMPTZ,BOOLEAN,TEXT,BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.yutakasa_repair_releases TO service_role;
GRANT SELECT ON public.yutakasa_repair_observations TO service_role;
GRANT EXECUTE ON FUNCTION public.record_yutakasa_repair_observation(INTEGER,TEXT,TEXT,TIMESTAMPTZ,BOOLEAN,TEXT,BIGINT)
  TO service_role;

COMMIT;
