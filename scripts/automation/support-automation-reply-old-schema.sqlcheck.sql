-- Emulate the first draft to verify that a rerun removes unsafe overloads
-- and restrictive relationships before production deployment.
CREATE FUNCTION public.append_yutakasa_automation_reply(
  UUID,UUID,UUID,UUID,TEXT,BOOLEAN,INTEGER
) RETURNS INTEGER LANGUAGE SQL AS 'SELECT 1';
GRANT EXECUTE ON FUNCTION public.append_yutakasa_automation_reply(
  UUID,UUID,UUID,UUID,TEXT,BOOLEAN,INTEGER
) TO service_role;
ALTER TABLE public.yutakasa_repair_ticket_links
  ADD CONSTRAINT yutakasa_repair_ticket_links_ticket_id_latest_user_message_id_key
  UNIQUE (ticket_id,latest_user_message_id),
  DROP CONSTRAINT yutakasa_repair_ticket_links_ticket_id_fkey,
  DROP CONSTRAINT yutakasa_repair_ticket_links_latest_user_message_id_fkey;
ALTER TABLE public.yutakasa_repair_ticket_links
  ADD CONSTRAINT yutakasa_repair_ticket_links_ticket_id_fkey
    FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id),
  ADD CONSTRAINT yutakasa_repair_ticket_links_latest_user_message_id_fkey
    FOREIGN KEY (latest_user_message_id) REFERENCES public.support_messages(id);
