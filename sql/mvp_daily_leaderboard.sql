-- MVP NEXT: Daily Leaderboard (view + MV + RPC + permissions)
--
-- Purpose: Create daily leaderboard aggregation per user per calendar date
--          from score_entries_obs, reading only from the latest run.
--
-- Instructions:
--   1. Copy this entire SQL block
--   2. Go to Supabase Dashboard → SQL Editor
--   3. Paste and execute

-- ============================================================================
-- C1) Daily leaderboard view (latest run only)
-- ============================================================================

-- View: per user per calendar date from score_entries_obs (latest run)
CREATE OR REPLACE VIEW public.leaderboard_daily_latest_v1 AS
WITH latest_run AS (
  SELECT id
  FROM public.score_runs
  ORDER BY started_at DESC NULLS LAST, id DESC
  LIMIT 1
),
scored AS (
  SELECT
    se.user_login,
    (se.observed_at AT TIME ZONE 'UTC')::date AS day_utc,
    se.taxon_id
  FROM public.score_entries_obs se
  WHERE se.run_id = (SELECT id FROM latest_run)
)
SELECT
  user_login,
  day_utc,
  COUNT(*)::bigint                 AS obs_count,
  COUNT(DISTINCT taxon_id)::bigint AS distinct_taxa
FROM scored
GROUP BY user_login, day_utc;

-- Materialized view for fast UI reads
CREATE MATERIALIZED VIEW IF NOT EXISTS public.leaderboard_daily_mv AS
SELECT * FROM public.leaderboard_daily_latest_v1;

CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_daily_mv_uidx
  ON public.leaderboard_daily_mv (user_login, day_utc);

-- Helpful index for scorer/query perf
CREATE INDEX IF NOT EXISTS score_entries_obs_run_observed_idx
  ON public.score_entries_obs (run_id, observed_at DESC);

-- ============================================================================
-- C2) RPC to refresh the daily MV
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_leaderboard_daily_mv()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_daily_mv;
END$$;

ALTER FUNCTION public.refresh_leaderboard_daily_mv SET search_path = public;

-- ============================================================================
-- C3) Permissions (anon read on views/MVs)
-- ============================================================================

GRANT SELECT ON public.leaderboard_overall_mv TO anon;
GRANT SELECT ON public.leaderboard_daily_mv  TO anon;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- 1) Check daily view has data
-- SELECT * FROM public.leaderboard_daily_latest_v1
-- ORDER BY day_utc DESC, obs_count DESC
-- LIMIT 20;

-- 2) Refresh daily MV
-- SELECT public.refresh_leaderboard_daily_mv();

-- 3) Check daily MV
-- SELECT * FROM public.leaderboard_daily_mv
-- ORDER BY day_utc DESC, obs_count DESC
-- LIMIT 20;

-- 4) Check permissions (should work with anon key)
-- curl -H "apikey: $SUPABASE_ANON_KEY" \
--   "$SUPABASE_URL/rest/v1/leaderboard_daily_mv?select=*&limit=10"
