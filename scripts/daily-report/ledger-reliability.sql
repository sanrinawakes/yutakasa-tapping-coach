-- Apply after ledger.sql. The cursor records the oldest calendar day that has
-- not yet been attempted for both configured recipients. Delivery rows retain
-- failed and uncertain days after the cursor advances.
BEGIN;

ALTER TABLE public.yutakasa_daily_report_deliveries
  ADD COLUMN IF NOT EXISTS provider_last_event TEXT
    CHECK (provider_last_event IN (
      'bounced', 'canceled', 'clicked', 'complained', 'delivered',
      'delivery_delayed', 'failed', 'opened', 'queued', 'scheduled',
      'sent', 'suppressed'
    )),
  ADD COLUMN IF NOT EXISTS provider_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS yutakasa_daily_report_provider_check_idx
  ON public.yutakasa_daily_report_deliveries(provider_checked_at, report_date_jst)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS yutakasa_daily_report_provider_adverse_idx
  ON public.yutakasa_daily_report_deliveries(recipient, report_date_jst)
  WHERE provider_last_event IN ('bounced', 'canceled', 'complained', 'failed', 'suppressed');

CREATE TABLE IF NOT EXISTS public.yutakasa_daily_report_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  next_report_date_jst DATE NOT NULL CHECK (next_report_date_jst >= DATE '2026-09-16'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.yutakasa_daily_report_state (id, next_report_date_jst)
VALUES (1, DATE '2026-09-16')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.yutakasa_daily_report_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.yutakasa_daily_report_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.yutakasa_daily_report_state TO service_role;

CREATE OR REPLACE FUNCTION public.advance_yutakasa_daily_report_cursor(
  p_report_date_jst DATE,
  p_recipient_1 TEXT,
  p_recipient_2 TEXT
)
RETURNS TABLE (next_report_date_jst DATE, advanced BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_current DATE;
  v_ready_count INTEGER;
BEGIN
  IF p_report_date_jst IS NULL OR p_report_date_jst < DATE '2026-09-16'
    OR p_recipient_1 IS NULL OR p_recipient_2 IS NULL
    OR p_recipient_1 = p_recipient_2
  THEN
    RAISE EXCEPTION 'invalid daily report cursor input' USING ERRCODE = '22023';
  END IF;

  SELECT s.next_report_date_jst INTO STRICT v_current
  FROM public.yutakasa_daily_report_state AS s
  WHERE s.id = 1 FOR UPDATE;

  IF v_current <> p_report_date_jst THEN
    RETURN QUERY SELECT v_current, FALSE;
    RETURN;
  END IF;

  SELECT count(*) INTO v_ready_count
  FROM public.yutakasa_daily_report_deliveries AS d
  WHERE d.report_date_jst = p_report_date_jst
    AND d.recipient IN (p_recipient_1, p_recipient_2)
    AND d.status IN ('accepted', 'failed', 'uncertain');

  IF v_ready_count <> 2 THEN
    RETURN QUERY SELECT v_current, FALSE;
    RETURN;
  END IF;

  UPDATE public.yutakasa_daily_report_state AS s
  SET next_report_date_jst = p_report_date_jst + 1,
      updated_at = clock_timestamp()
  WHERE s.id = 1;

  RETURN QUERY SELECT p_report_date_jst + 1, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_yutakasa_daily_report_cursor(DATE, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_yutakasa_daily_report_cursor(DATE, TEXT, TEXT)
  TO service_role;

-- A worker can disappear after reserving a send. Expire only a bounded batch
-- per cron invocation, and never retry a possibly submitted email.
CREATE OR REPLACE FUNCTION public.expire_yutakasa_daily_report_leases()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH due AS (
    SELECT d.report_date_jst, d.recipient
    FROM public.yutakasa_daily_report_deliveries AS d
    WHERE d.status = 'sending' AND d.lease_expires_at <= clock_timestamp()
    ORDER BY d.report_date_jst, d.recipient
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.yutakasa_daily_report_deliveries AS d
  SET status = 'uncertain', lease_expires_at = NULL,
      error_code = 'lease_expired', updated_at = clock_timestamp()
  FROM due
  WHERE d.report_date_jst = due.report_date_jst AND d.recipient = due.recipient;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_yutakasa_daily_report_leases()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_yutakasa_daily_report_leases()
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_yutakasa_daily_report_provider_event(
  p_report_date_jst DATE,
  p_recipient TEXT,
  p_provider_email_id TEXT,
  p_last_event TEXT
)
RETURNS TABLE (provider_last_event TEXT, provider_checked_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_report_date_jst IS NULL OR p_recipient IS NULL
    OR p_provider_email_id IS NULL OR p_last_event IS NULL
    OR p_last_event NOT IN (
      'bounced', 'canceled', 'clicked', 'complained', 'delivered',
      'delivery_delayed', 'failed', 'opened', 'queued', 'scheduled',
      'sent', 'suppressed'
    )
  THEN
    RAISE EXCEPTION 'invalid provider event' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.yutakasa_daily_report_deliveries AS d
  SET provider_last_event = p_last_event,
      provider_checked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE d.report_date_jst = p_report_date_jst
    AND d.recipient = p_recipient
    AND d.provider_email_id = p_provider_email_id
    AND d.status = 'accepted'
  RETURNING d.provider_last_event, d.provider_checked_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted provider receipt not found' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_yutakasa_daily_report_provider_event(DATE, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_yutakasa_daily_report_provider_event(DATE, TEXT, TEXT, TEXT)
  TO service_role;

-- An unresolved old date must remain visible after the daily cursor moves on.
CREATE OR REPLACE FUNCTION public.get_yutakasa_daily_report_health(
  p_recipient_1 TEXT,
  p_recipient_2 TEXT
)
RETURNS TABLE (
  uncertain_count BIGINT,
  failed_count BIGINT,
  provider_adverse_count BIGINT,
  pending_overdue_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_recipient_1 IS NULL OR p_recipient_2 IS NULL
    OR p_recipient_1 = p_recipient_2 THEN
    RAISE EXCEPTION 'invalid daily report recipients' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT count(*) FILTER (WHERE d.status = 'uncertain'),
         count(*) FILTER (WHERE d.status = 'failed'),
         count(*) FILTER (WHERE d.provider_last_event IN (
           'bounced', 'canceled', 'complained', 'failed', 'suppressed')),
         count(*) FILTER (WHERE d.status = 'accepted'
           AND d.last_send_started_at <= clock_timestamp() - INTERVAL '2 hours'
           AND (d.provider_last_event IS NULL OR d.provider_last_event IN (
             'queued', 'sent', 'scheduled', 'delivery_delayed')))
  FROM public.yutakasa_daily_report_deliveries AS d
  WHERE d.recipient IN (p_recipient_1, p_recipient_2);
END;
$$;

REVOKE ALL ON FUNCTION public.get_yutakasa_daily_report_health(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_yutakasa_daily_report_health(TEXT, TEXT)
  TO service_role;

COMMIT;
