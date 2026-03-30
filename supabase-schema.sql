-- Subscribers (synced from MyASP)
CREATE TABLE IF NOT EXISTS subscribers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  myasp_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- OTP codes for email authentication
CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat threads
CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL REFERENCES subscribers(email),
  title TEXT DEFAULT '新しいチャット',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_otp_codes_email ON otp_codes(email);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_email);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);

-- RLS
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Service role policies (server-side only)
DROP POLICY IF EXISTS "Service role full access on subscribers" ON subscribers;
CREATE POLICY "Service role full access on subscribers" ON subscribers FOR ALL USING (true);

DROP POLICY IF EXISTS "Service role full access on otp_codes" ON otp_codes;
CREATE POLICY "Service role full access on otp_codes" ON otp_codes FOR ALL USING (true);

DROP POLICY IF EXISTS "Service role full access on chat_threads" ON chat_threads;
CREATE POLICY "Service role full access on chat_threads" ON chat_threads FOR ALL USING (true);

DROP POLICY IF EXISTS "Service role full access on chat_messages" ON chat_messages;
CREATE POLICY "Service role full access on chat_messages" ON chat_messages FOR ALL USING (true);
