-- Diagnostic queries to check ALL tables needed for leaderboard
-- Run these in Supabase SQL Editor to see complete schema

-- ============================================================================
-- 1. Check student_identities table schema
-- ============================================================================
SELECT 'student_identities columns:' AS info;

SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'student_identities'
ORDER BY ordinal_position;

-- Sample data
-- SELECT * FROM public.student_identities LIMIT 3;

-- ============================================================================
-- 2. Check roster table schema
-- ============================================================================
SELECT 'roster columns:' AS info;

SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'roster'
ORDER BY ordinal_position;

-- Sample data
-- SELECT * FROM public.roster LIMIT 3;

-- ============================================================================
-- 3. Check what tables exist that might help with joins
-- ============================================================================
SELECT 'All public tables:' AS info;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
