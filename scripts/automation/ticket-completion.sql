-- Dormant, ticket-specific completion path. Apply after ticket-repair-bridge.sql.
-- A trusted scenario runner must verify its own before/after/production artifacts
-- before calling the proof RPC. No generic chat smoke can create this proof.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_ticket_completion_proofs (
  work_id UUID PRIMARY KEY REFERENCES public.yutakasa_ticket_repair_jobs(work_id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  latest_user_message_id UUID NOT NULL REFERENCES public.support_messages(id) ON DELETE CASCADE,
  user_message_sha256 TEXT NOT NULL CHECK (user_message_sha256 ~ '^[a-f0-9]{64}$'),
  pr_number INTEGER NOT NULL REFERENCES public.yutakasa_repair_releases(pr_number) ON DELETE CASCADE,
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  merge_sha TEXT NOT NULL CHECK (merge_sha ~ '^[a-f0-9]{40}$'),
  deployment_id TEXT NOT NULL CHECK (deployment_id ~ '^dpl_[A-Za-z0-9]{8,160}$'),
  scenario_key TEXT NOT NULL CHECK (scenario_key IN ('chat_send_reload_persistence','chat_stream_completion')),
  scenario_sha256 TEXT NOT NULL CHECK (scenario_sha256 ~ '^[a-f0-9]{64}$'),
  before_failure_sha256 TEXT NOT NULL CHECK (before_failure_sha256 ~ '^[a-f0-9]{64}$'),
  after_success_sha256 TEXT NOT NULL CHECK (after_success_sha256 ~ '^[a-f0-9]{64}$'),
  production_success_sha256 TEXT NOT NULL CHECK (production_success_sha256 ~ '^[a-f0-9]{64}$'),
  before_after_run_id BIGINT NOT NULL CHECK (before_after_run_id > 0),
  production_run_id BIGINT NOT NULL CHECK (production_run_id > 0),
  proven_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  used_message_id UUID UNIQUE REFERENCES public.support_messages(id),
  UNIQUE (ticket_id, latest_user_message_id, pr_number)
);
ALTER TABLE public.yutakasa_ticket_completion_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_ticket_completion_proofs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.yutakasa_ticket_completion_proofs TO service_role;

CREATE OR REPLACE FUNCTION public.record_yutakasa_ticket_completion_proof(
  p_work_id UUID,p_latest_user_message_id UUID,p_pr_number INTEGER,
  p_head_sha TEXT,p_merge_sha TEXT,p_deployment_id TEXT,p_scenario_key TEXT,
  p_scenario_sha256 TEXT,p_before_failure_sha256 TEXT,
  p_after_success_sha256 TEXT,p_production_success_sha256 TEXT,
  p_before_after_run_id BIGINT,p_production_run_id BIGINT
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_release public.yutakasa_repair_releases%ROWTYPE;
DECLARE v_existing public.yutakasa_ticket_completion_proofs%ROWTYPE;
DECLARE v_message_sha TEXT;
DECLARE v_message_body TEXT;
DECLARE v_owner_terms CONSTANT TEXT := '(返金|払い戻し|解約|契約|請求|決済|課金|料金|支払|領収|法律|訴訟|補償|個人情報|削除|refund|billing|payment|cancel|contract|legal)';
BEGIN
  IF p_work_id IS NULL OR p_latest_user_message_id IS NULL OR p_pr_number IS NULL
    OR p_pr_number<1 OR p_head_sha IS NULL OR p_head_sha !~ '^[a-f0-9]{40}$'
    OR p_merge_sha IS NULL OR p_merge_sha !~ '^[a-f0-9]{40}$'
    OR p_deployment_id IS NULL OR p_deployment_id !~ '^dpl_[A-Za-z0-9]{8,160}$'
    OR p_scenario_key IS NULL OR p_scenario_key NOT IN ('chat_send_reload_persistence','chat_stream_completion')
    OR p_scenario_sha256 IS NULL OR p_scenario_sha256 !~ '^[a-f0-9]{64}$'
    OR p_before_failure_sha256 IS NULL OR p_before_failure_sha256 !~ '^[a-f0-9]{64}$'
    OR p_after_success_sha256 IS NULL OR p_after_success_sha256 !~ '^[a-f0-9]{64}$'
    OR p_production_success_sha256 IS NULL OR p_production_success_sha256 !~ '^[a-f0-9]{64}$'
    OR p_before_after_run_id IS NULL OR p_before_after_run_id<1
    OR p_production_run_id IS NULL OR p_production_run_id<1
    OR p_before_after_run_id=p_production_run_id
    OR p_before_failure_sha256=p_after_success_sha256
    OR p_before_failure_sha256=p_production_success_sha256 THEN
    RAISE EXCEPTION 'invalid ticket completion proof' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'repair work missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  SELECT * INTO v_release FROM public.yutakasa_repair_releases r
    WHERE r.pr_number=p_pr_number;
  IF v_job.status<>'pr_open' OR v_job.pr_number IS DISTINCT FROM p_pr_number
    OR v_job.head_sha IS DISTINCT FROM p_head_sha
    OR v_job.latest_user_message_id IS DISTINCT FROM p_latest_user_message_id
    OR v_ticket.status<>'in_progress' OR v_ticket.automation_status<>'awaiting_repair'
    OR v_ticket.category<>'technical' OR v_ticket.decision_required
    OR EXISTS(SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=v_job.ticket_id)
    OR v_ticket.subject ~* v_owner_terms
    OR EXISTS(SELECT 1 FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='user' AND m.body ~* v_owner_terms)
    OR EXISTS(SELECT 1 FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='admin' AND m.created_at>=(
        SELECT u.created_at FROM public.support_messages u WHERE u.id=p_latest_user_message_id))
    OR p_latest_user_message_id IS DISTINCT FROM (
      SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
        AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1)
    OR v_release.status NOT IN ('observing','verified')
    OR v_release.head_sha IS DISTINCT FROM p_head_sha
    OR v_release.merge_sha IS DISTINCT FROM p_merge_sha
    OR v_release.merge_recorded_at IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.yutakasa_repair_ticket_links l
      WHERE l.pr_number=p_pr_number AND l.ticket_id=v_job.ticket_id
        AND l.latest_user_message_id=p_latest_user_message_id) THEN
    RAISE EXCEPTION 'ticket completion proof context changed' USING ERRCODE='P0001';
  END IF;
  SELECT encode(sha256(convert_to(m.body,'UTF8')),'hex'),m.body
    INTO v_message_sha,v_message_body
    FROM public.support_messages m WHERE m.id=p_latest_user_message_id
      AND m.ticket_id=v_job.ticket_id AND m.sender_type='user';
  IF v_message_sha IS NULL THEN
    RAISE EXCEPTION 'ticket completion source missing' USING ERRCODE='P0001';
  END IF;
  IF (p_scenario_key='chat_send_reload_persistence' AND NOT
      (v_message_body ~ '(再読み込み|リロード|更新)' AND
       v_message_body ~ '(会話|メッセージ|返信|回答)' AND
       v_message_body ~ '(消え|保存され|残ら|表示され)'))
    OR (p_scenario_key='chat_stream_completion' AND NOT
      (v_message_body ~ '(回答|返信)' AND v_message_body ~ '(途中|止ま|切れ|完了しな)')) THEN
    RAISE EXCEPTION 'ticket symptom does not match scenario' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_existing FROM public.yutakasa_ticket_completion_proofs p
    WHERE p.work_id=p_work_id;
  IF FOUND THEN
    IF v_existing.ticket_id IS DISTINCT FROM v_job.ticket_id
      OR v_existing.latest_user_message_id IS DISTINCT FROM p_latest_user_message_id
      OR v_existing.user_message_sha256 IS DISTINCT FROM v_message_sha
      OR v_existing.pr_number IS DISTINCT FROM p_pr_number
      OR v_existing.head_sha IS DISTINCT FROM p_head_sha
      OR v_existing.merge_sha IS DISTINCT FROM p_merge_sha
      OR v_existing.deployment_id IS DISTINCT FROM p_deployment_id
      OR v_existing.scenario_key IS DISTINCT FROM p_scenario_key
      OR v_existing.scenario_sha256 IS DISTINCT FROM p_scenario_sha256
      OR v_existing.before_failure_sha256 IS DISTINCT FROM p_before_failure_sha256
      OR v_existing.after_success_sha256 IS DISTINCT FROM p_after_success_sha256
      OR v_existing.production_success_sha256 IS DISTINCT FROM p_production_success_sha256
      OR v_existing.before_after_run_id IS DISTINCT FROM p_before_after_run_id
      OR v_existing.production_run_id IS DISTINCT FROM p_production_run_id THEN
      RAISE EXCEPTION 'ticket completion proof conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT FALSE; RETURN;
  END IF;
  INSERT INTO public.yutakasa_ticket_completion_proofs(
    work_id,ticket_id,latest_user_message_id,user_message_sha256,pr_number,
    head_sha,merge_sha,deployment_id,scenario_key,scenario_sha256,
    before_failure_sha256,after_success_sha256,production_success_sha256,
    before_after_run_id,production_run_id
  ) VALUES(p_work_id,v_job.ticket_id,p_latest_user_message_id,v_message_sha,p_pr_number,
    p_head_sha,p_merge_sha,p_deployment_id,p_scenario_key,p_scenario_sha256,
    p_before_failure_sha256,p_after_success_sha256,p_production_success_sha256,
    p_before_after_run_id,p_production_run_id);
  RETURN QUERY SELECT TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_yutakasa_ticket_completion_context(p_work_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_work_id IS NULL THEN RAISE EXCEPTION 'invalid repair work' USING ERRCODE='22023'; END IF;
  RETURN (SELECT jsonb_build_object('work_id',p.work_id,'pr_number',p.pr_number,
    'merge_sha',p.merge_sha,'deployment_id',p.deployment_id,
    'scenario_key',p.scenario_key)
    FROM public.yutakasa_ticket_completion_proofs p
    JOIN public.yutakasa_ticket_repair_jobs j ON j.work_id=p.work_id
    WHERE p.work_id=p_work_id AND p.used_message_id IS NULL AND j.status='pr_open');
END;
$$;

CREATE OR REPLACE FUNCTION public.append_yutakasa_verified_ticket_completion(
  p_work_id UUID,p_current_main_sha TEXT,p_current_deployment_id TEXT
)
RETURNS TABLE(message_id UUID,created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_proof public.yutakasa_ticket_completion_proofs%ROWTYPE;
DECLARE v_release public.yutakasa_repair_releases%ROWTYPE;
DECLARE v_existing public.support_messages%ROWTYPE;
DECLARE v_count INTEGER;
DECLARE v_first TIMESTAMPTZ;
DECLARE v_last TIMESTAMPTZ;
DECLARE v_min_slot BIGINT;
DECLARE v_max_slot BIGINT;
DECLARE v_body TEXT;
DECLARE v_message_id UUID;
DECLARE v_owner_terms CONSTANT TEXT := '(返金|払い戻し|解約|契約|請求|決済|課金|料金|支払|領収|法律|訴訟|補償|個人情報|削除|refund|billing|payment|cancel|contract|legal)';
BEGIN
  IF p_work_id IS NULL OR p_current_main_sha IS NULL OR p_current_main_sha !~ '^[a-f0-9]{40}$'
    OR p_current_deployment_id IS NULL OR p_current_deployment_id !~ '^dpl_[A-Za-z0-9]{8,160}$' THEN
    RAISE EXCEPTION 'invalid ticket completion' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'repair work missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  SELECT * INTO v_proof FROM public.yutakasa_ticket_completion_proofs p
    WHERE p.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ticket-specific proof missing' USING ERRCODE='P0001'; END IF;
  -- An uncertain HTTP result returns its original message without a second
  -- write. A changed ticket is not silently marked completed again.
  SELECT * INTO v_existing FROM public.support_messages m
    WHERE m.ticket_id=v_job.ticket_id AND m.client_request_id=p_work_id;
  IF FOUND THEN
    IF v_existing.sender_type<>'admin' OR v_proof.used_message_id IS DISTINCT FROM v_existing.id
      OR v_job.status<>'replied' THEN
      RAISE EXCEPTION 'ticket completion retry conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id,FALSE; RETURN;
  END IF;
  SELECT * INTO v_release FROM public.yutakasa_repair_releases r
    WHERE r.pr_number=v_job.pr_number;
  IF v_job.status<>'pr_open' OR v_ticket.status<>'in_progress'
    OR v_ticket.automation_status<>'awaiting_repair'
    OR v_ticket.category<>'technical' OR v_ticket.decision_required
    OR EXISTS(SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=v_job.ticket_id)
    OR v_ticket.subject ~* v_owner_terms
    OR EXISTS(SELECT 1 FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='user' AND m.body ~* v_owner_terms)
    OR EXISTS(SELECT 1 FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='admin' AND m.created_at>=(
        SELECT u.created_at FROM public.support_messages u WHERE u.id=v_job.latest_user_message_id))
    OR v_proof.used_message_id IS NOT NULL
    OR v_proof.ticket_id IS DISTINCT FROM v_job.ticket_id
    OR v_proof.latest_user_message_id IS DISTINCT FROM v_job.latest_user_message_id
    OR v_proof.pr_number IS DISTINCT FROM v_job.pr_number
    OR v_proof.head_sha IS DISTINCT FROM v_job.head_sha
    OR v_proof.merge_sha IS DISTINCT FROM v_release.merge_sha
    OR v_proof.deployment_id IS DISTINCT FROM v_release.deployment_id
    OR v_release.status<>'verified' OR v_release.verified_at IS NULL
    OR v_release.healthy_count<3 OR v_release.first_healthy_at IS NULL
    OR v_release.last_healthy_at IS NULL
    OR v_release.last_healthy_at-v_release.first_healthy_at<INTERVAL '20 minutes'
    OR v_release.last_healthy_at<clock_timestamp()-INTERVAL '15 minutes'
    OR v_release.last_healthy_at>clock_timestamp()+INTERVAL '2 minutes'
    OR v_release.merge_sha IS DISTINCT FROM p_current_main_sha
    OR v_release.deployment_id IS DISTINCT FROM p_current_deployment_id
    OR v_proof.proven_at<v_release.merge_recorded_at
    OR v_job.latest_user_message_id IS DISTINCT FROM (
      SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
        AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1)
    OR v_proof.user_message_sha256 IS DISTINCT FROM (
      SELECT encode(sha256(convert_to(m.body,'UTF8')),'hex')
      FROM public.support_messages m WHERE m.id=v_job.latest_user_message_id
        AND m.ticket_id=v_job.ticket_id AND m.sender_type='user')
    OR EXISTS(SELECT 1 FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='admin' AND m.created_at>v_proof.proven_at)
    OR NOT EXISTS(SELECT 1 FROM public.yutakasa_repair_ticket_links l
      WHERE l.pr_number=v_job.pr_number AND l.ticket_id=v_job.ticket_id
        AND l.latest_user_message_id=v_job.latest_user_message_id) THEN
    RAISE EXCEPTION 'ticket completion evidence changed' USING ERRCODE='P0001';
  END IF;
  SELECT count(*),min(o.observed_at),max(o.observed_at),min(o.cron_slot),max(o.cron_slot)
    INTO v_count,v_first,v_last,v_min_slot,v_max_slot
    FROM (SELECT * FROM public.yutakasa_repair_observations o
      WHERE o.pr_number=v_job.pr_number AND o.healthy AND o.deployment_id=p_current_deployment_id
      ORDER BY o.observed_at DESC LIMIT 3) o;
  IF v_count<>3 OR v_max_slot-v_min_slot<>2 OR v_last-v_first<INTERVAL '20 minutes'
    OR v_last IS DISTINCT FROM v_release.last_healthy_at THEN
    RAISE EXCEPTION 'three matching scheduled observations missing' USING ERRCODE='P0001';
  END IF;
  v_body:=CASE v_proof.scenario_key
    WHEN 'chat_send_reload_persistence' THEN
      'お問い合わせの会話が再読み込み後に消える症状について、同じ条件で修正前に再現し、現在の本番環境では送信内容の保存と再読み込み後の表示を確認しました。再度お試しください。まだ消える場合は、この問い合わせに発生時刻と操作した画面をお知らせください。'
    WHEN 'chat_stream_completion' THEN
      'お問い合わせの回答が途中で止まる症状について、同じ条件で修正前に再現し、現在の本番環境では回答が最後まで表示されることを確認しました。再度お試しください。続く場合は、この問い合わせに発生時刻と操作した画面をお知らせください。'
    ELSE NULL END;
  IF v_body IS NULL THEN RAISE EXCEPTION 'unsupported completion scenario' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.support_messages(ticket_id,sender_type,sender_email,body,client_request_id)
    VALUES(v_job.ticket_id,'admin',NULL,v_body,p_work_id) RETURNING id INTO v_message_id;
  UPDATE public.yutakasa_ticket_completion_proofs p SET used_message_id=v_message_id WHERE p.work_id=p_work_id;
  UPDATE public.yutakasa_ticket_repair_jobs j SET status='replied',updated_at=clock_timestamp()
    WHERE j.work_id=p_work_id;
  UPDATE public.support_tickets t SET status='resolved',automation_status='completed',
    automation_locked_at=NULL,automation_lock_token=NULL,updated_at=clock_timestamp()
    WHERE t.id=v_job.ticket_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(v_job.ticket_id,'repair_ticket_specific_completed',
      '問い合わせ固有の再現と本番確認に基づいて、会員サイト内で回答しました。',
      jsonb_build_object('work_id',p_work_id,'pr_number',v_job.pr_number,
        'message_id',v_message_id,'scenario_key',v_proof.scenario_key));
  RETURN QUERY SELECT v_message_id,TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_yutakasa_ticket_completion_proof(
  UUID,UUID,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_yutakasa_ticket_completion_context(UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.append_yutakasa_verified_ticket_completion(UUID,TEXT,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_yutakasa_ticket_completion_proof(
  UUID,UUID,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_yutakasa_ticket_completion_context(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_yutakasa_verified_ticket_completion(UUID,TEXT,TEXT)
  TO service_role;

COMMIT;
