-- MVP Item #1: Swap leaderboard to score_entries (latest-run only)
--
-- Purpose: Replace the base leaderboard view to read from score_entries
--          filtered to the latest score run, then refresh the materialized view.
--
-- This assumes:
--   - public.score_entries table exists with columns: run_id, user_login, taxon_id, points (optional)
--   - public.score_runs table exists with columns: id, started_at
--   - public.leaderboard_overall_mv materialized view exists
--   - public.refresh_leaderboard_overall_mv() function exists
--
-- Instructions:
--   1. Copy this SQL
--   2. Go to Supabase Dashboard → SQL Editor
--   3. Paste and execute
--   4. Verify the MV refresh completes successfully

-- Step 1: Replace the base view to read from score_entries (latest run only)
CREATE OR REPLACE VIEW public.leaderboard_overall_latest_v1 AS
WITH latest_run AS (
  SELECT id
  FROM public.score_runs
  ORDER BY started_at DESC NULLS LAST, id DESC
  LIMIT 1
)
SELECT
  se.user_login,
  COUNT(*)                    AS obs_count,
  COUNT(DISTINCT se.taxon_id) AS distinct_taxa
  -- Uncomment below if points column exists in score_entries
  -- , SUM(se.points)         AS total_points
FROM public.score_entries se
WHERE se.run_id = (SELECT id FROM latest_run)
GROUP BY se.user_login;

-- Step 2: Immediately refresh the existing materialized view to pick up the change
REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_overall_mv;

-- Verification query (optional - run after the above completes)
-- SELECT * FROM public.leaderboard_overall_mv ORDER BY obs_count DESC LIMIT 10;
