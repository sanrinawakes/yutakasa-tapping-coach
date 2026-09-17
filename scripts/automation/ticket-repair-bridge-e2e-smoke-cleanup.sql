-- Install before running the one-shot capped Terra, synthetic ticket, and
-- draft PR and CI probe. The caller must prove the draft PR closed unmerged
-- and its branch deleted before invoking this function.
-- The function has a deliberately narrow, fixed synthetic identity and content.
-- A repair claim locks job then ticket; keep that lock order here.
BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_yutakasa_ticket_bridge_e2e_smoke(
  p_run_id UUID,
  p_account_id UUID,
  p_account_updated_at TIMESTAMPTZ,
  p_ticket_id UUID,
  p_ticket_updated_at TIMESTAMPTZ,
  p_work_id UUID,
  p_lock_token UUID,
  p_gh_run_id BIGINT,
  p_pr_number INTEGER,
  p_head_sha TEXT
)
RETURNS TABLE(ticket_deleted BOOLEAN, subscriber_deleted BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_email TEXT;
  v_account public.subscribers%ROWTYPE;
  v_ticket public.support_tickets%ROWTYPE;
  v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
  v_release public.yutakasa_repair_releases%ROWTYPE;
  v_user_message_id UUID;
  v_message_count BIGINT;
  v_user_count BIGINT;
  v_ack_count BIGINT;
  v_log_count BIGINT;
  v_claim_count BIGINT;
  v_handoff_count BIGINT;
  v_review_count BIGINT;
  v_link_count BIGINT;
  v_link_valid_count BIGINT;
  v_release_link_count BIGINT;
  v_job_count BIGINT;
  v_rows BIGINT;
BEGIN
  IF p_run_id IS NULL OR p_work_id IS NULL OR p_lock_token IS NULL OR
     p_gh_run_id IS NULL OR p_gh_run_id < 1 OR
     (p_pr_number IS NULL) <> (p_head_sha IS NULL) OR
     (p_pr_number IS NOT NULL AND (p_pr_number < 1 OR
       p_head_sha !~ '^[a-f0-9]{40}$')) THEN
    RAISE EXCEPTION 'invalid smoke identity' USING ERRCODE='22023';
  END IF;
  v_email := 'yutakasa-auto-smoke+' || p_run_id::TEXT || '@example.invalid';

  -- An AI claim also locks the job before the ticket. If it wins, its status
  -- changes before this function can inspect it and deletion is refused.
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs
    WHERE work_id=p_work_id FOR UPDATE;
  SELECT * INTO v_ticket FROM public.support_tickets
    WHERE user_email=v_email FOR UPDATE;
  SELECT * INTO v_account FROM public.subscribers
    WHERE email=v_email FOR UPDATE;
  IF p_pr_number IS NOT NULL THEN
    SELECT * INTO v_release FROM public.yutakasa_repair_releases
      WHERE pr_number=p_pr_number FOR UPDATE;
  END IF;

  IF (SELECT count(*) FROM public.support_tickets WHERE user_email=v_email)>1 OR
     (SELECT count(*) FROM public.yutakasa_ticket_repair_jobs
       WHERE ticket_id=v_ticket.id)>(CASE WHEN v_job.work_id IS NULL THEN 0 ELSE 1 END) OR
     (v_job.work_id IS NOT NULL AND
       (v_ticket.id IS NULL OR v_job.ticket_id IS DISTINCT FROM v_ticket.id)) THEN
    RAISE EXCEPTION 'smoke rows ambiguous' USING ERRCODE='P0001';
  END IF;
  IF (v_ticket.id IS NULL AND (p_ticket_id IS NOT NULL OR p_ticket_updated_at IS NOT NULL)) OR
     (v_ticket.id IS NOT NULL AND
       (p_ticket_id IS DISTINCT FROM v_ticket.id OR
        p_ticket_updated_at IS DISTINCT FROM v_ticket.updated_at)) OR
     (v_account.id IS NULL AND (p_account_id IS NOT NULL OR p_account_updated_at IS NOT NULL)) OR
     (v_account.id IS NOT NULL AND
       (p_account_id IS DISTINCT FROM v_account.id OR
        p_account_updated_at IS DISTINCT FROM v_account.updated_at)) THEN
    RAISE EXCEPTION 'smoke row changed' USING ERRCODE='P0001';
  END IF;

  IF v_account.id IS NOT NULL AND (
    v_account.email IS DISTINCT FROM v_email OR
    v_account.name IS DISTINCT FROM 'System monitor test identity (no customer, no payment)' OR
    v_account.status IS DISTINCT FROM 'active' OR
    v_account.subscription_status IS DISTINCT FROM 'active' OR
    v_account.first_payment_date IS NOT NULL OR
    v_account.subscription_started_at IS NOT NULL OR
    v_account.subscription_last_event_at IS NOT NULL OR
    v_account.myasp_data IS DISTINCT FROM jsonb_build_object(
      'automation_test_identity','yutakasa-ai-repair-smoke-v1',
      'source','system_monitor_no_payment','smoke_run_id',p_run_id::TEXT)
  ) THEN
    RAISE EXCEPTION 'smoke account changed' USING ERRCODE='P0001';
  END IF;
  IF v_ticket.id IS NOT NULL AND v_account.id IS NULL THEN
    RAISE EXCEPTION 'smoke account missing' USING ERRCODE='P0001';
  END IF;
  IF v_ticket.id IS NULL AND (v_job.work_id IS NOT NULL OR
      p_pr_number IS NOT NULL OR p_head_sha IS NOT NULL) THEN
    RAISE EXCEPTION 'smoke ticket missing for repair' USING ERRCODE='P0001';
  END IF;
  IF EXISTS(SELECT 1 FROM public.chat_threads WHERE user_email=v_email) OR
     EXISTS(SELECT 1 FROM public.otp_codes WHERE email=v_email) THEN
    RAISE EXCEPTION 'smoke identity in use' USING ERRCODE='P0001';
  END IF;

  IF v_ticket.id IS NOT NULL THEN
    IF v_ticket.category IS DISTINCT FROM 'technical' OR
       v_ticket.subject IS DISTINCT FROM '__YUTAKASA_AI_REPAIR_SMOKE_V1__ support' OR
       v_ticket.decision_required IS DISTINCT FROM FALSE OR
       v_ticket.client_request_id IS NULL OR
       v_ticket.user_last_read_at IS NOT NULL OR
       v_ticket.admin_last_read_at IS NOT NULL OR
       EXISTS(SELECT 1 FROM public.support_attachments WHERE ticket_id=v_ticket.id) OR
       EXISTS(SELECT 1 FROM public.yutakasa_ticket_reply_drafts WHERE ticket_id=v_ticket.id) OR
       EXISTS(SELECT 1 FROM public.yutakasa_ticket_clarifications WHERE ticket_id=v_ticket.id) OR
       EXISTS(SELECT 1 FROM public.yutakasa_ticket_clarification_notices WHERE ticket_id=v_ticket.id) OR
       EXISTS(SELECT 1 FROM public.yutakasa_ticket_completion_proofs WHERE ticket_id=v_ticket.id) OR
       EXISTS(SELECT 1 FROM public.yutakasa_ticket_completion_notices WHERE ticket_id=v_ticket.id) THEN
      RAISE EXCEPTION 'smoke ticket changed' USING ERRCODE='P0001';
    END IF;
    SELECT count(*),
      count(*) FILTER (WHERE sender_type='user' AND sender_email=v_email AND
        body='__YUTAKASA_AI_REPAIR_SMOKE_V1__ ゼロ幅スペースだけを渡すと、見出しは空白になります。' AND
        client_request_id=v_ticket.client_request_id),
      count(*) FILTER (WHERE sender_type='system' AND sender_email IS NULL AND
        body='お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。' AND
        client_request_id<>v_ticket.client_request_id)
      INTO v_message_count,v_user_count,v_ack_count
      FROM public.support_messages WHERE ticket_id=v_ticket.id;
    IF v_message_count<>2 OR v_user_count<>1 OR v_ack_count<>1 THEN
      RAISE EXCEPTION 'smoke messages changed' USING ERRCODE='P0001';
    END IF;
    SELECT id INTO v_user_message_id FROM public.support_messages
      WHERE ticket_id=v_ticket.id AND sender_type='user';
    SELECT count(*),
      count(*) FILTER (WHERE event_type='automation_claimed' AND
        summary='Codexが技術調査を開始しました。' AND metadata='{}'::jsonb),
      count(*) FILTER (WHERE event_type='repair_work_queued' AND
        summary='技術修正の調査を登録しました。本番修正や顧客返信はまだ行っていません。' AND
        metadata=jsonb_build_object('work_id',p_work_id))
      ,count(*) FILTER (WHERE event_type='repair_manual_review' AND
        summary='自動修正の根拠が不足しています。担当者による調査が必要です。顧客返信は行っていません。' AND
        metadata=jsonb_build_object('work_id',p_work_id,
          'reason_code','synthetic_bridge_probe'))
      INTO v_log_count,v_claim_count,v_handoff_count,v_review_count
      FROM public.support_work_logs WHERE ticket_id=v_ticket.id;
    SELECT count(*) INTO v_job_count FROM public.yutakasa_ticket_repair_jobs
      WHERE ticket_id=v_ticket.id;
    SELECT count(*),count(*) FILTER (WHERE pr_number=p_pr_number
      AND latest_user_message_id=v_user_message_id)
      INTO v_link_count,v_link_valid_count
      FROM public.yutakasa_repair_ticket_links WHERE ticket_id=v_ticket.id;
    IF (p_pr_number IS NULL AND v_link_count<>0) OR
       (p_pr_number IS NOT NULL AND (v_link_count<>1 OR v_link_valid_count<>1)) THEN
      RAISE EXCEPTION 'smoke PR link changed' USING ERRCODE='P0001';
    END IF;
    IF (v_job.status IS DISTINCT FROM 'pr_open' AND
        (p_pr_number IS NOT NULL OR p_head_sha IS NOT NULL)) OR
       (v_job.status='pr_open' AND (p_pr_number IS NULL OR p_head_sha IS NULL)) THEN
      RAISE EXCEPTION 'smoke PR identity mismatch' USING ERRCODE='P0001';
    END IF;
    IF (
      (v_ticket.status='open' AND v_ticket.automation_status='queued' AND
        v_ticket.automation_lock_token IS NULL AND
        v_ticket.automation_locked_at IS NULL AND v_log_count=0 AND v_job_count=0) OR
      (v_ticket.status='in_progress' AND
        v_ticket.automation_status='investigating' AND
        v_ticket.automation_lock_token=p_lock_token AND
        v_ticket.automation_locked_at IS NOT NULL AND v_log_count=1 AND
        v_claim_count=1 AND v_job_count=0) OR
      (v_ticket.status='in_progress' AND
        v_ticket.automation_status='awaiting_repair' AND
        v_ticket.automation_lock_token IS NULL AND
        v_ticket.automation_locked_at IS NULL AND v_log_count=2 AND
        v_claim_count=1 AND v_handoff_count=1 AND v_job_count=1 AND
        v_job.work_id=p_work_id AND v_job.ticket_id=v_ticket.id AND
        v_job.latest_user_message_id=v_user_message_id AND
        v_job.status='queued' AND v_job.attempt_count=0 AND
        v_job.claimed_at IS NULL AND v_job.claimed_run_id IS NULL AND
        v_job.pr_number IS NULL AND v_job.head_sha IS NULL) OR
      (v_ticket.status='in_progress' AND
        v_ticket.automation_status='awaiting_repair' AND
        v_ticket.automation_lock_token IS NULL AND
        v_ticket.automation_locked_at IS NULL AND v_log_count=2 AND
        v_claim_count=1 AND v_handoff_count=1 AND v_job_count=1 AND
        v_job.work_id=p_work_id AND v_job.ticket_id=v_ticket.id AND
        v_job.latest_user_message_id=v_user_message_id AND
        v_job.status='investigating' AND v_job.attempt_count=1 AND
        v_job.claimed_at IS NOT NULL AND v_job.claimed_run_id=p_gh_run_id AND
        v_job.pr_number IS NULL AND v_job.head_sha IS NULL) OR
      (v_ticket.status='in_progress' AND
        v_ticket.automation_status='awaiting_repair' AND
        v_ticket.automation_lock_token IS NULL AND
        v_ticket.automation_locked_at IS NULL AND v_log_count=3 AND
        v_claim_count=1 AND v_handoff_count=1 AND v_job_count=1 AND
        v_job.work_id=p_work_id AND v_job.ticket_id=v_ticket.id AND
        v_job.latest_user_message_id=v_user_message_id AND
        v_job.status='pr_open' AND v_job.attempt_count=1 AND
        v_job.claimed_at IS NOT NULL AND v_job.claimed_run_id=p_gh_run_id AND
        v_job.pr_number=p_pr_number AND v_job.head_sha=p_head_sha AND
        v_link_count=1 AND v_link_valid_count=1 AND
        (SELECT count(*) FROM public.support_work_logs w
          WHERE w.ticket_id=v_ticket.id AND w.event_type='repair_pr_linked'
          AND w.summary='技術修正の候補PRを登録しました。本番修正や顧客返信はまだ行っていません。'
          AND w.metadata=jsonb_build_object('work_id',p_work_id,'pr_number',p_pr_number))=1)
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'smoke repair state changed' USING ERRCODE='P0001';
    END IF;
    IF p_pr_number IS NOT NULL THEN
      SELECT count(*) INTO v_release_link_count FROM public.yutakasa_repair_ticket_links
        WHERE pr_number=p_pr_number;
      IF v_release.pr_number IS DISTINCT FROM p_pr_number OR
         v_release.head_sha IS DISTINCT FROM p_head_sha OR
         v_release.status IS DISTINCT FROM 'pending_merge' OR
         v_release.merge_sha IS NOT NULL OR
         v_release.merge_recorded_at IS NOT NULL OR
         v_release.deployment_id IS NOT NULL OR
         v_release.first_healthy_at IS NOT NULL OR
         v_release.last_healthy_at IS NOT NULL OR
         v_release.healthy_count IS DISTINCT FROM 0 OR
         v_release.verified_at IS NOT NULL OR
         v_release.error_code IS NOT NULL OR
         v_release_link_count<>1 OR
         EXISTS(SELECT 1 FROM public.yutakasa_repair_observations
           WHERE pr_number=p_pr_number) OR
         EXISTS(SELECT 1 FROM public.yutakasa_ticket_completion_proofs
           WHERE pr_number=p_pr_number) THEN
        RAISE EXCEPTION 'smoke release changed' USING ERRCODE='P0001';
      END IF;
    END IF;
    DELETE FROM public.support_tickets WHERE id=v_ticket.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows<>1 THEN RAISE EXCEPTION 'smoke ticket delete failed' USING ERRCODE='P0001'; END IF;
    IF p_pr_number IS NOT NULL THEN
      DELETE FROM public.yutakasa_repair_releases WHERE pr_number=p_pr_number;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows<>1 THEN RAISE EXCEPTION 'smoke release delete failed' USING ERRCODE='P0001'; END IF;
    END IF;
  END IF;
  IF v_account.id IS NOT NULL THEN
    DELETE FROM public.subscribers WHERE id=v_account.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows<>1 THEN RAISE EXCEPTION 'smoke account delete failed' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN QUERY SELECT v_ticket.id IS NOT NULL,v_account.id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_yutakasa_ticket_bridge_e2e_smoke(
  UUID,UUID,TIMESTAMPTZ,UUID,TIMESTAMPTZ,UUID,UUID,BIGINT,INTEGER,TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_yutakasa_ticket_bridge_e2e_smoke(
  UUID,UUID,TIMESTAMPTZ,UUID,TIMESTAMPTZ,UUID,UUID,BIGINT,INTEGER,TEXT) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
