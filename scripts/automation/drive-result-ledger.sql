-- Reserve each result event once. A timed-out Drive POST is never retried
-- automatically: posting/uncertain rows require Drive readback to confirm.
BEGIN;

CREATE TABLE IF NOT EXISTS public.yutakasa_drive_result_publications (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9_-]{6,80}$'),
  pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  file_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posting', 'uncertain', 'confirmed')),
  file_id TEXT CHECK (file_id IS NULL OR file_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (file_name = '豊かさBOT_対応結果_' || event_id || '.pdf'),
  CHECK ((status = 'confirmed') = (file_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION public.reserve_yutakasa_drive_result(
  p_event_id TEXT,
  p_pdf_sha256 TEXT,
  p_file_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_inserted TEXT;
  v_record public.yutakasa_drive_result_publications%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_-]{6,80}$'
    OR p_pdf_sha256 IS NULL OR p_pdf_sha256 !~ '^[a-f0-9]{64}$'
    OR p_file_name IS NULL
    OR p_file_name <> '豊かさBOT_対応結果_' || p_event_id || '.pdf'
  THEN
    RAISE EXCEPTION 'invalid Drive result reservation' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.yutakasa_drive_result_publications(event_id, pdf_sha256, file_name, status)
    VALUES (p_event_id, p_pdf_sha256, p_file_name, 'posting')
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id INTO v_inserted;
  IF v_inserted IS NOT NULL THEN
    RETURN 'reserved';
  END IF;
  SELECT * INTO v_record
    FROM public.yutakasa_drive_result_publications AS p
    WHERE p.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Drive result reservation unavailable' USING ERRCODE = '40001';
  END IF;
  IF v_record.pdf_sha256 <> p_pdf_sha256 OR v_record.file_name <> p_file_name THEN
    RETURN 'conflict';
  END IF;
  IF v_record.status = 'confirmed' THEN RETURN 'confirmed'; END IF;
  RETURN 'pending';
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_yutakasa_drive_result_uncertain(
  p_event_id TEXT,
  p_pdf_sha256 TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_count INTEGER;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_-]{6,80}$'
    OR p_pdf_sha256 IS NULL OR p_pdf_sha256 !~ '^[a-f0-9]{64}$'
  THEN
    RAISE EXCEPTION 'invalid Drive result uncertainty' USING ERRCODE = '22023';
  END IF;
  UPDATE public.yutakasa_drive_result_publications AS p
    SET status = 'uncertain', updated_at = clock_timestamp()
    WHERE p.event_id = p_event_id AND p.pdf_sha256 = p_pdf_sha256
      AND p.status IN ('posting', 'uncertain');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_yutakasa_drive_result(
  p_event_id TEXT,
  p_pdf_sha256 TEXT,
  p_file_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_record public.yutakasa_drive_result_publications%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_-]{6,80}$'
    OR p_pdf_sha256 IS NULL OR p_pdf_sha256 !~ '^[a-f0-9]{64}$'
    OR p_file_id IS NULL OR p_file_id !~ '^[A-Za-z0-9_-]{1,200}$'
  THEN
    RAISE EXCEPTION 'invalid Drive result confirmation' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_record
    FROM public.yutakasa_drive_result_publications AS p
    WHERE p.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND OR v_record.pdf_sha256 <> p_pdf_sha256 THEN RETURN FALSE; END IF;
  IF v_record.status = 'confirmed' THEN
    RETURN v_record.file_id = p_file_id;
  END IF;
  UPDATE public.yutakasa_drive_result_publications AS p
    SET status = 'confirmed', file_id = p_file_id, updated_at = clock_timestamp()
    WHERE p.event_id = p_event_id AND p.pdf_sha256 = p_pdf_sha256;
  RETURN TRUE;
END;
$$;

ALTER TABLE public.yutakasa_drive_result_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.yutakasa_drive_result_publications
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.yutakasa_drive_result_publications TO service_role;
REVOKE ALL ON FUNCTION public.reserve_yutakasa_drive_result(TEXT,TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_yutakasa_drive_result_uncertain(TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_yutakasa_drive_result(TEXT,TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_yutakasa_drive_result(TEXT,TEXT,TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_yutakasa_drive_result_uncertain(TEXT,TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_yutakasa_drive_result(TEXT,TEXT,TEXT)
  TO service_role;

COMMIT;
