-- Diagnostic: Check existing score_entries table structure
-- This will show us what columns and constraints already exist

-- Method 1: Check column structure
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'score_entries'
ORDER BY ordinal_position;

-- Method 2: Check constraints and primary key
SELECT
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  pg_get_constraintdef(con.oid) AS constraint_definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname = 'score_entries';

-- Method 3: See sample data
SELECT * FROM public.score_entries LIMIT 3;
