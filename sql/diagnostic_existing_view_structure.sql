-- Diagnostic: Check existing leaderboard_overall_latest_v1 view structure
-- Run this to see what columns exist and in what order

-- Method 1: Check column names and order
SELECT
  column_name,
  data_type,
  ordinal_position
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'leaderboard_overall_latest_v1'
ORDER BY ordinal_position;

-- Method 2: See sample data to understand structure
-- SELECT * FROM public.leaderboard_overall_latest_v1 LIMIT 3;

-- Method 3: Get the view definition
-- SELECT pg_get_viewdef('public.leaderboard_overall_latest_v1'::regclass, true);
