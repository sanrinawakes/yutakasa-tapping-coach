-- Apply before deploying the worker/API that sends the manual_review outcome.
-- A manual review is terminal for automation; the existing queue reads only
-- queued and failed tickets. No customer message or notification is written.
BEGIN;

ALTER TABLE public.support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_automation_status_check;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_automation_status_check CHECK (
    automation_status IN ('queued','investigating','awaiting_repair','manual_review',
      'blocked_decision','completed','failed')
  );

CREATE OR REPLACE FUNCTION public.finish_locked_support_ticket(
  p_ticket_id UUID,
  p_lock_token UUID,
  p_ticket_version TIMESTAMPTZ,
  p_latest_user_message_id UUID,
  p_outcome TEXT,
  p_summary TEXT
)
RETURNS SETOF public.support_tickets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_ticket public.support_tickets%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('failed','decision_required','manual_review') THEN
    RAISE EXCEPTION 'invalid automation outcome' USING ERRCODE = '22023';
  END IF;

  UPDATE public.support_tickets AS t
  SET automation_status = CASE p_outcome
        WHEN 'decision_required' THEN 'blocked_decision'
        WHEN 'manual_review' THEN 'manual_review'
        ELSE 'failed'
      END,
      decision_required = CASE WHEN p_outcome = 'decision_required' THEN TRUE
        ELSE t.decision_required END,
      automation_locked_at = NULL,
      automation_lock_token = NULL,
      updated_at = clock_timestamp()
  WHERE t.id = p_ticket_id
    AND t.automation_lock_token = p_lock_token
    AND t.automation_status = 'investigating'
    AND t.decision_required = FALSE
    AND t.status = 'in_progress'
    AND t.updated_at = p_ticket_version
    AND (
      SELECT m.id FROM public.support_messages AS m
      WHERE m.ticket_id = t.id AND m.sender_type = 'user'
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ) = p_latest_user_message_id
  RETURNING t.* INTO v_ticket;

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.support_work_logs (ticket_id,event_type,summary,metadata)
  VALUES (p_ticket_id,
    CASE p_outcome
      WHEN 'decision_required' THEN 'owner_decision_required'
      WHEN 'manual_review' THEN 'automation_manual_review'
      ELSE 'automation_failed'
    END,
    p_summary,'{}'::jsonb);

  RETURN NEXT v_ticket;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_locked_support_ticket(UUID,UUID,TIMESTAMPTZ,UUID,TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_locked_support_ticket(UUID,UUID,TIMESTAMPTZ,UUID,TEXT,TEXT)
  TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
