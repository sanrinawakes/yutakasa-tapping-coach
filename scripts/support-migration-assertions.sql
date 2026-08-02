DO $$
DECLARE
  v_ticket_id UUID;
  v_message_id UUID;
  v_followup_id UUID := 'b9e557f2-27f8-45a2-88e1-74cadf9e51fd';
  v_admin_id UUID := '1495d93d-d2db-453c-8271-61990304b525';
  v_result RECORD;
BEGIN
  INSERT INTO subscribers(email) VALUES
    ('member@example.com'),
    ('other@example.com');

  SELECT * INTO v_result
  FROM create_support_ticket_with_message(
    'member@example.com',
    'technical',
    '履歴が表示されない',
    '画面を更新しても表示されません。',
    '2e4710db-9274-4e4c-96c4-59dc97e21c8d',
    FALSE,
    '[{"storage_path":"member/request/screen.jpg","filename":"screen.jpg","content_type":"image/jpeg","size_bytes":321}]'::jsonb
  );

  IF NOT v_result.created THEN
    RAISE EXCEPTION 'first ticket insert was not created';
  END IF;
  v_ticket_id := v_result.ticket_id;
  v_message_id := v_result.message_id;

  IF (SELECT count(*) FROM support_tickets) <> 1 OR
     (SELECT count(*) FROM support_messages) <> 2 OR
     (SELECT count(*) FROM support_attachments) <> 1 THEN
    RAISE EXCEPTION 'initial ticket rows did not persist atomically';
  END IF;

  SELECT * INTO v_result
  FROM create_support_ticket_with_message(
    'member@example.com',
    'technical',
    '履歴が表示されない',
    '画面を更新しても表示されません。',
    '2e4710db-9274-4e4c-96c4-59dc97e21c8d',
    FALSE,
    '[]'::jsonb
  );

  IF v_result.created OR v_result.ticket_id <> v_ticket_id OR
     v_result.message_id <> v_message_id THEN
    RAISE EXCEPTION 'idempotent ticket retry returned a different row';
  END IF;
  IF (SELECT count(*) FROM support_tickets) <> 1 OR
     (SELECT count(*) FROM support_messages) <> 2 THEN
    RAISE EXCEPTION 'idempotent ticket retry created duplicates';
  END IF;

  BEGIN
    PERFORM * FROM append_support_user_message(
      'other@example.com',
      v_ticket_id,
      '他人の追記',
      '591e68aa-a902-411d-ae38-e58debc82875',
      FALSE,
      '[]'::jsonb
    );
    RAISE EXCEPTION 'cross-user message append unexpectedly succeeded';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN NULL;
  END;

  SELECT * INTO v_result
  FROM append_support_user_message(
    'member@example.com',
    v_ticket_id,
    '返金も相談したいです。',
    v_followup_id,
    TRUE,
    '[]'::jsonb
  );
  IF NOT v_result.created THEN
    RAISE EXCEPTION 'user follow-up was not created';
  END IF;
  IF NOT (SELECT decision_required FROM support_tickets WHERE id = v_ticket_id) OR
     (SELECT automation_status FROM support_tickets WHERE id = v_ticket_id) <> 'blocked_decision' THEN
    RAISE EXCEPTION 'owner decision did not block automation';
  END IF;

  SELECT * INTO v_result
  FROM append_support_user_message(
    'member@example.com',
    v_ticket_id,
    '返金も相談したいです。',
    v_followup_id,
    TRUE,
    '[]'::jsonb
  );
  IF v_result.created OR (SELECT count(*) FROM support_messages) <> 3 THEN
    RAISE EXCEPTION 'idempotent message retry created duplicates';
  END IF;

  SELECT * INTO v_result
  FROM append_support_admin_message(
    v_ticket_id,
    '確認結果をご連絡します。',
    v_admin_id,
    TRUE
  );
  IF NOT v_result.created THEN
    RAISE EXCEPTION 'admin reply was not created';
  END IF;
  IF (SELECT status FROM support_tickets WHERE id = v_ticket_id) <> 'resolved' OR
     (SELECT automation_status FROM support_tickets WHERE id = v_ticket_id) <> 'completed' THEN
    RAISE EXCEPTION 'admin resolution did not complete the ticket';
  END IF;

  SELECT * INTO v_result
  FROM append_support_admin_message(
    v_ticket_id,
    '確認結果をご連絡します。',
    v_admin_id,
    TRUE
  );
  IF v_result.created OR (SELECT count(*) FROM support_messages) <> 4 THEN
    RAISE EXCEPTION 'idempotent admin reply created duplicates';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'yutakasa-support'
      AND public = FALSE
      AND file_size_limit = 5242880
      AND allowed_mime_types @> ARRAY['image/png', 'image/jpeg']
  ) THEN
    RAISE EXCEPTION 'private attachment bucket configuration is incorrect';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON support_tickets, support_messages, support_attachments, support_work_logs
  TO authenticated;

SET ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM support_tickets) <> 0 THEN
    RAISE EXCEPTION 'RLS exposed support tickets to authenticated clients';
  END IF;

  BEGIN
    PERFORM * FROM create_support_ticket_with_message(
      'member@example.com',
      'technical',
      '不正な作成',
      'クライアントから直接作成',
      '7985856e-a3a1-4869-8174-313b311e0b04',
      FALSE,
      '[]'::jsonb
    );
    RAISE EXCEPTION 'authenticated role unexpectedly executed support RPC';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SELECT
  (SELECT count(*) FROM support_tickets) AS tickets,
  (SELECT count(*) FROM support_messages) AS messages,
  (SELECT count(*) FROM support_attachments) AS attachments,
  'support migration assertions passed' AS result;
