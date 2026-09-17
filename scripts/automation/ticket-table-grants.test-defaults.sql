-- Reproduce Supabase's default table grants for the two tables created next.
-- The migrations must explicitly remove service_role write access.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
