-- MVP Item #1: Swap leaderboard to score_entries (latest-run only) - CORRECTED
--
-- Purpose: Replace the base leaderboard view to read from score_entries
--          filtered to the latest score run, then refresh the materialized view.
--
-- CORRECTED based on actual score_entries schema:
--   - score_entries has: score_run_id, student_id, total_points, breakdown_json
--   - Need to join to roster and student_identities to get inat_login
--   - obs_count can be calculated from breakdown_json (D + O + U + RG)
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
  si.provider_uid AS inat_login,
  r.display_name,
  -- Total points from score_entries
  SUM(se.total_points)::numeric AS total_points,
  -- Observation count from breakdown_json (sum of quality grades: D, O, U, RG)
  SUM(
    COALESCE((se.breakdown_json->>'D')::int, 0) +
    COALESCE((se.breakdown_json->>'O')::int, 0) +
    COALESCE((se.breakdown_json->>'U')::int, 0) +
    COALESCE((se.breakdown_json->>'RG')::int, 0)
  )::int AS obs_count,
  -- Additional metrics from breakdown_json
  SUM(COALESCE((se.breakdown_json->>'novelty_sum')::numeric, 0))::numeric AS novelty_sum,
  SUM(COALESCE((se.breakdown_json->>'rarity_sum')::numeric, 0))::numeric AS rarity_sum,
  SUM(COALESCE((se.breakdown_json->>'assists_count')::int, 0))::int AS assists_count
FROM public.score_entries se
-- Join to roster to get student info
JOIN public.roster r ON r.id = se.student_id
-- Join to student_identities to get inat_login
JOIN public.student_identities si ON si.user_id = se.student_id AND si.provider = 'inat'
-- Filter to latest run only
WHERE se.score_run_id = (SELECT id FROM latest_run)
  AND COALESCE(si.active, true) = true
GROUP BY si.provider_uid, r.display_name
ORDER BY total_points DESC, inat_login ASC;

-- Step 2: Immediately refresh the existing materialized view to pick up the change
REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_overall_mv;

-- Verification queries (optional - run after the above completes)
-- Check the updated leaderboard:
-- SELECT * FROM public.leaderboard_overall_mv ORDER BY total_points DESC LIMIT 10;

-- Check which run we're using:
-- SELECT id, started_at FROM public.score_runs ORDER BY started_at DESC LIMIT 1;
