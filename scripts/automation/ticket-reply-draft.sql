-- Private, review-only reply drafts for a release linked to one support ticket.
-- This migration deliberately creates no customer-send path.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_ticket_reply_drafts (
  work_id UUID PRIMARY KEY REFERENCES public.yutakasa_ticket_repair_jobs(work_id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  latest_user_message_id UUID NOT NULL REFERENCES public.support_messages(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL REFERENCES public.yutakasa_repair_releases(pr_number) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 1000),
  used_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (ticket_id, latest_user_message_id, pr_number)
);
ALTER TABLE public.yutakasa_ticket_reply_drafts
  ADD COLUMN IF NOT EXISTS used_message_id UUID;
CREATE INDEX IF NOT EXISTS yutakasa_ticket_reply_drafts_ticket_idx
  ON public.yutakasa_ticket_reply_drafts(ticket_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS yutakasa_ticket_reply_drafts_used_message_idx
  ON public.yutakasa_ticket_reply_drafts(used_message_id)
  WHERE used_message_id IS NOT NULL;
ALTER TABLE public.yutakasa_ticket_reply_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_ticket_reply_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.yutakasa_ticket_reply_drafts TO service_role;

-- The private context is returned only to a service-role caller after release
-- verification. It must never be written to a GitHub log, issue or PR.
CREATE OR REPLACE FUNCTION public.get_yutakasa_ticket_reply_draft_context(p_work_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_release public.yutakasa_repair_releases%ROWTYPE;
DECLARE v_messages JSONB;
BEGIN
  IF p_work_id IS NULL THEN
    RAISE EXCEPTION 'invalid reply draft work' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'pr_open' OR v_job.pr_number IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  SELECT * INTO v_release FROM public.yutakasa_repair_releases r
    WHERE r.pr_number=v_job.pr_number;
  IF NOT FOUND OR v_release.status<>'verified' OR v_release.verified_at IS NULL
    OR v_release.merge_sha IS NULL OR v_release.deployment_id IS NULL
    OR v_ticket.automation_status<>'awaiting_repair'
    OR v_ticket.status<>'in_progress' OR v_ticket.category<>'technical'
    OR v_ticket.decision_required
    OR EXISTS(SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=v_job.ticket_id)
    OR v_job.latest_user_message_id IS DISTINCT FROM (
      SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM public.yutakasa_repair_ticket_links l
      WHERE l.pr_number=v_job.pr_number AND l.ticket_id=v_job.ticket_id
        AND l.latest_user_message_id=v_job.latest_user_message_id) THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_agg(jsonb_build_object('id',m.id,'sender_type',m.sender_type,
    'body',m.body,'created_at',m.created_at) ORDER BY m.created_at,m.id)
    INTO v_messages FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id;
  IF v_messages IS NULL OR jsonb_array_length(v_messages)>500 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('work_id',v_job.work_id,'ticket_id',v_job.ticket_id,
    'latest_user_message_id',v_job.latest_user_message_id,
    'pr_number',v_job.pr_number,'merge_sha',v_release.merge_sha,
    'deployment_id',v_release.deployment_id,'subject',v_ticket.subject,
    'category',v_ticket.category,'messages',v_messages,
    'draft_exists',EXISTS(SELECT 1 FROM public.yutakasa_ticket_reply_drafts d
      WHERE d.work_id=p_work_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.save_yutakasa_ticket_reply_draft(
  p_work_id UUID,p_latest_user_message_id UUID,p_pr_number INTEGER,p_body TEXT
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_context JSONB;
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_existing public.yutakasa_ticket_reply_drafts%ROWTYPE;
BEGIN
  IF p_work_id IS NULL OR p_latest_user_message_id IS NULL OR p_pr_number IS NULL
    OR p_pr_number<1 OR p_body IS NULL OR length(trim(p_body)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid reply draft' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reply draft work missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_existing FROM public.yutakasa_ticket_reply_drafts d WHERE d.work_id=p_work_id;
  IF FOUND THEN
    IF v_existing.body IS DISTINCT FROM p_body OR v_existing.pr_number IS DISTINCT FROM p_pr_number
      OR v_existing.latest_user_message_id IS DISTINCT FROM p_latest_user_message_id THEN
      RAISE EXCEPTION 'reply draft conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT FALSE; RETURN;
  END IF;
  v_context:=public.get_yutakasa_ticket_reply_draft_context(p_work_id);
  IF v_context IS NULL OR (v_context->>'latest_user_message_id')::UUID IS DISTINCT FROM p_latest_user_message_id
    OR (v_context->>'pr_number')::INTEGER IS DISTINCT FROM p_pr_number THEN
    RAISE EXCEPTION 'reply draft context changed' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.yutakasa_ticket_reply_drafts(
    work_id,ticket_id,latest_user_message_id,pr_number,body
  ) VALUES(p_work_id,(v_context->>'ticket_id')::UUID,p_latest_user_message_id,p_pr_number,p_body);
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES((v_context->>'ticket_id')::UUID,'repair_reply_draft',
      '本番反映後の返信案を作成しました。問い合わせ固有の解消確認がないため、担当者の確認が必要です。顧客返信は行っていません。',
      jsonb_build_object('work_id',p_work_id,'pr_number',p_pr_number));
  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.get_yutakasa_ticket_reply_draft_context(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_yutakasa_ticket_reply_draft(UUID,UUID,INTEGER,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_yutakasa_ticket_reply_draft_context(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_yutakasa_ticket_reply_draft(UUID,UUID,INTEGER,TEXT) TO service_role;

-- When an administrator uses a draft, reject a send if the customer has
-- written again since that draft. The ticket row lock serializes this check
-- with the support_messages insert trigger and preserves idempotent retries.
DROP FUNCTION IF EXISTS public.append_support_admin_message_checked(UUID,TEXT,UUID,BOOLEAN,UUID);
CREATE OR REPLACE FUNCTION public.append_support_admin_message_checked(
  p_ticket_id UUID,p_body TEXT,p_client_request_id UUID,p_resolve BOOLEAN,
  p_expected_latest_user_message_id UUID,p_work_id UUID
)
RETURNS TABLE(message_id UUID,created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_existing public.support_messages%ROWTYPE;
DECLARE v_draft public.yutakasa_ticket_reply_drafts%ROWTYPE;
DECLARE v_latest UUID;
DECLARE v_message_id UUID;
DECLARE v_created BOOLEAN;
BEGIN
  IF p_ticket_id IS NULL OR p_client_request_id IS NULL
    OR p_expected_latest_user_message_id IS NULL OR p_work_id IS NULL OR p_body IS NULL
    OR length(trim(p_body)) NOT BETWEEN 1 AND 10000
    OR p_resolve IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'invalid checked support reply' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'support ticket missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_draft FROM public.yutakasa_ticket_reply_drafts d
    WHERE d.work_id=p_work_id AND d.ticket_id=p_ticket_id
      AND d.latest_user_message_id=p_expected_latest_user_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reply draft missing or changed' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_existing FROM public.support_messages m
    WHERE m.ticket_id=p_ticket_id AND m.client_request_id=p_client_request_id;
  IF FOUND THEN
    IF v_existing.sender_type<>'admin' OR v_existing.body IS DISTINCT FROM p_body
      OR v_draft.used_message_id IS DISTINCT FROM v_existing.id THEN
      RAISE EXCEPTION 'checked support reply conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id,FALSE; RETURN;
  END IF;
  IF v_draft.used_message_id IS NOT NULL OR v_ticket.automation_status<>'manual_review'
    OR v_ticket.status<>'in_progress' OR v_ticket.category<>'technical'
    OR v_ticket.decision_required THEN
    RAISE EXCEPTION 'reply draft already used or ticket changed' USING ERRCODE='P0001';
  END IF;
  SELECT m.id INTO v_latest FROM public.support_messages m
    WHERE m.ticket_id=p_ticket_id AND m.sender_type='user'
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_expected_latest_user_message_id THEN
    RAISE EXCEPTION 'customer message changed' USING ERRCODE='P0001';
  END IF;
  SELECT r.message_id,r.created INTO v_message_id,v_created
    FROM public.append_support_admin_message(
      p_ticket_id,p_body,p_client_request_id,p_resolve) r;
  IF v_message_id IS NULL OR v_created IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'reply draft send was not created' USING ERRCODE='23505';
  END IF;
  UPDATE public.yutakasa_ticket_reply_drafts d SET used_message_id=v_message_id
    WHERE d.work_id=p_work_id;
  RETURN QUERY SELECT v_message_id,TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.append_support_admin_message_checked(UUID,TEXT,UUID,BOOLEAN,UUID,UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_support_admin_message_checked(UUID,TEXT,UUID,BOOLEAN,UUID,UUID)
  TO service_role;

-- A generic production smoke and a linked PR do not establish before/after
-- evidence for this customer's symptom. Keep the existing atomic reply RPC
-- unavailable to the automation role until a separate proof-and-approval
-- migration supplies that evidence. Its idempotency logic remains intact.
REVOKE EXECUTE ON FUNCTION public.append_yutakasa_automation_reply(
  UUID,UUID,UUID,UUID,TEXT,BOOLEAN,INTEGER,TEXT,TEXT) FROM service_role;

COMMIT;
