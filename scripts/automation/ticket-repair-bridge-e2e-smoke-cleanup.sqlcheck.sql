-- Local synthetic rows only. The outer transaction rolls back every case.
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
  v_pr INTEGER;
  v_sha TEXT := repeat('a',40);
  v_deleted RECORD;
  v_rejected BOOLEAN;
  v_case INTEGER;
BEGIN
  IF NOT has_function_privilege('service_role',
      'public.cleanup_yutakasa_ticket_bridge_e2e_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid,bigint,integer,text)',
      'EXECUTE') OR
     has_function_privilege('anon',
      'public.cleanup_yutakasa_ticket_bridge_e2e_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid,bigint,integer,text)',
      'EXECUTE') OR
     has_function_privilege('authenticated',
      'public.cleanup_yutakasa_ticket_bridge_e2e_smoke(uuid,uuid,timestamptz,uuid,timestamptz,uuid,uuid,bigint,integer,text)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'bridge cleanup grant invalid';
  END IF;

  FOR v_case IN 1..11 LOOP
    v_run := gen_random_uuid();
    v_email := 'yutakasa-auto-smoke+' || v_run::TEXT || '@example.invalid';
    v_work := gen_random_uuid();
    v_lock := gen_random_uuid();
    v_pr := 98000+v_case;
    v_ticket := NULL;
    v_ticket_id := NULL;
    INSERT INTO public.subscribers(email,name,status,subscription_status,myasp_data)
      VALUES(v_email,'System monitor test identity (no customer, no payment)',
        'active','active',jsonb_build_object(
          'automation_test_identity','yutakasa-ai-repair-smoke-v1',
          'source','system_monitor_no_payment','smoke_run_id',v_run::TEXT))
      RETURNING * INTO v_account;
    IF v_case<>1 THEN
      SELECT ticket_id INTO v_ticket_id FROM public.create_support_ticket_with_message(
        v_email,'technical','__YUTAKASA_AI_REPAIR_SMOKE_V1__ support',
        '__YUTAKASA_AI_REPAIR_SMOKE_V1__ ゼロ幅スペースだけを渡すと、見出しは空白になります。',
        gen_random_uuid(),FALSE,'[]'::jsonb);
      SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
      SELECT id INTO v_user_message FROM public.support_messages
        WHERE ticket_id=v_ticket_id AND sender_type='user';
    END IF;
    IF v_case IN (3,4,5,6,7,8,9,10,11) THEN
      SELECT * INTO v_claim FROM public.claim_support_ticket_with_log(v_ticket_id,v_lock);
      PERFORM * FROM public.begin_yutakasa_ticket_repair(
        v_ticket_id,v_lock,v_user_message,v_claim.updated_at,v_work);
      SELECT * INTO v_ticket FROM public.support_tickets WHERE id=v_ticket_id;
    END IF;
    IF v_case IN (4,5,6,7,8,9,10,11) THEN
      PERFORM public.claim_yutakasa_ticket_repair_context(v_work,123);
    END IF;
    IF v_case IN (5,6,7,8,9,10,11) THEN
      PERFORM * FROM public.link_yutakasa_ticket_repair_pr(v_work,123,v_pr,v_sha);
    END IF;
    IF v_case=7 THEN
      UPDATE public.yutakasa_repair_releases SET status='abandoned'
        WHERE pr_number=v_pr;
    ELSIF v_case=8 THEN
      INSERT INTO public.support_messages(ticket_id,sender_type,sender_email,body,client_request_id)
        VALUES(v_ticket_id,'admin','operator@example.invalid','changed',gen_random_uuid());
    ELSIF v_case=9 THEN
      UPDATE public.subscribers SET subscription_last_event_at=clock_timestamp()
        WHERE id=v_account.id;
    END IF;
    v_rejected := FALSE;
    BEGIN
      SELECT * INTO v_deleted FROM public.cleanup_yutakasa_ticket_bridge_e2e_smoke(
        v_run,v_account.id,v_account.updated_at,v_ticket_id,v_ticket.updated_at,
        v_work,v_lock,CASE WHEN v_case=10 THEN 124 ELSE 123 END,
        CASE WHEN v_case=6 THEN v_pr+1 WHEN v_case>=5 THEN v_pr ELSE NULL END,
        CASE WHEN v_case=11 THEN repeat('b',40)
          WHEN v_case>=5 THEN v_sha ELSE NULL END);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := TRUE;
    END;
    IF v_case IN (6,7,8,9,10,11) THEN
      IF NOT v_rejected OR NOT EXISTS(SELECT 1 FROM public.support_tickets
          WHERE id=v_ticket_id) OR NOT EXISTS(SELECT 1 FROM public.subscribers
          WHERE id=v_account.id) OR NOT EXISTS(
          SELECT 1 FROM public.yutakasa_repair_releases WHERE pr_number=v_pr) THEN
        RAISE EXCEPTION 'changed bridge row deleted in case %',v_case;
      END IF;
    ELSE
      IF v_rejected OR v_deleted.ticket_deleted IS DISTINCT FROM (v_case<>1) OR
         NOT v_deleted.subscriber_deleted OR
         EXISTS(SELECT 1 FROM public.support_tickets WHERE id=v_ticket_id) OR
         EXISTS(SELECT 1 FROM public.subscribers WHERE id=v_account.id) OR
         EXISTS(SELECT 1 FROM public.support_messages WHERE ticket_id=v_ticket_id) OR
         EXISTS(SELECT 1 FROM public.support_work_logs WHERE ticket_id=v_ticket_id) OR
         EXISTS(SELECT 1 FROM public.yutakasa_ticket_repair_jobs WHERE work_id=v_work) OR
         EXISTS(SELECT 1 FROM public.yutakasa_repair_ticket_links WHERE ticket_id=v_ticket_id) OR
         EXISTS(SELECT 1 FROM public.yutakasa_repair_releases WHERE pr_number=v_pr) THEN
        RAISE EXCEPTION 'bridge cleanup incomplete in case %',v_case;
      END IF;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
