-- Migration: 365日ライセンス＋月額サブスク制御
-- Date: 2026-04-27
-- Adds: first_payment_date, subscription_status, subscription_started_at, subscription_last_event_at

-- 1. 新カラム追加（既存データを壊さないよう全てNULL許容）
ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS first_payment_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none'
    CHECK (subscription_status IN ('active','cancelled','none')),
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_last_event_at TIMESTAMPTZ;

-- 2. 認可判定を高速化するインデックス
CREATE INDEX IF NOT EXISTS idx_subscribers_first_payment_date ON subscribers(first_payment_date);
CREATE INDEX IF NOT EXISTS idx_subscribers_subscription_status ON subscribers(subscription_status);

-- 3. 既存4585名の暫定値（バックフィル前の安全策）：
--    first_payment_date が NULL の人については、後段でmyaspから取得して埋める。
--    認可ロジック側で「first_payment_date が NULL の場合は拒否しない（バックフィル待ち）」と
--    してもよいが、安全側として『created_atをコピーして仮起算日にする』選択肢もある。
--    今回は仕様優先で、認可ロジック側で「NULL = unknown扱い」として処理するため、
--    ここでのバックフィルはしない。下のスクリプトで真の決済日を取得後にUPDATEする。

-- 確認用クエリ:
-- SELECT 
--   COUNT(*) AS total,
--   COUNT(first_payment_date) AS has_payment_date,
--   COUNT(*) FILTER (WHERE subscription_status='active') AS subscription_active,
--   COUNT(*) FILTER (WHERE status='active') AS license_active
-- FROM subscribers;
