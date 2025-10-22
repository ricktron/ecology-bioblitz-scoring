-- MVP Item #1: Swap leaderboard to score_entries (latest-run only) - FINAL v3
--
-- Purpose: Replace the base leaderboard view to filter to users in the latest score run
--
-- v3: Matches EXACT existing column structure:
--   1. user_login (text)
--   2. obs_count (bigint)
--   3. distinct_taxa (bigint)
--   4. first_observed_at (timestamp with time zone)
--   5. last_observed_at (timestamp with time zone)
--
-- Strategy: Still read from observations table, but filter to only users
--           who appear in the latest score_entries run. This preserves all
--           the existing metrics (distinct_taxa, timestamps) while limiting
--           to the latest run's participants.
--
-- Instructions:
--   1. Copy this SQL
--   2. Go to Supabase Dashboard → SQL Editor
--   3. Paste and execute
--   4. Verify the MV refresh completes successfully

-- Step 1: Replace the base view - filter observations to latest run users
CREATE OR REPLACE VIEW public.leaderboard_overall_latest_v1 AS
WITH latest_run AS (
  -- Get the latest score run
  SELECT id
  FROM public.score_runs
  ORDER BY started_at DESC NULLS LAST, id DESC
  LIMIT 1
),
latest_run_users AS (
  -- Get all users (inat_logins) who appear in the latest score run
  SELECT DISTINCT r.inat_login
  FROM public.score_entries se
  JOIN public.roster r ON r.id = se.student_id
  WHERE se.score_run_id = (SELECT id FROM latest_run)
    AND COALESCE(r.exclude_from_scoring, false) = false
)
SELECT
  o.user_login,
  COUNT(*)::bigint AS obs_count,
  COUNT(DISTINCT o.taxon_id)::bigint AS distinct_taxa,
  MIN(o.observed_at) AS first_observed_at,
  MAX(o.observed_at) AS last_observed_at
FROM public.observations o
WHERE o.user_login IS NOT NULL
  -- Filter to only users in the latest score run
  AND o.user_login IN (SELECT inat_login FROM latest_run_users)
GROUP BY o.user_login;

-- Step 2: Immediately refresh the existing materialized view to pick up the change
REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_overall_mv;

-- Verification queries (optional - run after the above completes)
--
-- Check the updated leaderboard:
-- SELECT * FROM public.leaderboard_overall_mv ORDER BY obs_count DESC LIMIT 10;
--
-- Check which run we're using:
-- SELECT id, started_at FROM public.score_runs ORDER BY started_at DESC LIMIT 1;
--
-- Check how many users are in latest run:
-- WITH latest_run AS (
--   SELECT id FROM public.score_runs ORDER BY started_at DESC LIMIT 1
-- )
-- SELECT COUNT(DISTINCT se.student_id) as student_count
-- FROM public.score_entries se
-- WHERE se.score_run_id = (SELECT id FROM latest_run);
