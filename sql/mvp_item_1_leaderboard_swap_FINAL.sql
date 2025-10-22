-- MVP Item #1: Swap leaderboard to score_entries (latest-run only) - FINAL VERSION
--
-- OUTDATED - Column name issue: tried to rename user_login to inat_login
-- Use mvp_item_1_leaderboard_swap_FINAL_v2.sql instead
--
-- Issue: Existing view has column "user_login" and PostgreSQL won't let us
-- rename it via CREATE OR REPLACE VIEW. v2 keeps the same column name.

-- Step 1: Replace the base view to read from score_entries (latest run only)
CREATE OR REPLACE VIEW public.leaderboard_overall_latest_v1 AS
WITH latest_run AS (
  SELECT id
  FROM public.score_runs
  ORDER BY started_at DESC NULLS LAST, id DESC
  LIMIT 1
)
SELECT
  r.inat_login,
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
  SUM(COALESCE((se.breakdown_json->>'assists_count')::int, 0))::int AS assists_count,
  -- Adult status (useful for filtering)
  BOOL_OR(r.is_adult) AS is_adult
FROM public.score_entries se
-- Direct join to roster (inat_login is in roster table)
JOIN public.roster r ON r.id = se.student_id
-- Filter to latest run only and exclude students marked for exclusion
WHERE se.score_run_id = (SELECT id FROM latest_run)
  AND COALESCE(r.exclude_from_scoring, false) = false
GROUP BY r.inat_login, r.display_name
ORDER BY total_points DESC, inat_login ASC;

-- Step 2: Immediately refresh the existing materialized view to pick up the change
REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_overall_mv;

-- Verification queries (optional - run after the above completes)
--
-- Check the updated leaderboard:
-- SELECT * FROM public.leaderboard_overall_mv ORDER BY total_points DESC LIMIT 10;
--
-- Check which run we're using:
-- SELECT id, started_at FROM public.score_runs ORDER BY started_at DESC LIMIT 1;
--
-- Check student vs adult breakdown:
-- SELECT
--   is_adult,
--   COUNT(*) as count,
--   SUM(total_points) as total_points
-- FROM public.leaderboard_overall_mv
-- GROUP BY is_adult;
