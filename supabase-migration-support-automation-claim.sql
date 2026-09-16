-- Additive migration after the support schema. Claiming a ticket and recording
-- the claim must succeed or fail together; a failed log insert cannot strand a
-- ticket in investigating state for the stale-lock timeout.

CREATE OR REPLACE FUNCTION public.claim_support_ticket_with_log(
  p_ticket_id UUID,
  p_lock_token UUID
)
RETURNS SETOF public.support_tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ticket public.support_tickets%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  UPDATE public.support_tickets AS t
  SET automation_status = 'investigating',
      automation_locked_at = v_now,
      automation_lock_token = p_lock_token,
      status = 'in_progress',
      updated_at = v_now
  WHERE t.id = p_ticket_id
    AND t.decision_required = FALSE
    AND t.automation_status IN ('queued', 'failed')
    AND t.status IN ('open', 'in_progress')
    AND t.automation_locked_at IS NULL
    AND p_lock_token IS NOT NULL
  RETURNING t.* INTO v_ticket;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.support_work_logs (ticket_id, event_type, summary, metadata)
  VALUES (
    p_ticket_id, 'automation_claimed',
    'Codexが技術調査を開始しました。', '{}'::jsonb
  );

  RETURN NEXT v_ticket;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_support_ticket_with_log(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_support_ticket_with_log(UUID, UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';
