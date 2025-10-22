-- MVP Item #2: Scoring Writer RPC + score_entries table
--
-- OUTDATED - Schema conflict with existing aggregated table
-- Use mvp_item_2_score_entries_obs_FINAL.sql instead
--
-- Issue: This version tried to use score_entries table which already exists
-- with a different schema (aggregated per student, not per observation).
--
-- Solution: New table score_entries_obs for per-observation detail.
-- See: mvp_item_2_score_entries_obs_FINAL.sql

-- ============================================================================
-- A1) Ensure score_entries table exists (idempotent, composite PK)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.score_entries (
  run_id        uuid            NOT NULL,
  user_login    text            NOT NULL,
  inat_obs_id   bigint          NOT NULL,
  taxon_id      bigint,
  points        numeric         NOT NULL,
  observed_at   timestamptz,
  created_at    timestamptz     NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, inat_obs_id)
);

CREATE INDEX IF NOT EXISTS score_entries_user_idx
  ON public.score_entries (user_login);

CREATE INDEX IF NOT EXISTS score_entries_run_user_idx
  ON public.score_entries (run_id, user_login);

-- ============================================================================
-- A2) Scoring RPC: latest-run by default, filtered by config_filters
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

  -- Recompute scores for this run: wipe & rebuild for idempotency
  DELETE FROM public.score_entries WHERE run_id = v_run;

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
  INSERT INTO public.score_entries (run_id, user_login, inat_obs_id, taxon_id, points, observed_at)
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

-- ============================================================================
-- OPTIONAL: Fix NOT NULL constraint if needed
-- ============================================================================
-- If your previous runs showed a NOT NULL violation on score_runs.assignment_id,
-- run this once before using the RPC:
--
-- ALTER TABLE public.score_runs
--   ALTER COLUMN assignment_id DROP NOT NULL;

-- ============================================================================
-- VERIFICATION QUERIES (run these after creating the function)
-- ============================================================================

-- Check latest run
-- SELECT id, started_at, ended_at
-- FROM public.score_runs
-- ORDER BY started_at DESC NULLS LAST
-- LIMIT 1;

-- Compute scores (will use latest run by default)
-- SELECT public.compute_scores_mvp() AS inserted_rows;

-- Inspect a sample
-- SELECT * FROM public.score_entries
-- ORDER BY points DESC, observed_at DESC
-- LIMIT 20;

-- Check scores by user
-- SELECT
--   user_login,
--   COUNT(*) as obs_count,
--   SUM(points) as total_points,
--   COUNT(DISTINCT taxon_id) as distinct_taxa
-- FROM public.score_entries
-- WHERE run_id = (SELECT id FROM public.score_runs ORDER BY started_at DESC LIMIT 1)
-- GROUP BY user_login
-- ORDER BY total_points DESC
-- LIMIT 10;
