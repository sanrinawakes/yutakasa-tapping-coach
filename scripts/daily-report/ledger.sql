-- Internal Yutakasa daily report delivery ledger.
-- Apply with the Supabase SQL editor or a privileged migration connection.
-- Before 2026-09-18 JST the caller stores aggregate operational facts only.
-- From that report date, one owner-only snapshot may also include bounded,
-- redacted excerpts for tickets requiring an operator reply. Never put full
-- messages, attachments, or internal log bodies into this immutable ledger.

BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_daily_report_snapshots (
  report_date_jst DATE PRIMARY KEY,
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 30000),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.yutakasa_daily_report_deliveries (
  report_date_jst DATE NOT NULL REFERENCES public.yutakasa_daily_report_snapshots(report_date_jst),
  recipient TEXT NOT NULL CHECK (
    char_length(recipient) BETWEEN 5 AND 254
    AND recipient ~ '^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,63}$'
    AND recipient NOT LIKE '%..%'
    AND split_part(recipient, '@', 1) !~ '\.$'
  ),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  status TEXT NOT NULL CHECK (status IN ('sending', 'accepted', 'uncertain', 'failed')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  first_send_started_at TIMESTAMPTZ NOT NULL,
  last_send_started_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  provider_email_id TEXT CHECK (provider_email_id IS NULL OR char_length(provider_email_id) BETWEEN 1 AND 255),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_date_jst, recipient),
  UNIQUE (idempotency_key),
  CHECK ((status = 'sending') = (lease_expires_at IS NOT NULL)),
  CHECK (status <> 'accepted' OR provider_email_id IS NOT NULL),
  CHECK (status <> 'failed' OR provider_email_id IS NULL)
);

CREATE INDEX IF NOT EXISTS yutakasa_daily_report_deliveries_status_idx
  ON public.yutakasa_daily_report_deliveries(status, report_date_jst);

-- The date's subject/body/hash and a delivery's key are write-once, including
-- for a database client that bypasses the reservation RPC.
CREATE OR REPLACE FUNCTION public.guard_yutakasa_daily_report_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.report_date_jst IS DISTINCT FROM OLD.report_date_jst
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
  THEN
    RAISE EXCEPTION 'daily report snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_yutakasa_daily_report_snapshot_update
  ON public.yutakasa_daily_report_snapshots;
CREATE TRIGGER guard_yutakasa_daily_report_snapshot_update
BEFORE UPDATE ON public.yutakasa_daily_report_snapshots
FOR EACH ROW EXECUTE FUNCTION public.guard_yutakasa_daily_report_snapshot();

CREATE OR REPLACE FUNCTION public.guard_yutakasa_daily_report_delivery()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.report_date_jst IS DISTINCT FROM OLD.report_date_jst
    OR NEW.recipient IS DISTINCT FROM OLD.recipient
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.first_send_started_at IS DISTINCT FROM OLD.first_send_started_at
  THEN
    RAISE EXCEPTION 'daily report delivery identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_yutakasa_daily_report_delivery_update
  ON public.yutakasa_daily_report_deliveries;
CREATE TRIGGER guard_yutakasa_daily_report_delivery_update
BEFORE UPDATE ON public.yutakasa_daily_report_deliveries
FOR EACH ROW EXECUTE FUNCTION public.guard_yutakasa_daily_report_delivery();

