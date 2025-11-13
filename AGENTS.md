# AGENTS.md - EcoQuest Live Bioblitz Scoring

## 0. How Codex should use this file

- Read this file before `/plan` or any multi file edit.
- Treat it as the contract for how this repo is supposed to behave.
- Prefer additive, idempotent changes that keep RLS and ingest paths safe.
- Stop and ask in the issue or chat if a task appears to require destructive schema changes.

This repo is usually referred to as the EcoQuest Live or Ecology BioBlitz scoring backend.

---

## 1. Repo identity

**Purpose**  
This repository ingests iNaturalist observations into Supabase, scores them, and exposes secure leaderboards for time boxed class trips and assignments.

**It is not**

- The student facing UI (that is the separate `ecoquest-live` frontend repo).
- A general purpose iNat client.
- A data science sandbox. It is a production scoring pipeline for real students.

---

## 2. Architecture at a glance

End to end flow:

1. **Ingest**  
   - GitHub Actions workflow `ingest-and-score.yml` runs `ingest.mjs` in TRIP, PROJECT, or USER mode.  
   - Ingest fetches observations from the iNaturalist API with rate limit aware pagination and upserts into Supabase using the service role key.

2. **Scoring**  
   - Supabase RPC `public.compute_scores_mvp` (and related scoring SQL) reads from `public.observations` and writes one row per observation into `public.score_entries_obs`.  
   - `public.score_runs` tracks each scoring run.

3. **Leaderboards**  
   - Views (and templates under `sql/leaderboard_views.template.sql`) build trip specific participant and leaderboard views.  
   - Materialized views such as `public.leaderboard_overall_mv` cache the latest leaderboard for the frontend.

4. **Security**  
   - Tables have row level security.  
   - Frontends read from views using the anon key.  
   - Writes happen only through SECURITY DEFINER RPCs and controlled ingestion scripts.

5. **Ops and checks**  
   - `scripts/verify_supabase.mjs` and `test_supabase.mjs` provide connectivity, RLS, and smoke tests.  
   - SQL migrations under `supabase/migrations` are the only place schema and RLS are changed. They are designed to be idempotent.

---

## 3. Key files and what they are for

- `src/lib/supabase.ts`  
  Singleton Supabase client for Node scripts. Wraps `@supabase/supabase-js`, enforces correct env variables, and centralizes helper RPC calls like `safeUpsertUserLogin`, `refreshLeaderboards`, and `assertSecurityAndPerfOk`.

- `ingest.mjs`  
  Main ingestion runner. Important behavior:
  - Reads config from environment (TRIP, PROJECT, USER modes).
  - Enforces safety guards (trip bounding boxes, date windows, roster limits).
  - Paginates iNat API with retries and backoff.
  - Maps observations to a normalized schema (coords, taxonomy, media, raw JSON).
  - Upserts into Supabase via service role key with conflict handling.

- `scripts/verify_supabase.mjs`  
  Guided verification script:
  - Checks env presence and connection.
  - Confirms RLS blocks anon writes.
  - Calls security RPCs.
  - Reads key views to make sure they exist and are healthy.

- `test_supabase.mjs`  
  Lower level ingestion and REST harness useful for smoke tests and debugging timeouts, rate limits, or auth problems.

- `supabase/migrations/20251022000000_user_login_and_scoring_v2.sql`  
  Canonical migration for:
  - `user_login` table and safe upsert function.
  - Auth trigger wiring.
  - Scoring related views and indexes.
  - RLS policies.  
  This file must remain idempotent: re applying it should always succeed and leave schema consistent.

- `sql/leaderboard_views.template.sql`  
  Template SQL that defines:
  - Trip configuration tables.
  - Participant views.
  - Daily and overall leaderboards.
  - Supporting indexes.  
  It is meant to be copied and adapted per deployment or per trip.

- `RUNBOOK_DB_MIGRATIONS.md`  
  Operational runbook that explains:
  - How to plan migrations.
  - How to apply them (dashboard, CLI, psql).
  - How to verify success.
  - How to roll back or handle emergencies.

- `.github/workflows/ci.yml`  
  CI pipeline for:
  - Node build and tests.
  - SQL linting and schema checks.
  - Secret scans and service role misuse checks.
  - npm security checks.

- `.github/workflows/ingest-and-score.yml`  
  Scheduled and manual workflow that:
  - Runs ingestion on a matrix of trips and locations.
  - Triggers scoring and leaderboard refresh.
  - Surfaces counts and audits in the run summary.

- `package.json`, `README.md`, `env.example`  
  Define the Node 20 environment, dependencies, npm scripts, and initial setup steps.

If you are Codex, always prefer to extend these files rather than introduce completely different entry points.

---

## 4. Order of truth for Codex

When repo state and text disagree, use this priority:

1. **Current database schema and migrations** in `supabase/migrations`.  
2. **This AGENTS.md file** and any docs in `docs/` or `RUNBOOK_*`.  
3. **GitHub Actions workflows** and existing scripts (`ingest.mjs`, `scripts/verify_supabase.mjs`, `test_supabase.mjs`).  
4. Older notes or comments inside migrations.

If something in this file conflicts with the live schema, assume the schema is correct and adjust this file in a follow up.

---

