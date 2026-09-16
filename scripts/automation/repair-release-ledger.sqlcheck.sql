BEGIN;
DO $$
DECLARE
  v_receipt RECORD;
BEGIN
  INSERT INTO public.yutakasa_repair_releases(
    pr_number,head_sha,merge_sha,status,merge_recorded_at,
    first_healthy_at,last_healthy_at,healthy_count
  ) VALUES (
    997,repeat('a',40),repeat('b',40),'observing',clock_timestamp(),
    clock_timestamp() - INTERVAL '10 minutes',
    clock_timestamp() - INTERVAL '10 minutes',1
  );
  SELECT * INTO v_receipt FROM public.record_yutakasa_repair_observation(
    997,repeat('b',40),'dpl_1234567890ABCDEF',clock_timestamp(),FALSE,'main_sha_changed'
  );
  IF v_receipt.status <> 'failed' OR v_receipt.healthy_count <> 0 THEN
    RAISE EXCEPTION 'superseded release did not leave the observer queue';
  END IF;
END;
$$;
ROLLBACK;