-- A reservation owns a 15-minute lease. Once the lease expires, the old call
-- may still have reached Resend, so it becomes uncertain and is never resent.
-- Only an explicit, definitive 'failed' provider outcome permits another
-- reservation. The original snapshot and idempotency key stay unchanged.
CREATE OR REPLACE FUNCTION public.reserve_yutakasa_daily_report_delivery(
  p_report_date_jst DATE,
  p_recipient TEXT,
  p_subject TEXT,
  p_body TEXT,
  p_payload_sha256 TEXT,
  p_idempotency_key TEXT
)
RETURNS TABLE (
  can_send BOOLEAN,
  status TEXT,
  subject TEXT,
  body TEXT,
  idempotency_key TEXT,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_snapshot public.yutakasa_daily_report_snapshots%ROWTYPE;
  v_delivery public.yutakasa_daily_report_deliveries%ROWTYPE;
  v_insert_count INTEGER;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_can_send BOOLEAN := FALSE;
BEGIN
  IF p_report_date_jst IS NULL
    OR p_recipient IS NULL
    OR char_length(p_recipient) NOT BETWEEN 5 AND 254
    OR p_recipient !~ '^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,63}$'
    OR p_recipient LIKE '%..%'
    OR split_part(p_recipient, '@', 1) ~ '\.$'
    OR p_subject IS NULL OR char_length(p_subject) NOT BETWEEN 1 AND 200
    OR p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 30000
    OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
    OR p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 1 AND 255
  THEN
    RAISE EXCEPTION 'invalid daily report reservation input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.yutakasa_daily_report_snapshots
    (report_date_jst, subject, body, payload_sha256)
  VALUES (p_report_date_jst, p_subject, p_body, p_payload_sha256)
  ON CONFLICT (report_date_jst) DO NOTHING;

  SELECT s.* INTO STRICT v_snapshot
  FROM public.yutakasa_daily_report_snapshots AS s
  WHERE s.report_date_jst = p_report_date_jst;

  INSERT INTO public.yutakasa_daily_report_deliveries AS d
    (report_date_jst, recipient, idempotency_key, status, attempt_count,
     first_send_started_at, last_send_started_at, lease_expires_at)
  VALUES
    (p_report_date_jst, p_recipient, p_idempotency_key, 'sending', 1,
     v_now, v_now, v_now + INTERVAL '15 minutes')
  ON CONFLICT (report_date_jst, recipient) DO NOTHING;
  GET DIAGNOSTICS v_insert_count = ROW_COUNT;

  SELECT d.* INTO STRICT v_delivery
  FROM public.yutakasa_daily_report_deliveries AS d
  WHERE d.report_date_jst = p_report_date_jst
    AND d.recipient = p_recipient
  FOR UPDATE;

  IF v_insert_count = 1 THEN
    v_can_send := TRUE;
  ELSIF v_delivery.status = 'failed' THEN
    UPDATE public.yutakasa_daily_report_deliveries AS d
    SET status = 'sending',
        attempt_count = d.attempt_count + 1,
        last_send_started_at = v_now,
        lease_expires_at = v_now + INTERVAL '15 minutes',
        error_code = NULL,
        updated_at = v_now
    WHERE d.report_date_jst = p_report_date_jst
      AND d.recipient = p_recipient
    RETURNING d.* INTO STRICT v_delivery;
    v_can_send := TRUE;
  ELSIF v_delivery.status = 'sending' AND v_delivery.lease_expires_at <= v_now THEN
    UPDATE public.yutakasa_daily_report_deliveries AS d
    SET status = 'uncertain',
        lease_expires_at = NULL,
        error_code = 'lease_expired',
        updated_at = v_now
    WHERE d.report_date_jst = p_report_date_jst
      AND d.recipient = p_recipient
    RETURNING d.* INTO STRICT v_delivery;
  END IF;

  RETURN QUERY SELECT v_can_send, v_delivery.status, v_snapshot.subject,
                      v_snapshot.body, v_delivery.idempotency_key,
                      v_delivery.attempt_count;
END;
$$;

-- A late provider receipt can reconcile an uncertain attempt to accepted.
-- An uncertain attempt cannot become failed here: that would enable a retry
-- after an ambiguous send. Manual investigation is required in that case.
CREATE OR REPLACE FUNCTION public.finish_yutakasa_daily_report_delivery(
  p_report_date_jst DATE,
  p_recipient TEXT,
  p_idempotency_key TEXT,
  p_attempt_count INTEGER,
  p_status TEXT,
  p_provider_email_id TEXT,
  p_error_code TEXT
)
RETURNS TABLE (
  status TEXT,
  provider_email_id TEXT,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_delivery public.yutakasa_daily_report_deliveries%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_report_date_jst IS NULL
    OR p_recipient IS NULL
    OR p_idempotency_key IS NULL
    OR p_attempt_count IS NULL OR p_attempt_count < 1
    OR p_status IS NULL OR p_status NOT IN ('accepted', 'uncertain', 'failed')
    OR (p_status = 'accepted' AND (p_provider_email_id IS NULL OR char_length(p_provider_email_id) NOT BETWEEN 1 AND 255))
    OR (p_status <> 'accepted' AND p_provider_email_id IS NOT NULL)
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9][a-z0-9._-]{0,127}$')
  THEN
    RAISE EXCEPTION 'invalid daily report finish input' USING ERRCODE = '22023';
  END IF;

  SELECT d.* INTO STRICT v_delivery
  FROM public.yutakasa_daily_report_deliveries AS d
  WHERE d.report_date_jst = p_report_date_jst
    AND d.recipient = p_recipient
  FOR UPDATE;

  IF v_delivery.idempotency_key <> p_idempotency_key
    OR v_delivery.attempt_count <> p_attempt_count
  THEN
    RAISE EXCEPTION 'daily report attempt does not match reservation' USING ERRCODE = '22023';
  END IF;

  IF v_delivery.status = 'accepted' THEN
    IF p_status = 'accepted'
      AND v_delivery.provider_email_id IS DISTINCT FROM p_provider_email_id
    THEN
      RAISE EXCEPTION 'daily report provider receipt does not match accepted delivery'
        USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_delivery.status, v_delivery.provider_email_id,
                        v_delivery.attempt_count;
    RETURN;
  END IF;

  IF v_delivery.status = p_status THEN
    RETURN QUERY SELECT v_delivery.status, v_delivery.provider_email_id,
                        v_delivery.attempt_count;
    RETURN;
  END IF;

  IF v_delivery.status <> 'sending'
    AND NOT (v_delivery.status = 'uncertain' AND p_status = 'accepted')
  THEN
    RAISE EXCEPTION 'daily report delivery cannot transition from % to %',
      v_delivery.status, p_status USING ERRCODE = '22023';
  END IF;

  UPDATE public.yutakasa_daily_report_deliveries AS d
  SET status = p_status,
      lease_expires_at = NULL,
      provider_email_id = p_provider_email_id,
      error_code = p_error_code,
      updated_at = v_now
  WHERE d.report_date_jst = p_report_date_jst
    AND d.recipient = p_recipient
  RETURNING d.* INTO STRICT v_delivery;

  RETURN QUERY SELECT v_delivery.status, v_delivery.provider_email_id,
                      v_delivery.attempt_count;
END;
$$;

ALTER TABLE public.yutakasa_daily_report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.yutakasa_daily_report_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.yutakasa_daily_report_snapshots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.yutakasa_daily_report_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.yutakasa_daily_report_snapshots TO service_role;
GRANT SELECT ON TABLE public.yutakasa_daily_report_deliveries TO service_role;

REVOKE ALL ON FUNCTION public.guard_yutakasa_daily_report_snapshot() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_yutakasa_daily_report_delivery() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_yutakasa_daily_report_delivery(DATE, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_yutakasa_daily_report_delivery(DATE, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_yutakasa_daily_report_delivery(DATE, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_yutakasa_daily_report_delivery(DATE, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT)
  TO service_role;

COMMIT;
