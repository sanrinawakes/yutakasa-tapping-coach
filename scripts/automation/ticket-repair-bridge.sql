-- Apply after repair-release-ledger.sql and support-automation-reply.sql.
-- Customer content stays in support tables; GitHub receives only a random work UUID.
BEGIN;

ALTER TABLE public.support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_automation_status_check;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_automation_status_check CHECK (
    automation_status IN ('queued','investigating','awaiting_repair','manual_review','blocked_decision','completed','failed')
  );

CREATE TABLE IF NOT EXISTS public.yutakasa_ticket_repair_jobs (
  work_id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  latest_user_message_id UUID NOT NULL REFERENCES public.support_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','investigating','pr_open','stale','failed','replied')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  claimed_at TIMESTAMPTZ,
  claimed_run_id BIGINT CHECK (claimed_run_id IS NULL OR claimed_run_id > 0),
  pr_number INTEGER UNIQUE,
  head_sha TEXT CHECK (head_sha IS NULL OR head_sha ~ '^[a-f0-9]{40}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (ticket_id, latest_user_message_id),
  CHECK ((pr_number IS NULL) = (head_sha IS NULL)),
  CHECK (status NOT IN ('pr_open','replied') OR pr_number IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS yutakasa_ticket_repair_jobs_queue_idx
  ON public.yutakasa_ticket_repair_jobs(status,created_at);
ALTER TABLE public.yutakasa_ticket_repair_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.yutakasa_ticket_repair_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.yutakasa_ticket_repair_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.begin_yutakasa_ticket_repair(
  p_ticket_id UUID, p_lock_token UUID, p_latest_user_message_id UUID,
  p_ticket_version TIMESTAMPTZ, p_work_id UUID
)
RETURNS TABLE(work_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_ticket public.support_tickets%ROWTYPE;
BEGIN
  IF p_ticket_id IS NULL OR p_lock_token IS NULL OR p_latest_user_message_id IS NULL
    OR p_ticket_version IS NULL OR p_work_id IS NULL THEN
    RAISE EXCEPTION 'invalid repair work' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t WHERE t.id=p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.automation_status <> 'investigating'
    OR v_ticket.automation_lock_token IS DISTINCT FROM p_lock_token
    OR v_ticket.updated_at IS DISTINCT FROM p_ticket_version
    OR v_ticket.decision_required OR v_ticket.category <> 'technical'
    OR v_ticket.status <> 'in_progress'
    OR EXISTS (SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=p_ticket_id)
    OR p_latest_user_message_id IS DISTINCT FROM (
      SELECT m.id FROM public.support_messages m
      WHERE m.ticket_id=p_ticket_id AND m.sender_type='user'
      ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) THEN
    RAISE EXCEPTION 'repair ticket changed or requires owner review' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.yutakasa_ticket_repair_jobs(
    work_id,ticket_id,latest_user_message_id,status
  ) VALUES(p_work_id,p_ticket_id,p_latest_user_message_id,'queued');
  UPDATE public.support_tickets t SET
    automation_status='awaiting_repair', automation_locked_at=NULL,
    automation_lock_token=NULL,updated_at=clock_timestamp()
  WHERE t.id=p_ticket_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
  VALUES(p_ticket_id,'repair_work_queued',
    '技術修正の調査を登録しました。本番修正や顧客返信はまだ行っていません。',
    jsonb_build_object('work_id',p_work_id));
  RETURN QUERY SELECT p_work_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_yutakasa_ticket_repair_context(
  p_work_id UUID,p_run_id BIGINT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_messages JSONB;
BEGIN
  IF p_work_id IS NULL OR p_run_id IS NULL OR p_run_id < 1 THEN
    RAISE EXCEPTION 'invalid repair claim' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND OR v_job.status NOT IN ('queued','investigating')
    OR (v_job.status='investigating' AND
        (v_job.claimed_at > clock_timestamp()-INTERVAL '2 hours' OR v_job.attempt_count >= 3))
    OR v_job.attempt_count >= 3 THEN
    RAISE EXCEPTION 'repair claim unavailable' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.automation_status <> 'awaiting_repair'
    OR v_ticket.decision_required OR v_ticket.status <> 'in_progress'
    OR v_ticket.category <> 'technical'
    OR EXISTS (SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=v_job.ticket_id)
    OR v_job.latest_user_message_id IS DISTINCT FROM (
      SELECT m.id FROM public.support_messages m
      WHERE m.ticket_id=v_job.ticket_id AND m.sender_type='user'
      ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) THEN
    UPDATE public.yutakasa_ticket_repair_jobs j SET status='stale',updated_at=clock_timestamp()
      WHERE j.work_id=p_work_id;
    IF v_ticket.automation_status='awaiting_repair' THEN
      UPDATE public.support_tickets t SET
        automation_status=CASE WHEN v_ticket.decision_required
          THEN 'blocked_decision' ELSE 'manual_review' END,
        updated_at=clock_timestamp() WHERE t.id=v_job.ticket_id;
    END IF;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(v_job.ticket_id,'repair_context_stale',
        '問い合わせの条件が変わったため自動調査を停止しました。顧客返信は行っていません。',
        jsonb_build_object('work_id',p_work_id));
    RETURN NULL;
  END IF;
  SELECT jsonb_agg(jsonb_build_object('id',m.id,'sender_type',m.sender_type,
    'body',m.body,'created_at',m.created_at) ORDER BY m.created_at,m.id)
    INTO v_messages FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id;
  IF v_messages IS NULL OR jsonb_array_length(v_messages)>500 THEN
    UPDATE public.yutakasa_ticket_repair_jobs j SET status='failed',
      updated_at=clock_timestamp() WHERE j.work_id=p_work_id;
    UPDATE public.support_tickets t SET automation_status='manual_review',
      updated_at=clock_timestamp() WHERE t.id=v_job.ticket_id;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(v_job.ticket_id,'repair_manual_review',
        '問い合わせ履歴の取得上限を超えたため、担当者による調査が必要です。顧客返信は行っていません。',
        jsonb_build_object('work_id',p_work_id,'reason_code','repair_context_invalid'));
    RETURN NULL;
  END IF;
  UPDATE public.yutakasa_ticket_repair_jobs j SET
    status='investigating',attempt_count=j.attempt_count+1,
    claimed_at=clock_timestamp(),claimed_run_id=p_run_id,updated_at=clock_timestamp()
    WHERE j.work_id=p_work_id;
  RETURN jsonb_build_object('work_id',p_work_id,'ticket_id',v_job.ticket_id,
    'latest_user_message_id',v_job.latest_user_message_id,
    'category',v_ticket.category,'subject',v_ticket.subject,'messages',v_messages);
END;
$$;

-- Promotion uses this immediately before merge. The response contains only
-- an opaque work UUID, and is never placed in GitHub logs or PR content.
CREATE OR REPLACE FUNCTION public.verify_yutakasa_ticket_repair_pr(
  p_pr_number INTEGER,p_head_sha TEXT
)
RETURNS TABLE(work_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
BEGIN
  IF p_pr_number IS NULL OR p_pr_number<1 OR p_head_sha IS NULL OR
    p_head_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'invalid repair PR verification' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.pr_number=p_pr_number AND j.head_sha=p_head_sha AND j.status='pr_open'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'repair PR unlinked' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.automation_status<>'awaiting_repair' OR
    v_ticket.status<>'in_progress' OR v_ticket.decision_required OR
    v_ticket.category<>'technical' OR
    EXISTS(SELECT 1 FROM public.support_attachments a WHERE a.ticket_id=v_job.ticket_id) OR
    v_job.latest_user_message_id IS DISTINCT FROM (
      SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) OR NOT EXISTS(SELECT 1 FROM public.yutakasa_repair_ticket_links l
      WHERE l.pr_number=p_pr_number AND l.ticket_id=v_job.ticket_id
      AND l.latest_user_message_id=v_job.latest_user_message_id) THEN
    RAISE EXCEPTION 'repair PR ticket stale' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT v_job.work_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.link_yutakasa_ticket_repair_pr(
  p_work_id UUID,p_run_id BIGINT,p_pr_number INTEGER,p_head_sha TEXT
)
RETURNS TABLE(pr_number INTEGER,head_sha TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
BEGIN
  IF p_work_id IS NULL OR p_run_id IS NULL OR p_run_id<1 OR p_pr_number IS NULL
    OR p_pr_number<1 OR p_head_sha IS NULL OR p_head_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'invalid repair PR link' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'repair work missing' USING ERRCODE='P0002'; END IF;
  IF v_job.status='pr_open' AND v_job.pr_number=p_pr_number AND v_job.head_sha=p_head_sha THEN
    RETURN QUERY SELECT v_job.pr_number,v_job.head_sha; RETURN;
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  IF v_job.status<>'investigating' OR v_job.claimed_run_id<>p_run_id
    OR v_ticket.automation_status<>'awaiting_repair' OR v_ticket.decision_required
    OR v_ticket.status<>'in_progress'
    OR v_job.latest_user_message_id IS DISTINCT FROM (
      SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) THEN
    RAISE EXCEPTION 'repair PR link stale' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.yutakasa_repair_releases(pr_number,head_sha,status)
    VALUES(p_pr_number,p_head_sha,'pending_merge')
    ON CONFLICT ON CONSTRAINT yutakasa_repair_releases_pkey DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.yutakasa_repair_releases r
    WHERE r.pr_number=p_pr_number AND r.head_sha=p_head_sha
      AND r.status='pending_merge') THEN
    RAISE EXCEPTION 'repair release conflict' USING ERRCODE='23505';
  END IF;
  INSERT INTO public.yutakasa_repair_ticket_links(
    pr_number,ticket_id,latest_user_message_id
  ) VALUES(p_pr_number,v_job.ticket_id,v_job.latest_user_message_id)
    ON CONFLICT DO NOTHING;
  UPDATE public.yutakasa_ticket_repair_jobs j SET
    status='pr_open',pr_number=p_pr_number,head_sha=p_head_sha,
    updated_at=clock_timestamp() WHERE j.work_id=p_work_id;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(v_job.ticket_id,'repair_pr_linked',
      '技術修正の候補PRを登録しました。本番修正や顧客返信はまだ行っていません。',
      jsonb_build_object('work_id',p_work_id,'pr_number',p_pr_number));
  RETURN QUERY SELECT p_pr_number,p_head_sha;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_due_yutakasa_ticket_repair_jobs()
RETURNS TABLE(work_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT j.work_id FROM public.yutakasa_ticket_repair_jobs j
  WHERE j.status='queued' OR (j.status='investigating'
    AND j.claimed_at<clock_timestamp()-INTERVAL '2 hours' AND j.attempt_count<3)
  ORDER BY j.created_at LIMIT 10;
$$;

CREATE OR REPLACE FUNCTION public.list_due_yutakasa_ticket_repair_reviews()
RETURNS TABLE(work_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT j.work_id FROM public.yutakasa_ticket_repair_jobs j
  LEFT JOIN public.yutakasa_repair_releases r ON r.pr_number=j.pr_number
  WHERE j.status='pr_open' AND (r.status='verified' OR
    j.updated_at<clock_timestamp()-INTERVAL '24 hours')
  ORDER BY j.updated_at LIMIT 100;
$$;

CREATE OR REPLACE FUNCTION public.fail_yutakasa_ticket_repair_work(
  p_work_id UUID,p_run_id BIGINT,p_reason_code TEXT
)
RETURNS TABLE(status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
BEGIN
  IF p_work_id IS NULL OR p_run_id IS NULL OR p_run_id<1 OR
    p_reason_code IS NULL OR p_reason_code !~ '^[a-z][a-z0-9_]{0,100}$' THEN
    RAISE EXCEPTION 'invalid repair failure' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'investigating' OR
    v_job.claimed_run_id<>p_run_id THEN
    RAISE EXCEPTION 'repair work ownership lost' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  UPDATE public.yutakasa_ticket_repair_jobs j SET
    status='failed',updated_at=clock_timestamp() WHERE j.work_id=p_work_id;
  IF v_ticket.automation_status='awaiting_repair' AND
    v_job.latest_user_message_id IS NOT DISTINCT FROM (
      SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) THEN
    UPDATE public.support_tickets t SET automation_status='manual_review',
      updated_at=clock_timestamp() WHERE t.id=v_job.ticket_id;
  END IF;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(v_job.ticket_id,'repair_manual_review',
      '自動修正の根拠が不足しています。担当者による調査が必要です。顧客返信は行っていません。',
      jsonb_build_object('work_id',p_work_id,'reason_code',p_reason_code));
  RETURN QUERY SELECT 'failed'::TEXT;
END;
$$;

-- Generic chat smoke never proves the customer's reported defect is fixed.
-- The only automatic release transition is to a human review queue.
CREATE OR REPLACE FUNCTION public.review_yutakasa_ticket_repair_release(
  p_work_id UUID
)
RETURNS TABLE(status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_release public.yutakasa_repair_releases%ROWTYPE;
DECLARE v_reason TEXT;
BEGIN
  IF p_work_id IS NULL THEN
    RAISE EXCEPTION 'invalid repair work' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.work_id=p_work_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'repair work missing' USING ERRCODE='P0002'; END IF;
  IF v_job.status IN ('failed','stale','replied') THEN
    RETURN QUERY SELECT v_job.status; RETURN;
  END IF;
  IF v_job.status<>'pr_open' THEN
    RETURN QUERY SELECT 'pending'::TEXT; RETURN;
  END IF;
  SELECT * INTO v_release FROM public.yutakasa_repair_releases r
    WHERE r.pr_number=v_job.pr_number;
  IF v_release.status='verified' THEN
    v_reason:='ticket_specific_proof_missing';
  ELSIF v_job.updated_at<clock_timestamp()-INTERVAL '24 hours' THEN
    v_reason:='repair_release_timeout';
  ELSE
    RETURN QUERY SELECT 'pending'::TEXT; RETURN;
  END IF;
  SELECT * INTO v_ticket FROM public.support_tickets t
    WHERE t.id=v_job.ticket_id FOR UPDATE;
  UPDATE public.yutakasa_ticket_repair_jobs j SET
    status='failed',updated_at=clock_timestamp() WHERE j.work_id=p_work_id;
  IF v_ticket.automation_status='awaiting_repair' AND
    v_job.latest_user_message_id IS NOT DISTINCT FROM (
      SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
      AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) THEN
    UPDATE public.support_tickets t SET automation_status='manual_review',
      updated_at=clock_timestamp() WHERE t.id=v_job.ticket_id;
  END IF;
  INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
    VALUES(v_job.ticket_id,'repair_manual_review',
      '本番反映後も問い合わせ固有の症状の解消を確認できていません。担当者の確認が必要です。顧客返信は行っていません。',
      jsonb_build_object('work_id',p_work_id,'reason_code',v_reason,
        'pr_number',v_job.pr_number));
  RETURN QUERY SELECT 'manual_review'::TEXT;
END;
$$;

-- Recover claims whose final allowed attempt timed out. The owned run may
-- still be executing until the two-hour timeout, so never preempt it early.
CREATE OR REPLACE FUNCTION public.recover_yutakasa_ticket_repair_jobs()
RETURNS TABLE(recovered INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_job public.yutakasa_ticket_repair_jobs%ROWTYPE;
DECLARE v_ticket public.support_tickets%ROWTYPE;
DECLARE v_count INTEGER:=0;
BEGIN
  FOR v_job IN SELECT * FROM public.yutakasa_ticket_repair_jobs j
    WHERE j.status='investigating' AND j.attempt_count>=3 AND
      j.claimed_at<clock_timestamp()-INTERVAL '2 hours'
    ORDER BY j.created_at LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO v_ticket FROM public.support_tickets t
      WHERE t.id=v_job.ticket_id FOR UPDATE;
    UPDATE public.yutakasa_ticket_repair_jobs j SET status='failed',
      updated_at=clock_timestamp() WHERE j.work_id=v_job.work_id;
    IF v_ticket.automation_status='awaiting_repair' AND
      v_job.latest_user_message_id IS NOT DISTINCT FROM (
        SELECT m.id FROM public.support_messages m WHERE m.ticket_id=v_job.ticket_id
        AND m.sender_type='user' ORDER BY m.created_at DESC,m.id DESC LIMIT 1
      ) THEN
      UPDATE public.support_tickets t SET automation_status='manual_review',
        updated_at=clock_timestamp() WHERE t.id=v_job.ticket_id;
    END IF;
    INSERT INTO public.support_work_logs(ticket_id,event_type,summary,metadata)
      VALUES(v_job.ticket_id,'repair_manual_review',
        '自動調査の再試行上限に達しました。担当者の確認が必要です。顧客返信は行っていません。',
        jsonb_build_object('work_id',v_job.work_id,'reason_code','repair_claim_exhausted'));
    v_count:=v_count+1;
  END LOOP;
  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_yutakasa_ticket_repair(UUID,UUID,UUID,TIMESTAMPTZ,UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_yutakasa_ticket_repair_context(UUID,BIGINT)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.link_yutakasa_ticket_repair_pr(UUID,BIGINT,INTEGER,TEXT)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_due_yutakasa_ticket_repair_jobs()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_due_yutakasa_ticket_repair_reviews()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fail_yutakasa_ticket_repair_work(UUID,BIGINT,TEXT)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.review_yutakasa_ticket_repair_release(UUID)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.recover_yutakasa_ticket_repair_jobs()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.verify_yutakasa_ticket_repair_pr(INTEGER,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_yutakasa_ticket_repair(UUID,UUID,UUID,TIMESTAMPTZ,UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_yutakasa_ticket_repair_context(UUID,BIGINT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.link_yutakasa_ticket_repair_pr(UUID,BIGINT,INTEGER,TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_due_yutakasa_ticket_repair_jobs()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_due_yutakasa_ticket_repair_reviews()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_yutakasa_ticket_repair_work(UUID,BIGINT,TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.review_yutakasa_ticket_repair_release(UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_yutakasa_ticket_repair_jobs()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_yutakasa_ticket_repair_pr(INTEGER,TEXT)
  TO service_role;
COMMIT;
