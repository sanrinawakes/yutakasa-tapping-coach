-- Apply after repair-release-ledger.sql. Private ticket-to-PR evidence and an
-- atomic support reply path. The link table never appears in GitHub issues.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_repair_ticket_links (
  pr_number INTEGER NOT NULL REFERENCES public.yutakasa_repair_releases(pr_number),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id),
  latest_user_message_id UUID NOT NULL REFERENCES public.support_messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pr_number, ticket_id, latest_user_message_id),
  UNIQUE (ticket_id, latest_user_message_id)
);
CREATE INDEX IF NOT EXISTS yutakasa_repair_ticket_links_ticket_idx
  ON public.yutakasa_repair_ticket_links(ticket_id);
ALTER TABLE public.yutakasa_repair_ticket_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_repair_ticket_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.yutakasa_repair_ticket_links TO service_role;

-- The user-message RPC inserts before updating its ticket. This trigger takes
-- the ticket lock first, serializing a new user message with the automation
-- reply's latest-message check and preventing a stale answer from winning.
CREATE OR REPLACE FUNCTION public.lock_support_ticket_before_message_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.support_tickets t WHERE t.id = NEW.ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support ticket missing' USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS lock_support_ticket_before_message_insert ON public.support_messages;
CREATE TRIGGER lock_support_ticket_before_message_insert
  BEFORE INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.lock_support_ticket_before_message_insert();

CREATE OR REPLACE FUNCTION public.append_yutakasa_automation_reply(
  p_ticket_id UUID,
  p_lock_token UUID,
  p_latest_user_message_id UUID,
  p_client_request_id UUID,
  p_body TEXT,
  p_resolve BOOLEAN,
  p_pr_number INTEGER DEFAULT NULL
)
RETURNS TABLE(message_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_ticket public.support_tickets%ROWTYPE;
  v_latest UUID;
  v_existing public.support_messages%ROWTYPE;
  v_message_id UUID;
  v_release public.yutakasa_repair_releases%ROWTYPE;
BEGIN
  IF p_ticket_id IS NULL OR p_lock_token IS NULL OR p_latest_user_message_id IS NULL
    OR p_client_request_id IS NULL OR p_body IS NULL OR length(trim(p_body)) < 1
    OR length(p_body) > 10000 OR p_resolve IS NULL OR (p_resolve AND p_pr_number IS NULL)
  THEN
    RAISE EXCEPTION 'invalid automation reply' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support ticket missing' USING ERRCODE = 'P0002';
  END IF;

  -- An uncertain HTTP response can be retried with the same request ID. A
  -- completed transaction returns its original message without sending again.
  SELECT * INTO v_existing FROM public.support_messages m
    WHERE m.ticket_id = p_ticket_id AND m.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.sender_type <> 'admin' OR v_existing.body <> p_body
      OR v_ticket.automation_status <> 'completed'
      OR v_ticket.status <> (CASE WHEN p_resolve THEN 'resolved' ELSE 'waiting_user' END)
    THEN
      RAISE EXCEPTION 'automation reply request conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, FALSE;
    RETURN;
  END IF;

  IF v_ticket.automation_status <> 'investigating'
    OR v_ticket.automation_lock_token IS DISTINCT FROM p_lock_token
    OR v_ticket.decision_required
    OR v_ticket.status NOT IN ('open', 'in_progress')
  THEN
    RAISE EXCEPTION 'automation lock lost' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.id INTO v_latest FROM public.support_messages m
    WHERE m.ticket_id = p_ticket_id AND m.sender_type = 'user'
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_latest_user_message_id THEN
    RAISE EXCEPTION 'newer user message' USING ERRCODE = 'P0001';
  END IF;
  IF p_resolve THEN
    SELECT * INTO v_release FROM public.yutakasa_repair_releases r
      WHERE r.pr_number = p_pr_number AND r.status = 'verified';
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM public.yutakasa_repair_ticket_links l
      WHERE l.pr_number = p_pr_number AND l.ticket_id = p_ticket_id
        AND l.latest_user_message_id = p_latest_user_message_id
    ) THEN
      RAISE EXCEPTION 'repair release evidence missing' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.support_messages(ticket_id,sender_type,sender_email,body,client_request_id)
    VALUES(p_ticket_id,'admin',NULL,p_body,p_client_request_id)
    RETURNING id INTO v_message_id;
  UPDATE public.support_tickets t
    SET status = CASE WHEN p_resolve THEN 'resolved' ELSE 'waiting_user' END,
        automation_status = 'completed',
        automation_locked_at = NULL,
        automation_lock_token = NULL,
        updated_at = clock_timestamp()
    WHERE t.id = p_ticket_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES (
      p_ticket_id,
      CASE WHEN p_resolve THEN 'automation_resolved' ELSE 'automation_replied' END,
      CASE WHEN p_resolve THEN '本番修正の検証後、利用者へ回答しました。'
           ELSE '利用者へ回答し、追加連絡を待っています。' END,
      jsonb_build_object('message_id',v_message_id,'release_pr_number',p_pr_number)
    );
  RETURN QUERY SELECT v_message_id, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_support_ticket_before_message_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.append_yutakasa_automation_reply(UUID,UUID,UUID,UUID,TEXT,BOOLEAN,INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_yutakasa_automation_reply(UUID,UUID,UUID,UUID,TEXT,BOOLEAN,INTEGER)
  TO service_role;

COMMIT;
