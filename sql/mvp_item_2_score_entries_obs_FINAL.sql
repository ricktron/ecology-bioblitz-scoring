-- MVP Item #2 (REVISED): Per-Observation Scoring Table + RPC
--
-- Purpose: Create new per-observation table (score_entries_obs) while leaving
--          legacy aggregated table (score_entries) completely untouched.
--
-- Strategy:
--   - Create score_entries_obs for per-observation detail
--   - Update compute_scores_mvp() to write to score_entries_obs
--   - Update leaderboard_overall_latest_v1 to read from score_entries_obs
--   - Legacy score_entries remains unchanged
--
-- Instructions:
--   1. Copy this entire SQL block
--   2. Go to Supabase Dashboard → SQL Editor
--   3. Paste and execute
--   4. Run verification queries at the bottom

-- ============================================================================
-- A1) Per-observation scoring table (NEW) — safe & idempotent
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.score_entries_obs (
  run_id       uuid        NOT NULL,
  user_login   text        NOT NULL,
  inat_obs_id  bigint      NOT NULL,
  taxon_id     bigint,
  points       numeric     NOT NULL,
  observed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, inat_obs_id)
);

CREATE INDEX IF NOT EXISTS score_entries_obs_run_user_idx
  ON public.score_entries_obs (run_id, user_login);

CREATE INDEX IF NOT EXISTS score_entries_obs_user_idx
  ON public.score_entries_obs (user_login);

COMMENT ON TABLE public.score_entries_obs IS
  'Per-observation scoring detail. One row per observation per run. ' ||
  'Separate from legacy score_entries (aggregated per student).';

-- ============================================================================
-- A2) Scoring RPC → writes into score_entries_obs (NOT the legacy table)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.compute_scores_mvp(p_run_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_run uuid;
  v_inserted integer := 0;
  cfg RECORD;
BEGIN
  -- Active filter row (single-row table with id = true)
  SELECT id, mode, d1, d2, swlat, swlng, nelat, nelng
    INTO cfg
  FROM public.config_filters
  WHERE id IS TRUE
  LIMIT 1;

  -- Choose run id: param wins; else latest from score_runs
  SELECT COALESCE(p_run_id,
          (SELECT id FROM public.score_runs
           ORDER BY started_at DESC NULLS LAST, id DESC
           LIMIT 1))
    INTO v_run;

  IF v_run IS NULL THEN
    RAISE NOTICE 'No score_runs row available. Supply p_run_id or ensure ingest writes ledger.';
    RETURN 0;
  END IF;

  -- Idempotent: wipe & rebuild this run's rows in score_entries_obs
  DELETE FROM public.score_entries_obs WHERE run_id = v_run;

  WITH obs AS (
    SELECT
      o.*,
      ROW_NUMBER() OVER (
        PARTITION BY o.user_login, o.taxon_id
        ORDER BY o.observed_at NULLS LAST, o.created_at NULLS LAST
      ) AS rn_first_taxon
    FROM public.observations o
    WHERE o.user_login IS NOT NULL
      AND (cfg.d1   IS NULL OR o.observed_at::date >= cfg.d1)
      AND (cfg.d2   IS NULL OR o.observed_at::date <= cfg.d2)
      AND (cfg.swlat IS NULL OR o.latitude  >= cfg.swlat)
      AND (cfg.nelat IS NULL OR o.latitude  <= cfg.nelat)
      AND (cfg.swlng IS NULL OR o.longitude >= cfg.swlng)
      AND (cfg.nelng IS NULL OR o.longitude <= cfg.nelng)
  ),
  scored AS (
    SELECT
      v_run                     AS run_id,
      o.user_login,
      o.inat_obs_id,
      o.taxon_id,
      (
        1
        + CASE WHEN o.quality_grade = 'research' THEN 1 ELSE 0 END
        + CASE WHEN o.rn_first_taxon = 1 THEN 1 ELSE 0 END
      )::numeric                AS points,
      o.observed_at
    FROM obs o
  )
  INSERT INTO public.score_entries_obs
    (run_id, user_login, inat_obs_id, taxon_id, points, observed_at)
  SELECT * FROM scored
  ON CONFLICT (run_id, inat_obs_id) DO UPDATE SET
    points      = EXCLUDED.points,
    observed_at = EXCLUDED.observed_at,
    user_login  = EXCLUDED.user_login,
    taxon_id    = EXCLUDED.taxon_id;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END$$;

ALTER FUNCTION public.compute_scores_mvp SET search_path = public;

COMMENT ON FUNCTION public.compute_scores_mvp IS
  'Populates score_entries_obs (per-observation) for the latest run. ' ||
  'Filters by active config_filters. Idempotent (deletes & rebuilds per run).';

-- ============================================================================
-- A3) Retarget leaderboard view to the per-observation table (latest run)
-- ============================================================================

CREATE OR REPLACE VIEW public.leaderboard_overall_latest_v1 AS
WITH latest_run AS (
  SELECT id
  FROM public.score_runs
  ORDER BY started_at DESC NULLS LAST, id DESC
  LIMIT 1
)
SELECT
  se.user_login,
  COUNT(*)::bigint                    AS obs_count,
  COUNT(DISTINCT se.taxon_id)::bigint AS distinct_taxa,
  MIN(se.observed_at)                 AS first_observed_at,
  MAX(se.observed_at)                 AS last_observed_at
FROM public.score_entries_obs se
WHERE se.run_id = (SELECT id FROM latest_run)
GROUP BY se.user_login;

COMMENT ON VIEW public.leaderboard_overall_latest_v1 IS
  'Leaderboard for latest run, reading from score_entries_obs (per-observation). ' ||
  'Aggregates to user level with obs_count, distinct_taxa, and timestamp ranges.';

-- Refresh the existing MV to pick up the new source
REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_overall_mv;

-- ============================================================================
-- NOTES
-- ============================================================================
-- * Legacy public.score_entries (aggregated rows per student/run) is UNTOUCHED
-- * All new scoring and leaderboard logic reads from public.score_entries_obs
-- * Workflow step "Compute scores (MVP)" calls compute_scores_mvp() RPC
-- * Workflow step "Refresh leaderboard MV" refreshes the materialized view

-- ============================================================================
-- VERIFICATION QUERIES (run these after executing the above)
-- ============================================================================

-- 1) Check table exists and is empty (before first run)
-- SELECT COUNT(*) as row_count FROM public.score_entries_obs;

-- 2) Compute scores for latest run
-- SELECT public.compute_scores_mvp() AS inserted_rows;

-- 3) Inspect sample rows
-- SELECT * FROM public.score_entries_obs
-- ORDER BY points DESC, observed_at DESC
-- LIMIT 20;

-- 4) Check leaderboard
-- SELECT * FROM public.leaderboard_overall_latest_v1
-- ORDER BY obs_count DESC
-- LIMIT 10;

-- 5) Refresh MV and check
-- REFRESH MATERIALIZED VIEW CONCURRENTLY public.leaderboard_overall_mv;
-- SELECT * FROM public.leaderboard_overall_mv
-- ORDER BY obs_count DESC
-- LIMIT 10;

-- 6) Verify legacy table is untouched
-- SELECT COUNT(*) as legacy_count FROM public.score_entries;
