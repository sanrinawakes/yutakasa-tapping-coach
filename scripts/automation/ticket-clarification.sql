-- One fixed in-app clarification for an otherwise uninformative first
-- technical report. No model output or caller-provided customer text is sent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_ticket_clarifications (
  ticket_id UUID PRIMARY KEY REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  latest_user_message_id UUID NOT NULL REFERENCES public.support_messages(id) ON DELETE CASCADE,
  reply_message_id UUID NOT NULL UNIQUE REFERENCES public.support_messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.yutakasa_ticket_clarifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_ticket_clarifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.yutakasa_ticket_clarifications TO service_role;

CREATE OR REPLACE FUNCTION public.append_yutakasa_ticket_clarification(
  p_ticket_id UUID,p_lock_token UUID,p_latest_user_message_id UUID,
  p_ticket_version TIMESTAMPTZ
)
RETURNS TABLE(message_id UUID,created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_first_user public.support_messages%ROWTYPE;
DECLARE v_existing public.yutakasa_ticket_clarifications%ROWTYPE;
DECLARE v_reply_id UUID;
DECLARE v_body CONSTANT TEXT :=
  'お問い合わせありがとうございます。状況を確認するため、問題が起きた画面、直前に行った操作、表示されたエラー文（あれば）、発生した日時を教えてください。パスワードや認証コードは送らないでください。';
DECLARE v_ack CONSTANT TEXT :=
  'お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。';
BEGIN
  IF p_ticket_id IS NULL OR p_lock_token IS NULL OR
    p_latest_user_message_id IS NULL OR p_ticket_version IS NULL THEN
    RAISE EXCEPTION 'invalid clarification request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'support ticket missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_existing FROM public.yutakasa_ticket_clarifications c
    WHERE c.ticket_id=p_ticket_id;
  IF FOUND THEN
    IF v_existing.latest_user_message_id IS DISTINCT FROM p_latest_user_message_id THEN
      RAISE EXCEPTION 'clarification already asked for this ticket' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT v_existing.reply_message_id,FALSE; RETURN;
  END IF;
  IF v_ticket.automation_status<>'investigating' OR
    v_ticket.automation_lock_token IS DISTINCT FROM p_lock_token OR
    v_ticket.updated_at IS DISTINCT FROM p_ticket_version OR
    v_ticket.status<>'in_progress' OR v_ticket.category<>'technical' OR
    v_ticket.decision_required OR
    v_ticket.subject NOT IN ('使えない','動かない','エラー','ログインできない',
      'チャットが使えない','送信できない','保存できない','画面が開かない','表示されない') OR
    EXISTS(SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=p_ticket_id) OR
    EXISTS(SELECT 1 FROM public.support_messages m
      WHERE m.ticket_id=p_ticket_id AND m.sender_type='admin') OR
    EXISTS(SELECT 1 FROM public.support_work_logs w
      WHERE w.ticket_id=p_ticket_id AND w.event_type='automation_clarification_sent') THEN
    RAISE EXCEPTION 'clarification not safe for this ticket' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_first_user FROM public.support_messages m
    WHERE m.ticket_id=p_ticket_id AND m.sender_type='user'
    ORDER BY m.created_at,m.id LIMIT 1;
  IF NOT FOUND OR v_first_user.id IS DISTINCT FROM p_latest_user_message_id OR
    v_first_user.body NOT IN ('使えない','動かない','エラー','ログインできない',
      'チャットが使えない','送信できない','保存できない','画面が開かない','表示されない') OR
    (SELECT count(*) FROM public.support_messages m WHERE m.ticket_id=p_ticket_id)<>2 OR
    (SELECT count(*) FROM public.support_messages m WHERE m.ticket_id=p_ticket_id
      AND m.sender_type='system' AND m.body=v_ack)<>1 THEN
    RAISE EXCEPTION 'clarification needs more investigation' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.support_messages(ticket_id,sender_type,sender_email,body,client_request_id)
    VALUES(p_ticket_id,'admin',NULL,v_body,gen_random_uuid()) RETURNING id INTO v_reply_id;
  INSERT INTO public.yutakasa_ticket_clarifications(
    ticket_id,latest_user_message_id,reply_message_id)
    VALUES(p_ticket_id,p_latest_user_message_id,v_reply_id);
  UPDATE public.support_tickets t SET status='waiting_user',automation_status='completed',
    automation_locked_at=NULL,automation_lock_token=NULL,updated_at=clock_timestamp()
    WHERE t.id=p_ticket_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(p_ticket_id,'automation_clarification_sent',
      '情報不足の初回技術問い合わせに、固定文面で画面・操作・エラー・発生日時を質問しました。',
      jsonb_build_object('message_id',v_reply_id,'latest_user_message_id',p_latest_user_message_id));
  RETURN QUERY SELECT v_reply_id,TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.append_yutakasa_ticket_clarification(UUID,UUID,UUID,TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_yutakasa_ticket_clarification(UUID,UUID,UUID,TIMESTAMPTZ)
  TO service_role;

COMMIT;
