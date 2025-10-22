-- Diagnostic query to check student_identities table schema
-- Run this in Supabase SQL Editor to see what columns exist

-- Method 1: Check column names and types
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'student_identities'
ORDER BY ordinal_position;

-- Method 2: Look at sample data (first row)
-- Uncomment and run this after Method 1 to see actual data structure
-- SELECT * FROM public.student_identities LIMIT 3;
