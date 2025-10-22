-- MVP Item #1: Swap leaderboard to score_entries (latest-run only)
--
-- Purpose: Replace the base leaderboard view to read from score_entries
--          filtered to the latest score run, then refresh the materialized view.
--
-- CORRECTED VERSION - Use mvp_item_1_leaderboard_swap_CORRECTED.sql instead
-- This file kept for reference only
--
-- Actual score_entries schema:
--   - score_entries has: score_run_id, student_id, total_points, breakdown_json
--   - Need to join to roster and student_identities to get inat_login
--   - obs_count calculated from breakdown_json (D + O + U + RG)
--
-- See: mvp_item_1_leaderboard_swap_CORRECTED.sql for the working version

-- DEPRECATED - DO NOT USE THIS VERSION
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
  SUM(se.total_points)::numeric AS total_points,
  SUM(
    COALESCE((se.breakdown_json->>'D')::int, 0) +
    COALESCE((se.breakdown_json->>'O')::int, 0) +
    COALESCE((se.breakdown_json->>'U')::int, 0) +
    COALESCE((se.breakdown_json->>'RG')::int, 0)
  )::int AS obs_count
FROM public.score_entries se
JOIN public.roster r ON r.id = se.student_id
JOIN public.student_identities si ON si.user_id = se.student_id AND si.provider = 'inat'
WHERE se.score_run_id = (SELECT id FROM latest_run)
  AND COALESCE(si.active, true) = true
GROUP BY si.provider_uid, r.display_name
ORDER BY total_points DESC;

-- Step 2: Immediately refresh the existing materialized view to pick up the change
REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_overall_mv;

-- Verification query (optional - run after the above completes)
-- SELECT * FROM public.leaderboard_overall_mv ORDER BY total_points DESC LIMIT 10;
