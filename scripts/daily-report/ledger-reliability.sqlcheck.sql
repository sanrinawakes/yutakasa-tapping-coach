DO $$
DECLARE
  v_cursor RECORD;
  v_reserved RECORD;
  v_expired INTEGER;
  v_provider RECORD;
  v_health RECORD;
BEGIN
  IF NOT has_table_privilege('service_role', 'public.yutakasa_daily_report_state', 'SELECT')
    OR has_table_privilege('anon', 'public.yutakasa_daily_report_state', 'SELECT')
    OR has_function_privilege('anon', 'public.expire_yutakasa_daily_report_leases()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'daily report state permissions invalid';
  END IF;

  SELECT * INTO v_cursor FROM public.advance_yutakasa_daily_report_cursor(
    DATE '2026-09-16', 'one@example.com', 'two@example.com');
  IF v_cursor.advanced OR v_cursor.next_report_date_jst <> DATE '2026-09-16' THEN
    RAISE EXCEPTION 'cursor advanced before deliveries existed';
  END IF;

  SELECT * INTO v_reserved FROM public.reserve_yutakasa_daily_report_delivery(
    DATE '2026-09-16', 'one@example.com', 'Daily report', 'Report body',
    repeat('a', 64), 'daily-test-one');
  IF NOT v_reserved.can_send OR v_reserved.status <> 'sending' THEN
    RAISE EXCEPTION 'first reservation failed';
  END IF;
  SELECT * INTO v_reserved FROM public.reserve_yutakasa_daily_report_delivery(
    DATE '2026-09-16', 'two@example.com', 'Daily report', 'Report body',
    repeat('a', 64), 'daily-test-two');
  IF NOT v_reserved.can_send OR v_reserved.status <> 'sending' THEN
    RAISE EXCEPTION 'second reservation failed';
  END IF;

  SELECT * INTO v_cursor FROM public.advance_yutakasa_daily_report_cursor(
    DATE '2026-09-16', 'one@example.com', 'two@example.com');
  IF v_cursor.advanced THEN
    RAISE EXCEPTION 'cursor advanced while sends were in progress';
  END IF;

  UPDATE public.yutakasa_daily_report_deliveries
  SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
  WHERE report_date_jst = DATE '2026-09-16';
  SELECT public.expire_yutakasa_daily_report_leases() INTO v_expired;
  IF v_expired <> 2 THEN
    RAISE EXCEPTION 'expected two expired leases, got %', v_expired;
  END IF;

  SELECT * INTO v_reserved FROM public.reserve_yutakasa_daily_report_delivery(
    DATE '2026-09-16', 'one@example.com', 'Daily report', 'Report body',
    repeat('a', 64), 'daily-test-one');
  IF v_reserved.can_send OR v_reserved.status <> 'uncertain' THEN
    RAISE EXCEPTION 'expired lease permitted an unsafe resend';
  END IF;

  SELECT * INTO v_cursor FROM public.advance_yutakasa_daily_report_cursor(
    DATE '2026-09-16', 'one@example.com', 'two@example.com');
  IF NOT v_cursor.advanced OR v_cursor.next_report_date_jst <> DATE '2026-09-17' THEN
    RAISE EXCEPTION 'cursor did not advance after terminal outcomes';
  END IF;
  SELECT * INTO v_cursor FROM public.advance_yutakasa_daily_report_cursor(
    DATE '2026-09-16', 'one@example.com', 'two@example.com');
  IF v_cursor.advanced OR v_cursor.next_report_date_jst <> DATE '2026-09-17' THEN
    RAISE EXCEPTION 'cursor advanced twice for one date';
  END IF;

  SELECT * INTO v_reserved FROM public.reserve_yutakasa_daily_report_delivery(
    DATE '2026-09-17', 'one@example.com', 'Next report', 'Next body',
    repeat('b', 64), 'daily-test-next');
  PERFORM public.finish_yutakasa_daily_report_delivery(
    DATE '2026-09-17', 'one@example.com', 'daily-test-next', 1,
    'accepted', '44444444-4444-4444-8444-444444444444', NULL);
  SELECT * INTO v_provider FROM public.record_yutakasa_daily_report_provider_event(
    DATE '2026-09-17', 'one@example.com',
    '44444444-4444-4444-8444-444444444444', 'bounced');
  IF v_provider.provider_last_event <> 'bounced' OR v_provider.provider_checked_at IS NULL THEN
    RAISE EXCEPTION 'provider event was not persisted';
  END IF;
  IF has_function_privilege('anon',
    'public.record_yutakasa_daily_report_provider_event(date,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'provider event write is publicly accessible';
  END IF;
  SELECT * INTO v_reserved FROM public.reserve_yutakasa_daily_report_delivery(
    DATE '2026-09-18', 'one@example.com', 'Third report', 'Third body',
    repeat('c', 64), 'daily-test-third');
  PERFORM public.finish_yutakasa_daily_report_delivery(
    DATE '2026-09-18', 'one@example.com', 'daily-test-third', 1,
    'accepted', '55555555-5555-4555-8555-555555555555', NULL);
  PERFORM public.record_yutakasa_daily_report_provider_event(
    DATE '2026-09-18', 'one@example.com',
    '55555555-5555-4555-8555-555555555555', 'sent');
  UPDATE public.yutakasa_daily_report_deliveries
  SET last_send_started_at = clock_timestamp() - INTERVAL '3 hours'
  WHERE report_date_jst = DATE '2026-09-18' AND recipient = 'one@example.com';
  SELECT * INTO v_health FROM public.get_yutakasa_daily_report_health(
    'one@example.com', 'two@example.com');
  IF v_health.uncertain_count <> 2 OR v_health.failed_count <> 0
    OR v_health.provider_adverse_count <> 1 OR v_health.pending_overdue_count <> 1 THEN
    RAISE EXCEPTION 'persistent delivery health counts are wrong';
  END IF;
  IF has_function_privilege('anon',
    'public.get_yutakasa_daily_report_health(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'delivery health is publicly accessible';
  END IF;
END;
$$;