## 5. Rules for database changes

When using `/plan` to touch SQL or migrations, follow these rules:

- Prefer `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, and additive columns.  
- Avoid `DROP ... CASCADE` entirely unless the task explicitly asks for it and you have a guard in place.  
- Do not change primary keys, row level security policies, or auth triggers without explicit instructions.  
- Keep scoring logic pure and explainable: each observation should tie back to one `score_entries_obs` row and a clear rubric.  
- If a v1 view is widely used and its shape must change, create a new `_v2` view and point new consumers at that instead of mutating v1.

If a task appears to require destructive operations, stop after `/plan` and ask for confirmation in the issue or chat.

---

## 6. Preferred Codex workflow

When starting a non trivial task, Codex should do roughly this:

1. **Use `/plan`**  
   - Summarize the requested change.  
   - List the files to inspect and the modifications you intend to make.  
   - Identify any migrations or RLS policies that might be affected.  
   - Call out risks (for example, “could affect ingest throughput” or “touches scoring math”).

2. **Pre flight sanity (do this in the shell where possible)**  
   - Print Node version and confirm scripts can run.  
   - Run a light database identity check: `current_database()`, `current_user`, `now()`.  
   - If touching scoring or leaderboards, run the core sanity SQL from section 8 first and note the counts.

3. **Edit files**  
   - Keep diffs minimal and focused.  
   - Reuse existing patterns for Supabase calls and logging.  
   - For migrations, keep them idempotent and well commented.

4. **Post flight checks**  
   - Run relevant npm scripts (`npm test`, `npm run ingest` with a safe config, or verification scripts).  
   - Re run the sanity SQL and confirm counts look reasonable.  
   - Summarize “What changed” and “Why it is safe” in the PR description or task notes.

---

## 7. Common task shapes and pitfalls

### 7.1 Adjusting or adding scoring features

Examples: new bonus, diminishing returns tweak, rarity adjustment.

- Touch the scoring SQL or RPCs, not the ingestion schema.  
- Keep `score_entries_obs` as the single source of truth for points per observation.  
- Make changes additive where possible, with feature flags in config tables if needed.  
- Pitfall: changing types or columns directly in v1 views that also feed the UI or reports. Prefer creating a `_v2` instead.

### 7.2 Changing leaderboard behavior

Examples: new trip leaderboard, different sort key, section specific views.

- Start from `sql/leaderboard_views.template.sql`.  
- Create new trip specific views or materialized views rather than mutating shared ones.  
- Ensure any new view still respects RLS and exposes only what the frontend needs.  
- Pitfall: pushing heavy, per request aggregations into views without indexes.

### 7.3 Ingestion tweaks

Examples: new trip filters, bounding box changes, extra logging.

- Confine changes to `ingest.mjs` and related config.  
- Preserve rate limit handling and backoff logic.  
- Do not leak the service role key outside of controlled ingestion scripts.  
- Pitfall: adding synchronous, blocking filesystem or network calls inside tight pagination loops.

### 7.4 Migrations and RLS

Examples: new table, new index, tightening a policy.

- Add new migrations under `supabase/migrations` with clear numbering and comments.  
- Keep RLS defaults restrictive and expose data via views.  
- Pitfall: enabling direct writes from anon or service role misuse that bypasses policies.

---

## 8. Sanity checks and definition of done

For most backend changes, the following should stay green.

### SQL checks

```sql
-- Latest run id
select id
from public.score_runs
order by started_at desc nulls last, id desc
limit 1;

-- Score entries for latest run
select
  (select id from public.score_runs order by started_at desc nulls last, id desc limit 1) as run_id,
  count(*) as rows_in_score_entries_obs,
  count(distinct user_login) as distinct_users
from public.score_entries_obs
where run_id = (select id from public.score_runs order by started_at desc nulls last, id desc limit 1);

-- Leaderboard top 10
select user_login, obs_count
from public.leaderboard_overall_mv
order by obs_count desc
limit 10;

-- Security and performance audit
select *
from public.assert_security_and_perf_ok();
```

### HTTP check

```bash
curl -sS -X POST   -H "apikey: $SUPABASE_SERVICE_KEY"   -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"   "$SUPABASE_URL/rest/v1/rpc/compute_scores_mvp"
```

**Definition of done for changes in this repo**

- All relevant sanity checks above succeed.  
- CI workflow `ci.yml` passes on the branch.  
- Ingest and score workflow runs without new errors.  
- `assert_security_and_perf_ok()` returns an empty set.  
- No destructive schema changes without explicit approval.

---

## 9. Naming and versioning conventions

- Use suffixes like `_v1`, `_v2` for views when contracts change.  
- Keep v1 surfaces stable for widely used filters and counts.  
- Use v2 for new scoring contracts or when column types need to change.  
- For trip specific views (for example CR2025 scoring), prefer names that clearly include the trip identifier.

When you hit `42P16` type or contract mismatches on views:

- Do not change the existing v1 view in place.  
- Create a new `_v2` view with the corrected contract.  
- Point new consumers to v2 and retire v1 only after callers are migrated.

---

## 10. Where to put this file

Place this file at the root of the repository as `AGENTS.md`.  
Codex and other agent tools will pick it up automatically when summarizing the repo and planning edits.
