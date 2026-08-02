-- In-app support tickets for 豊かさBOT.
-- All access is server-side through the service role. The client never receives
-- a Supabase key and cannot query these tables directly.

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL REFERENCES subscribers(email),
  category TEXT NOT NULL CHECK (
    category IN ('technical', 'login', 'quality', 'how_to', 'feature', 'billing', 'other')
  ),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'in_progress', 'waiting_user', 'resolved')
  ),
  decision_required BOOLEAN NOT NULL DEFAULT FALSE,
  automation_status TEXT NOT NULL DEFAULT 'queued' CHECK (
    automation_status IN ('queued', 'investigating', 'blocked_decision', 'completed', 'failed')
  ),
  automation_locked_at TIMESTAMPTZ,
  automation_lock_token UUID,
  user_last_read_at TIMESTAMPTZ,
  admin_last_read_at TIMESTAMPTZ,
  client_request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_email, client_request_id)
);

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin', 'system')),
  sender_email TEXT,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  client_request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticket_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS support_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_work_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 5000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_updated
  ON support_tickets(user_email, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_admin_queue
  ON support_tickets(decision_required, automation_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_created
  ON support_messages(ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_support_work_logs_ticket_created
  ON support_work_logs(ticket_id, created_at ASC);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_work_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on support_tickets" ON support_tickets;
CREATE POLICY "Service role full access on support_tickets"
  ON support_tickets FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role full access on support_messages" ON support_messages;
CREATE POLICY "Service role full access on support_messages"
  ON support_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role full access on support_attachments" ON support_attachments;
CREATE POLICY "Service role full access on support_attachments"
  ON support_attachments FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role full access on support_work_logs" ON support_work_logs;
CREATE POLICY "Service role full access on support_work_logs"
  ON support_work_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'yutakasa-support',
  'yutakasa-support',
  false,
  4194304,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE support_attachments
  DROP CONSTRAINT IF EXISTS support_attachments_size_bytes_check;
ALTER TABLE support_attachments
  ADD CONSTRAINT support_attachments_size_bytes_check
  CHECK (size_bytes BETWEEN 1 AND 4194304);

CREATE OR REPLACE FUNCTION create_support_ticket_with_message(
  p_user_email TEXT,
  p_category TEXT,
  p_subject TEXT,
  p_body TEXT,
  p_client_request_id UUID,
  p_decision_required BOOLEAN,
  p_attachments JSONB DEFAULT '[]'::jsonb
)
RETURNS TABLE(ticket_id UUID, message_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_id UUID;
  v_message_id UUID;
  v_created BOOLEAN := FALSE;
  v_attachment JSONB;
BEGIN
  INSERT INTO support_tickets (
    user_email,
    category,
    subject,
    decision_required,
    automation_status,
    client_request_id
  )
  VALUES (
    p_user_email,
    p_category,
    p_subject,
    p_decision_required,
    CASE WHEN p_decision_required THEN 'blocked_decision' ELSE 'queued' END,
    p_client_request_id
  )
  ON CONFLICT (user_email, client_request_id) DO NOTHING
  RETURNING id INTO v_ticket_id;

  IF v_ticket_id IS NULL THEN
    SELECT id INTO v_ticket_id
    FROM support_tickets
    WHERE user_email = p_user_email
      AND client_request_id = p_client_request_id;

    SELECT support_messages.id INTO v_message_id
    FROM support_messages
    WHERE support_messages.ticket_id = v_ticket_id
      AND support_messages.client_request_id = p_client_request_id;

    RETURN QUERY SELECT v_ticket_id, v_message_id, FALSE;
    RETURN;
  END IF;

  v_created := TRUE;

  INSERT INTO support_messages (
    ticket_id,
    sender_type,
    sender_email,
    body,
    client_request_id
  )
  VALUES (
    v_ticket_id,
    'user',
    p_user_email,
    p_body,
    p_client_request_id
  )
  RETURNING id INTO v_message_id;

  FOR v_attachment IN SELECT * FROM jsonb_array_elements(p_attachments)
  LOOP
    INSERT INTO support_attachments (
      ticket_id,
      message_id,
      storage_path,
      filename,
      content_type,
      size_bytes
    )
    VALUES (
      v_ticket_id,
      v_message_id,
      v_attachment->>'storage_path',
      v_attachment->>'filename',
      v_attachment->>'content_type',
      (v_attachment->>'size_bytes')::INTEGER
    );
  END LOOP;

  INSERT INTO support_messages (
    ticket_id,
    sender_type,
    sender_email,
    body,
    client_request_id
  )
  VALUES (
    v_ticket_id,
    'system',
    NULL,
    'お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。',
    gen_random_uuid()
  );

  RETURN QUERY SELECT v_ticket_id, v_message_id, v_created;
END;
$$;

CREATE OR REPLACE FUNCTION append_support_user_message(
  p_user_email TEXT,
  p_ticket_id UUID,
  p_body TEXT,
  p_client_request_id UUID,
  p_decision_required BOOLEAN,
  p_attachments JSONB DEFAULT '[]'::jsonb
)
RETURNS TABLE(message_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message_id UUID;
  v_attachment JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM support_tickets
    WHERE id = p_ticket_id AND user_email = p_user_email
  ) THEN
    RAISE EXCEPTION 'support ticket not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO support_messages (
    ticket_id,
    sender_type,
    sender_email,
    body,
    client_request_id
  )
  VALUES (
    p_ticket_id,
    'user',
    p_user_email,
    p_body,
    p_client_request_id
  )
  ON CONFLICT (ticket_id, client_request_id) DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    SELECT support_messages.id INTO v_message_id
    FROM support_messages
    WHERE support_messages.ticket_id = p_ticket_id
      AND support_messages.client_request_id = p_client_request_id;
    RETURN QUERY SELECT v_message_id, FALSE;
    RETURN;
  END IF;

  FOR v_attachment IN SELECT * FROM jsonb_array_elements(p_attachments)
  LOOP
    INSERT INTO support_attachments (
      ticket_id,
      message_id,
      storage_path,
      filename,
      content_type,
      size_bytes
    )
    VALUES (
      p_ticket_id,
      v_message_id,
      v_attachment->>'storage_path',
      v_attachment->>'filename',
      v_attachment->>'content_type',
      (v_attachment->>'size_bytes')::INTEGER
    );
  END LOOP;

  UPDATE support_tickets
  SET
    status = 'open',
    decision_required = decision_required OR p_decision_required,
    automation_status = CASE
      WHEN decision_required OR p_decision_required THEN 'blocked_decision'
      ELSE 'queued'
    END,
    automation_locked_at = NULL,
    automation_lock_token = NULL,
    updated_at = NOW()
  WHERE id = p_ticket_id;

  RETURN QUERY SELECT v_message_id, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION append_support_admin_message(
  p_ticket_id UUID,
  p_body TEXT,
  p_client_request_id UUID,
  p_resolve BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(message_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM support_tickets WHERE id = p_ticket_id) THEN
    RAISE EXCEPTION 'support ticket not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO support_messages (
    ticket_id,
    sender_type,
    sender_email,
    body,
    client_request_id
  )
  VALUES (
    p_ticket_id,
    'admin',
    NULL,
    p_body,
    p_client_request_id
  )
  ON CONFLICT (ticket_id, client_request_id) DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    SELECT support_messages.id INTO v_message_id
    FROM support_messages
    WHERE support_messages.ticket_id = p_ticket_id
      AND support_messages.client_request_id = p_client_request_id;
    RETURN QUERY SELECT v_message_id, FALSE;
    RETURN;
  END IF;

  UPDATE support_tickets
  SET
    status = CASE WHEN p_resolve THEN 'resolved' ELSE 'waiting_user' END,
    automation_status = 'completed',
    automation_locked_at = NULL,
    automation_lock_token = NULL,
    updated_at = NOW()
  WHERE id = p_ticket_id;

  RETURN QUERY SELECT v_message_id, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION create_support_ticket_with_message(TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION append_support_user_message(TEXT, UUID, TEXT, UUID, BOOLEAN, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION append_support_admin_message(UUID, TEXT, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_support_ticket_with_message(TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION append_support_user_message(TEXT, UUID, TEXT, UUID, BOOLEAN, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION append_support_admin_message(UUID, TEXT, UUID, BOOLEAN) TO service_role;
