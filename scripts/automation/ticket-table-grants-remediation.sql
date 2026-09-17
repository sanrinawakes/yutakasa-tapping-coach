-- Idempotent production remediation if both ticket migrations were already applied.
-- SECURITY DEFINER RPCs retain their writes through the function owner.
BEGIN;
REVOKE ALL ON TABLE public.yutakasa_ticket_reply_drafts FROM service_role;
GRANT SELECT ON TABLE public.yutakasa_ticket_reply_drafts TO service_role;
REVOKE ALL ON TABLE public.yutakasa_ticket_clarifications FROM service_role;
GRANT SELECT ON TABLE public.yutakasa_ticket_clarifications TO service_role;
COMMIT;
