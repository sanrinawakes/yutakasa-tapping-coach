-- Local synthetic fixture; the outer transaction rolls back all rows.
BEGIN;

DO $$
DECLARE
  v_run UUID;
  v_email TEXT;
  v_account public.subscribers%ROWTYPE;
  v_ticket public.support_tickets%ROWTYPE;
  v_ticket_id UUID;
  v_claim public.support_tickets%ROWTYPE;
  v_work UUID;
  v_lock UUID;
  v_request UUID;
  v_user_message UUID;
  v_deleted RECORD;
  v_rejected BOOLEAN;
  v_case INTEGER;
BEGIN
  IF NOT has_function_privilege('service_role',
      'public.cleanup_yutakasa_ticket_handoff_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid)',
      'EXECUTE') OR
     has_function_privilege('anon',
      'public.cleanup_yutakasa_ticket_handoff_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid)',
      'EXECUTE') OR
     has_function_privilege('authenticated',
      'public.cleanup_yutakasa_ticket_handoff_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'synthetic cleanup RPC grant invalid';
  END IF;

  FOR v_case IN 1..7 LOOP
    v_run := gen_random_uuid();
    v_email := 'yutakasa-auto-smoke+' || v_run::TEXT || '@example.invalid';
    v_work := gen_random_uuid();
    v_lock := gen_random_uuid();
    v_request := gen_random_uuid();
    v_ticket_id := NULL;
    v_ticket := NULL;
    v_claim := NULL;
    INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
      VALUES(v_email,'System monitor test identity (no customer, no payment)',
        'active','active',jsonb_build_object(
          'automation_test_identity','yutakasa-ai-repair-smoke-v1',
          'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT))
      RETURNING * INTO v_account;
    IF v_case<>6 THEN
      SELECT ticket_id INTO v_ticket_id FROM public.create_support_ticket_with_message(
        v_email,'technical','__YUTAKASA_AI_REPAIR_SMOKE_V1__ support',
        '__YUTAKASA_AI_REPAIR_SMOKE_V1__ technical support route check',
        v_request,FALSE,'[]'::jsonb);
      SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
      SELECT id INTO v_user_message FROM public.support_messages
        WHERE ticket_id=v_ticket.id AND sender_type='user';
    END IF;
    IF v_case IN (1,2,3,5,7) THEN
      SELECT * INTO v_claim FROM public.claim_support_ticket_with_log(v_ticket.id,v_lock);
      SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
    END IF;
    IF v_case IN (1,2,3,7) THEN
      PERFORM * FROM public.begin_yutakasa_ticket_repair(
        v_ticket.id,v_lock,v_user_message,v_claim.updated_at,v_work);
      SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
    END IF;
    v_rejected := FALSE;
    IF v_case=2 THEN
      -- The AI claim changes only the job; ticket timestamp remains equal.
      PERFORM public.claim_yutakasa_ticket_repair_context(v_work,123);
    ELSIF v_case=3 THEN
      -- Payment/sync metadata may change without touching account.updated_at.
      UPDATE public.subscribers SET subscription_last_event_at=clock_timestamp()
        WHERE id=v_account.id;
    ELSIF v_case=7 THEN
      -- A missing job leaves ticket awaiting_repair; NULL must never pass
      -- the three-phase eligibility expression.
      DELETE FROM public.yutakasa_ticket_repair_jobs WHERE work_id=v_work;
    END IF;
    BEGIN
      SELECT * INTO v_deleted FROM public.cleanup_yutakasa_ticket_handoff_smoke(
        v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
        v_work,v_lock);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := TRUE;
    END;
    IF v_case IN (2,3,7) THEN
      IF NOT v_rejected OR NOT EXISTS(SELECT 1 FROM public.support_tickets
          WHERE id=v_ticket.id) OR NOT EXISTS(SELECT 1 FROM public.subscribers
          WHERE id=v_account.id) OR
          (v_case<>7 AND NOT EXISTS(SELECT 1 FROM public.yutakasa_ticket_repair_jobs
          WHERE work_id=v_work)) THEN
        RAISE EXCEPTION 'changed synthetic row was deleted in case %',v_case;
      END IF;
    ELSE
      IF v_rejected OR v_deleted.ticket_deleted IS DISTINCT FROM (v_case<>6) OR
         NOT v_deleted.subscriber_deleted OR
         EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket.id) OR
         EXISTS(SELECT 1 FROM public.subscribers WHERE id=v_account.id) OR
         EXISTS(SELECT 1 FROM public.support_messages WHERE ticket_id=v_ticket.id) OR
         EXISTS(SELECT 1 FROM public.support_work_logs WHERE ticket_id=v_ticket.id) OR
         EXISTS(SELECT 1 FROM public.yutakasa_ticket_repair_jobs WHERE work_id=v_work) THEN
        RAISE EXCEPTION 'synthetic cleanup incomplete in case %',v_case;
      END IF;
      IF v_case=6 THEN
        SELECT * INTO v_deleted FROM public.cleanup_yutakasa_ticket_handoff_smoke(
          v_run,NULL,NULL,NULL,NULL,v_work,v_lock);
        IF v_deleted.ticket_deleted OR v_deleted.subscriber_deleted THEN
          RAISE EXCEPTION 'empty synthetic cleanup was not idempotent';
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
