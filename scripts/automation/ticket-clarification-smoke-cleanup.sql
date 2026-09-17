-- Only the isolated example.invalid clarification fixture may be removed.
-- Apply after ticket-clarification.sql. The checks and deletes share one lock
-- and transaction so a changed ticket is retained for investigation.
BEGIN;

DROP FUNCTION IF EXISTS public.cleanup_yutakasa_ticket_clarification_smoke(UUID,UUID);

CREATE OR REPLACE FUNCTION public.cleanup_yutakasa_ticket_clarification_smoke(
  p_run_id UUID, p_client_request_id UUID, p_lock_token UUID
)
RETURNS TABLE(cleaned BOOLEAN, ticket_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_email TEXT;
DECLARE v_account public.subscribers%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_user public.support_messages%ROWTYPE;
DECLARE v_reply public.support_messages%ROWTYPE;
DECLARE v_ledger public.yutakasa_ticket_clarifications%ROWTYPE;
DECLARE v_count INTEGER;
DECLARE v_unexpected BOOLEAN;
DECLARE v_expected_ack CONSTANT TEXT :=
  'お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。';
DECLARE v_expected_reply CONSTANT TEXT :=
  'お問い合わせありがとうございます。状況を確認するため、問題が起きた画面、直前に行った操作、表示されたエラー文（あれば）、発生した日時を教えてください。パスワードや認証コードは送らないでください。';
BEGIN
  IF p_run_id IS NULL OR p_client_request_id IS NULL OR p_lock_token IS NULL THEN
    RAISE EXCEPTION 'invalid clarification smoke cleanup' USING ERRCODE='22023';
  END IF;
  v_email:='yutakasa-auto-smoke+'||p_run_id::TEXT||'@example.invalid';
  SELECT * INTO v_account FROM public.subscribers s WHERE s.email=v_email FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.user_email=v_email) THEN
      RAISE EXCEPTION 'clarification smoke account missing but ticket remains' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT FALSE,NULL::UUID;
    RETURN;
  END IF;
  IF v_account.myasp_data IS DISTINCT FROM jsonb_build_object(
      'automation_test_identity','yutakasa-clarification-smoke-v1',
      'source','system_monitor_no_payment','smoke_run_id',p_run_id::TEXT) OR
    v_account.name IS DISTINCT FROM
      'System monitor clarification test (no customer, no payment)' OR
    v_account.status IS DISTINCT FROM 'active' OR
    v_account.subscription_status IS DISTINCT FROM 'active' OR
    v_account.first_payment_date IS NOT NULL OR
    v_account.subscription_started_at IS NOT NULL OR
    v_account.subscription_last_event_at IS NOT NULL THEN
    RAISE EXCEPTION 'clarification smoke identity changed' USING ERRCODE='P0001';
  END IF;
  IF to_regclass('public.chat_threads') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.chat_threads WHERE user_email=$1)'
      INTO v_unexpected USING v_email;
    IF v_unexpected THEN
      RAISE EXCEPTION 'clarification smoke has chat data' USING ERRCODE='P0001';
    END IF;
  END IF;
  IF to_regclass('public.otp_codes') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.otp_codes WHERE email=$1)'
      INTO v_unexpected USING v_email;
    IF v_unexpected THEN
      RAISE EXCEPTION 'clarification smoke has otp data' USING ERRCODE='P0001';
    END IF;
  END IF;
  SELECT count(*) INTO v_count FROM public.support_tickets t WHERE t.user_email=v_email;
  IF v_count>1 THEN
    RAISE EXCEPTION 'clarification smoke has extra tickets' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.user_email=v_email FOR UPDATE;
  IF FOUND THEN
    IF v_ticket.client_request_id IS DISTINCT FROM p_client_request_id OR
      v_ticket.category IS DISTINCT FROM 'technical' OR
      v_ticket.subject IS DISTINCT FROM '使えない' OR
      v_ticket.decision_required IS DISTINCT FROM FALSE OR
      v_ticket.user_last_read_at IS NOT NULL OR
      v_ticket.admin_last_read_at IS NOT NULL OR
      EXISTS(SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=v_ticket.id) OR
      EXISTS(SELECT 1 FROM public.yutakasa_repair_ticket_links l WHERE l.ticket_id=v_ticket.id) OR
      EXISTS(SELECT 1 FROM public.yutakasa_ticket_repair_jobs j WHERE j.ticket_id=v_ticket.id) OR
      EXISTS(SELECT 1 FROM public.yutakasa_ticket_reply_drafts d WHERE d.ticket_id=v_ticket.id) THEN
      RAISE EXCEPTION 'clarification smoke ticket changed' USING ERRCODE='P0001';
    END IF;
    SELECT count(*) INTO v_count FROM public.support_messages m WHERE m.ticket_id=v_ticket.id;
    IF v_count NOT IN (2,3) THEN
      RAISE EXCEPTION 'clarification smoke messages changed' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_user FROM public.support_messages m
      WHERE m.ticket_id=v_ticket.id AND m.sender_type='user';
    IF NOT FOUND OR v_user.sender_email IS DISTINCT FROM v_email OR
      v_user.body IS DISTINCT FROM '使えない' OR
      v_user.client_request_id IS DISTINCT FROM p_client_request_id OR
      (SELECT count(*) FROM public.support_messages m
        WHERE m.ticket_id=v_ticket.id AND m.sender_type='user')<>1 OR
      (SELECT count(*) FROM public.support_messages m WHERE m.ticket_id=v_ticket.id
        AND m.sender_type='system' AND m.sender_email IS NULL
        AND m.body=v_expected_ack)<>1 THEN
      RAISE EXCEPTION 'clarification smoke initial messages changed' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_ledger FROM public.yutakasa_ticket_clarifications c
      WHERE c.ticket_id=v_ticket.id;
    IF v_count=2 THEN
      IF FOUND OR EXISTS(SELECT 1 FROM public.yutakasa_ticket_clarification_notices n
          WHERE n.ticket_id=v_ticket.id) OR
        EXISTS(SELECT 1 FROM public.support_messages m
          WHERE m.ticket_id=v_ticket.id AND m.sender_type='admin') OR
        (v_ticket.status='open' AND v_ticket.automation_status='queued' AND
          v_ticket.automation_lock_token IS NULL AND
          v_ticket.automation_locked_at IS NULL AND
          (SELECT count(*) FROM public.support_work_logs w WHERE w.ticket_id=v_ticket.id)=0)
          IS DISTINCT FROM TRUE AND
        (v_ticket.status='in_progress' AND v_ticket.automation_status='investigating' AND
          v_ticket.automation_lock_token=p_lock_token AND
          v_ticket.automation_locked_at IS NOT NULL AND
          (SELECT count(*) FROM public.support_work_logs w WHERE w.ticket_id=v_ticket.id
            AND w.event_type='automation_claimed' AND
            w.summary='Codexが技術調査を開始しました。' AND
            w.metadata='{}'::jsonb)=1 AND
          (SELECT count(*) FROM public.support_work_logs w WHERE w.ticket_id=v_ticket.id)=1)
          IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'clarification smoke pending state changed' USING ERRCODE='P0001';
      END IF;
    ELSE
      SELECT * INTO v_reply FROM public.support_messages m
        WHERE m.ticket_id=v_ticket.id AND m.sender_type='admin';
      IF v_ledger.ticket_id IS DISTINCT FROM v_ticket.id OR
        v_ledger.latest_user_message_id IS DISTINCT FROM v_user.id OR
        v_ledger.reply_message_id IS DISTINCT FROM v_reply.id OR
        (SELECT count(*) FROM public.yutakasa_ticket_clarification_notices n
          WHERE n.ticket_id=v_ticket.id AND n.message_id=v_reply.id AND
            n.recipient_email=v_email AND n.status='suppressed' AND
            n.provider_email_id IS NULL AND n.attempt_count=0 AND
            n.first_attempt_at IS NULL AND
            n.idempotency_key='yutakasa-ticket-clarification/'||v_ticket.id::TEXT)<>1 OR
        v_reply.sender_email IS NOT NULL OR
        v_reply.body IS DISTINCT FROM v_expected_reply OR
        v_ticket.status IS DISTINCT FROM 'waiting_user' OR
        v_ticket.automation_status IS DISTINCT FROM 'completed' OR
        v_ticket.automation_lock_token IS NOT NULL OR
        v_ticket.automation_locked_at IS NOT NULL OR
        (SELECT count(*) FROM public.support_messages m WHERE m.ticket_id=v_ticket.id
          AND m.sender_type='admin')<>1 OR
        (SELECT count(*) FROM public.support_work_logs w WHERE w.ticket_id=v_ticket.id
          AND w.event_type='automation_claimed' AND
          w.summary='Codexが技術調査を開始しました。' AND
          w.metadata='{}'::jsonb)<>1 OR
        (SELECT count(*) FROM public.support_work_logs w WHERE w.ticket_id=v_ticket.id
          AND w.event_type='automation_clarification_sent' AND
          w.summary='情報不足の初回技術問い合わせに、固定文面で画面・操作・エラー・発生日時を質問しました。' AND
          w.metadata=jsonb_build_object('message_id',v_reply.id,
            'latest_user_message_id',v_user.id))<>1 OR
        (SELECT count(*) FROM public.support_work_logs w WHERE w.ticket_id=v_ticket.id)<>2 THEN
        RAISE EXCEPTION 'clarification smoke completed state changed' USING ERRCODE='P0001';
      END IF;
    END IF;
    DELETE FROM public.support_tickets t WHERE t.id=v_ticket.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count<>1 THEN
      RAISE EXCEPTION 'clarification smoke ticket delete failed' USING ERRCODE='P0001';
    END IF;
  END IF;
  DELETE FROM public.subscribers s WHERE s.id=v_account.id AND s.email=v_email;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'clarification smoke identity delete failed' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT TRUE,v_ticket.id;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_yutakasa_ticket_clarification_smoke(UUID,UUID,UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_yutakasa_ticket_clarification_smoke(UUID,UUID,UUID)
  TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
