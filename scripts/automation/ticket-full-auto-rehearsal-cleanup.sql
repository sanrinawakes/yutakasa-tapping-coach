-- Delete only the fixed, no-payment synthetic ticket after the complete
-- merge, production proof, three observations, and suppressed reply rehearsal.
-- The entire check and deletion is atomic. A changed row blocks all deletion.
BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_yutakasa_full_auto_rehearsal(
  p_run_id UUID,
  p_account_id UUID,
  p_account_updated_at TIMESTAMPTZ,
  p_ticket_id UUID,
  p_ticket_updated_at TIMESTAMPTZ,
  p_work_id UUID,
  p_pr_number INTEGER,
  p_head_sha TEXT,
  p_merge_sha TEXT,
  p_deployment_id TEXT,
  p_admin_message_id UUID
)
RETURNS TABLE(ticket_deleted BOOLEAN, subscriber_deleted BOOLEAN,
  release_deleted BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_email TEXT;
  v_account public.subscribers%ROWTYPE;
  v_ticket public.support_tickets%ROWTYPE;
  v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
  v_release public.yutakasa_repair_releases%ROWTYPE;
  v_proof public.yutakasa_ticket_completion_proofs%ROWTYPE;
  v_notice public.yutakasa_ticket_completion_notices%ROWTYPE;
  v_user_message_id UUID;
  v_rows BIGINT;
BEGIN
  IF p_run_id IS NULL OR p_account_id IS NULL OR p_account_updated_at IS NULL OR
     p_ticket_id IS NULL OR p_ticket_updated_at IS NULL OR p_work_id IS NULL OR
     p_pr_number IS NULL OR p_pr_number<1 OR p_admin_message_id IS NULL OR
     p_head_sha IS NULL OR p_head_sha !~ '^[a-f0-9]{40}$' OR
     p_merge_sha IS NULL OR p_merge_sha !~ '^[a-f0-9]{40}$' OR
     p_deployment_id IS NULL OR p_deployment_id !~ '^dpl_[A-Za-z0-9]{8,160}$' THEN
    RAISE EXCEPTION 'invalid full rehearsal identity' USING ERRCODE='22023';
  END IF;
  v_email:='yutakasa-auto-smoke+'||p_run_id::TEXT||'@example.invalid';

  -- Keep the same lock order as the repair and completion RPCs.
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs
    WHERE work_id=p_work_id FOR UPDATE;
  SELECT * INTO v_ticket FROM public.support_tickets
    WHERE id=p_ticket_id FOR UPDATE;
  SELECT * INTO v_account FROM public.subscribers
    WHERE id=p_account_id FOR UPDATE;
  SELECT * INTO v_release FROM public.yutakasa_repair_releases
    WHERE pr_number=p_pr_number FOR UPDATE;
  SELECT * INTO v_proof FROM public.yutakasa_ticket_completion_proofs
    WHERE work_id=p_work_id FOR UPDATE;
  SELECT * INTO v_notice FROM public.yutakasa_ticket_completion_notices
    WHERE work_id=p_work_id FOR UPDATE;

  IF v_account.id IS DISTINCT FROM p_account_id OR
     v_account.email IS DISTINCT FROM v_email OR
     v_account.updated_at IS DISTINCT FROM p_account_updated_at OR
     v_account.name IS DISTINCT FROM 'System monitor test identity (no customer, no payment)' OR
     v_account.status IS DISTINCT FROM 'active' OR
     v_account.subscription_status IS DISTINCT FROM 'active' OR
     v_account.first_payment_date IS NOT NULL OR
     v_account.subscription_started_at IS NOT NULL OR
     v_account.subscription_last_event_at IS NOT NULL OR
     v_account.myasp_data IS DISTINCT FROM jsonb_build_object(
       'automation_test_identity','yutakasa-ai-repair-smoke-v1',
       'source','system_monitor_no_payment','smoke_run_id',p_run_id::TEXT) OR
     (SELECT count(*) FROM public.subscribers WHERE email=v_email)<>1 OR
     (SELECT count(*) FROM public.support_tickets WHERE user_email=v_email)<>1 OR
     EXISTS(SELECT 1 FROM public.chat_threads WHERE user_email=v_email) OR
     EXISTS(SELECT 1 FROM public.otp_codes WHERE email=v_email) THEN
    RAISE EXCEPTION 'synthetic account changed' USING ERRCODE='P0001';
  END IF;

  IF v_ticket.id IS DISTINCT FROM p_ticket_id OR
     v_ticket.user_email IS DISTINCT FROM v_email OR
     v_ticket.updated_at IS DISTINCT FROM p_ticket_updated_at OR
     v_ticket.category IS DISTINCT FROM 'technical' OR
     v_ticket.subject IS DISTINCT FROM 'チャットの見出しが空白になる' OR
     v_ticket.status IS DISTINCT FROM 'resolved' OR
     v_ticket.automation_status IS DISTINCT FROM 'completed' OR
     v_ticket.decision_required IS DISTINCT FROM FALSE OR
     v_ticket.automation_lock_token IS NOT NULL OR
     v_ticket.automation_locked_at IS NOT NULL OR
     v_ticket.user_last_read_at IS NOT NULL OR
     v_ticket.admin_last_read_at IS NOT NULL OR
     EXISTS(SELECT 1 FROM public.support_attachments WHERE ticket_id=p_ticket_id) OR
     EXISTS(SELECT 1 FROM public.yutakasa_ticket_reply_drafts WHERE ticket_id=p_ticket_id) OR
     EXISTS(SELECT 1 FROM public.yutakasa_ticket_clarifications WHERE ticket_id=p_ticket_id) OR
     EXISTS(SELECT 1 FROM public.yutakasa_ticket_clarification_notices WHERE ticket_id=p_ticket_id) THEN
    RAISE EXCEPTION 'synthetic ticket changed' USING ERRCODE='P0001';
  END IF;
  SELECT id INTO v_user_message_id FROM public.support_messages
    WHERE ticket_id=p_ticket_id AND sender_type='user';
  IF (SELECT count(*) FROM public.support_messages WHERE ticket_id=p_ticket_id)<>3 OR
     (SELECT count(*) FROM public.support_messages WHERE ticket_id=p_ticket_id
       AND sender_type='user' AND id=v_user_message_id AND sender_email=v_email
       AND body='チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。'
       AND client_request_id=v_ticket.client_request_id)<>1 OR
     (SELECT count(*) FROM public.support_messages WHERE ticket_id=p_ticket_id
       AND sender_type='system' AND sender_email IS NULL
       AND body='お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。')<>1 OR
     (SELECT count(*) FROM public.support_messages WHERE ticket_id=p_ticket_id
       AND sender_type='admin' AND sender_email IS NULL AND id=p_admin_message_id
       AND client_request_id=p_work_id)<>1 THEN
    RAISE EXCEPTION 'synthetic messages changed' USING ERRCODE='P0001';
  END IF;

  IF v_job.work_id IS DISTINCT FROM p_work_id OR
     v_job.ticket_id IS DISTINCT FROM p_ticket_id OR
     v_job.latest_user_message_id IS DISTINCT FROM v_user_message_id OR
     v_job.status IS DISTINCT FROM 'replied' OR
     v_job.pr_number IS DISTINCT FROM p_pr_number OR
     v_job.head_sha IS DISTINCT FROM p_head_sha OR
     (SELECT count(*) FROM public.yutakasa_ticket_repair_jobs WHERE ticket_id=p_ticket_id)<>1 OR
     (SELECT count(*) FROM public.yutakasa_repair_ticket_links
       WHERE ticket_id=p_ticket_id AND pr_number=p_pr_number
         AND latest_user_message_id=v_user_message_id)<>1 OR
     (SELECT count(*) FROM public.yutakasa_repair_ticket_links
       WHERE ticket_id=p_ticket_id OR pr_number=p_pr_number)<>1 THEN
    RAISE EXCEPTION 'synthetic repair work changed' USING ERRCODE='P0001';
  END IF;
  IF v_release.pr_number IS DISTINCT FROM p_pr_number OR
     v_release.head_sha IS DISTINCT FROM p_head_sha OR
     v_release.merge_sha IS DISTINCT FROM p_merge_sha OR
     v_release.deployment_id IS DISTINCT FROM p_deployment_id OR
     v_release.status IS DISTINCT FROM 'verified' OR
     v_release.verified_at IS NULL OR v_release.healthy_count<3 OR
     v_release.first_healthy_at IS NULL OR v_release.last_healthy_at IS NULL OR
     v_release.last_healthy_at-v_release.first_healthy_at<INTERVAL '20 minutes' OR
     (SELECT count(*) FROM public.yutakasa_repair_observations
       WHERE pr_number=p_pr_number AND healthy AND deployment_id=p_deployment_id)<3 OR
     EXISTS(SELECT 1 FROM public.yutakasa_repair_observations
       WHERE pr_number=p_pr_number AND (NOT healthy OR deployment_id IS DISTINCT FROM p_deployment_id)) THEN
    RAISE EXCEPTION 'synthetic release changed' USING ERRCODE='P0001';
  END IF;
  IF v_proof.work_id IS DISTINCT FROM p_work_id OR
     v_proof.ticket_id IS DISTINCT FROM p_ticket_id OR
     v_proof.latest_user_message_id IS DISTINCT FROM v_user_message_id OR
     v_proof.user_message_sha256 IS DISTINCT FROM
       (SELECT encode(sha256(convert_to(body,'UTF8')),'hex')
        FROM public.support_messages WHERE id=v_user_message_id) OR
     v_proof.pr_number IS DISTINCT FROM p_pr_number OR
     v_proof.head_sha IS DISTINCT FROM p_head_sha OR
     v_proof.merge_sha IS DISTINCT FROM p_merge_sha OR
     v_proof.deployment_id IS DISTINCT FROM p_deployment_id OR
     v_proof.scenario_key IS DISTINCT FROM 'chat_title_zero_width' OR
     v_proof.used_message_id IS DISTINCT FROM p_admin_message_id OR
     (SELECT count(*) FROM public.yutakasa_ticket_completion_proofs
       WHERE ticket_id=p_ticket_id OR pr_number=p_pr_number)<>1 THEN
    RAISE EXCEPTION 'synthetic completion proof changed' USING ERRCODE='P0001';
  END IF;
  IF v_notice.work_id IS DISTINCT FROM p_work_id OR
     v_notice.ticket_id IS DISTINCT FROM p_ticket_id OR
     v_notice.message_id IS DISTINCT FROM p_admin_message_id OR
     v_notice.recipient_email IS DISTINCT FROM v_email OR
     v_notice.ticket_subject IS DISTINCT FROM v_ticket.subject OR
     v_notice.idempotency_key IS DISTINCT FROM
       'yutakasa-ticket-completion/'||p_work_id::TEXT OR
     v_notice.status IS DISTINCT FROM 'suppressed' OR
     v_notice.attempt_count IS DISTINCT FROM 0 OR
     v_notice.first_attempt_at IS NOT NULL OR
     v_notice.claimed_at IS NOT NULL OR v_notice.claim_token IS NOT NULL OR
     v_notice.provider_email_id IS NOT NULL OR v_notice.last_error_code IS NOT NULL OR
     (SELECT count(*) FROM public.yutakasa_ticket_completion_notices
       WHERE ticket_id=p_ticket_id)<>1 THEN
    RAISE EXCEPTION 'synthetic notice changed' USING ERRCODE='P0001';
  END IF;
  IF (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=p_ticket_id)<>4 OR
     (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=p_ticket_id
       AND event_type IN ('automation_claimed','repair_work_queued',
         'repair_pr_linked','repair_ticket_specific_completed'))<>4 OR
     (SELECT count(*) FROM public.support_work_logs WHERE ticket_id=p_ticket_id
       AND event_type='repair_ticket_specific_completed'
       AND metadata @> jsonb_build_object('work_id',p_work_id,
         'pr_number',p_pr_number,'message_id',p_admin_message_id,
         'scenario_key','chat_title_zero_width'))<>1 THEN
    RAISE EXCEPTION 'synthetic work log changed' USING ERRCODE='P0001';
  END IF;

  DELETE FROM public.support_tickets WHERE id=p_ticket_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'synthetic ticket deletion failed' USING ERRCODE='P0001'; END IF;
  DELETE FROM public.subscribers WHERE id=p_account_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'synthetic account deletion failed' USING ERRCODE='P0001'; END IF;
  DELETE FROM public.yutakasa_repair_releases WHERE pr_number=p_pr_number;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'synthetic release deletion failed' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT TRUE,TRUE,TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_yutakasa_full_auto_rehearsal(
  UUID,UUID,TIMESTAMPTZ,UUID,TIMESTAMPTZ,UUID,INTEGER,TEXT,TEXT,TEXT,UUID)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_yutakasa_full_auto_rehearsal(
  UUID,UUID,TIMESTAMPTZ,UUID,TIMESTAMPTZ,UUID,INTEGER,TEXT,TEXT,TEXT,UUID)
  TO service_role;

COMMIT;
NOTIFY pgrst,'reload schema';
