-- Local fixture only. Every row made here is rolled back.
BEGIN;

DO $$
DECLARE
  v_run UUID;
  v_email TEXT;
  v_account public.subscribers%ROWTYPE;
  v_ticket public.support_tickets%ROWTYPE;
  v_claim public.support_tickets%ROWTYPE;
  v_work UUID;
  v_lock UUID;
  v_user_message UUID;
  v_ticket_id UUID;
  v_deleted RECORD;
  v_rejected BOOLEAN;
  v_case INTEGER;
BEGIN
  IF NOT has_function_privilege('service_role',
      'public.cleanup_yutakasa_ticket_terra_issue_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid,bigint)',
      'EXECUTE') OR
     has_function_privilege('anon',
      'public.cleanup_yutakasa_ticket_terra_issue_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid,bigint)',
      'EXECUTE') OR
     has_function_privilege('authenticated',
      'public.cleanup_yutakasa_ticket_terra_issue_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid,bigint)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'Terra ticket cleanup grant invalid';
  END IF;

  FOR v_case IN 1..7 LOOP
    v_run := gen_random_uuid();
    v_email := 'yutakasa-auto-smoke+' || v_run::TEXT || '@example.invalid';
    v_work := gen_random_uuid();
    v_lock := gen_random_uuid();
    INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
      VALUES(v_email,'System monitor test identity (no customer, no payment)',
        'active','active',jsonb_build_object(
          'automation_test_identity','yutakasa-ai-repair-smoke-v1',
          'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT))
      RETURNING * INTO v_account;
    SELECT ticket_id INTO v_ticket_id FROM public.create_support_ticket_with_message(
      v_email,'technical','__YUTAKASA_AI_REPAIR_SMOKE_V1__ support',
      '__YUTAKASA_AI_REPAIR_SMOKE_V1__ technical support route check',
      gen_random_uuid(),FALSE,'[]'::jsonb);
    SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
    SELECT id INTO v_user_message FROM public.support_messages
      WHERE ticket_id=v_ticket.id AND sender_type='user';
    SELECT * INTO v_claim FROM public.claim_support_ticket_with_log(v_ticket.id,v_lock);
    PERFORM * FROM public.begin_yutakasa_ticket_repair(
      v_ticket.id,v_lock,v_user_message,v_claim.updated_at,v_work);
    SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
    IF v_case IN (2,3,4,5,6,7) THEN
      PERFORM public.claim_yutakasa_ticket_repair_context(v_work,
        CASE WHEN v_case=4 THEN 124 ELSE 123 END);
    END IF;
    IF v_case IN (3,7) THEN
      PERFORM * FROM public.fail_yutakasa_ticket_repair_work(
        v_work,123,'synthetic_terra_issue_probe');
      SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
    END IF;
    IF v_case=5 THEN
      UPDATE public.yutakasa_ticket_repair_jobs
        SET pr_number=98765, head_sha=repeat('a',40) WHERE work_id=v_work;
    ELSIF v_case=6 THEN
      UPDATE public.subscribers SET subscription_last_event_at=clock_timestamp()
        WHERE id=v_account.id;
    ELSIF v_case=7 THEN
      INSERT INTO public.support_messages(ticket_id,sender_type,sender_email,body,
        client_request_id)
        VALUES(v_ticket_id,'admin','operator@example.invalid','Changed by operator',
          gen_random_uuid());
    END IF;
    v_rejected := FALSE;
    BEGIN
      SELECT * INTO v_deleted FROM public.cleanup_yutakasa_ticket_terra_issue_smoke(
        v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
        v_work,v_lock,123);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := TRUE;
    END;
    IF v_case IN (4,5,6,7) THEN
      IF NOT v_rejected OR NOT EXISTS(SELECT 1 FROM public.support_tickets
          WHERE id=v_ticket_id) OR NOT EXISTS(SELECT 1 FROM public.subscribers
          WHERE id=v_account.id) OR NOT EXISTS(
          SELECT 1 FROM public.yutakasa_ticket_repair_jobs WHERE work_id=v_work) THEN
        RAISE EXCEPTION 'changed synthetic row deleted in case %',v_case;
      END IF;
    ELSE
      IF v_rejected OR NOT v_deleted.ticket_deleted OR NOT v_deleted.subscriber_deleted OR
         EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket_id) OR
         EXISTS(SELECT 1 FROM public.subscribers WHERE id=v_account.id) OR
         EXISTS(SELECT 1 FROM public.support_messages WHERE ticket_id=v_ticket_id) OR
         EXISTS(SELECT 1 FROM public.support_work_logs WHERE ticket_id=v_ticket_id) OR
         EXISTS(SELECT 1 FROM public.yutakasa_ticket_repair_jobs WHERE work_id=v_work) THEN
        RAISE EXCEPTION 'Terra ticket cleanup incomplete in case %',v_case;
      END IF;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
