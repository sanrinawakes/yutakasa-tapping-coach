BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='yutakasa_repair_releases'
      AND c.relrowsecurity) OR
    has_table_privilege('anon','public.yutakasa_repair_releases','SELECT') OR
    has_table_privilege('authenticated','public.yutakasa_repair_releases','SELECT') OR
    NOT has_table_privilege('service_role','public.yutakasa_repair_releases','SELECT') THEN
    RAISE EXCEPTION 'repair release ledger RLS/grants invalid';
  END IF;
END;
$$;
INSERT INTO public.yutakasa_repair_releases(pr_number,head_sha,status,error_code)
  VALUES (996,repeat('a',40),'abandoned','pending_merge_abandoned');
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
    997,repeat('b',40),'dpl_1234567890ABCDEF',clock_timestamp(),FALSE,'main_sha_changed',123456
  );
  IF v_receipt.status <> 'failed' OR v_receipt.healthy_count <> 0 THEN
    RAISE EXCEPTION 'superseded release did not leave the observer queue';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.yutakasa_repair_observations
    WHERE pr_number = 997 AND workflow_run_id = 123456 AND healthy = FALSE) THEN
    RAISE EXCEPTION 'scheduled observation receipt missing';
  END IF;
END;
$$;
DO $$
DECLARE
  v_receipt RECORD;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  INSERT INTO public.yutakasa_repair_releases(
    pr_number,head_sha,merge_sha,status,merge_recorded_at,deployment_id,
    first_healthy_at,last_healthy_at,healthy_count
  ) VALUES (
    998,repeat('c',40),repeat('d',40),'observing',v_now - INTERVAL '30 minutes',
    'dpl_OldDeployment1234',v_now - INTERVAL '20 minutes',
    v_now - INTERVAL '10 minutes',2
  );
  SELECT * INTO v_receipt FROM public.record_yutakasa_repair_observation(
    998,repeat('d',40),'dpl_NewDeployment1234',clock_timestamp(),TRUE,NULL,123457
  );
  IF v_receipt.status <> 'observing' OR v_receipt.healthy_count <> 1 THEN
    RAISE EXCEPTION 'deployment change incorrectly preserved healthy streak';
  END IF;

  INSERT INTO public.yutakasa_repair_releases(
    pr_number,head_sha,merge_sha,status,merge_recorded_at,deployment_id,
    first_healthy_at,last_healthy_at,healthy_count
  ) VALUES (
    999,repeat('e',40),repeat('f',40),'observing',v_now - INTERVAL '30 minutes',
    'dpl_SameDeployment1234',v_now - INTERVAL '20 minutes',
    v_now - INTERVAL '10 minutes',2
  );
  SELECT * INTO v_receipt FROM public.record_yutakasa_repair_observation(
    999,repeat('f',40),'dpl_SameDeployment1234',clock_timestamp(),TRUE,NULL,123458
  );
  IF v_receipt.status <> 'verified' OR v_receipt.healthy_count <> 3 THEN
    RAISE EXCEPTION 'same-deployment third observation did not verify';
  END IF;
END;
$$;
ROLLBACK;
