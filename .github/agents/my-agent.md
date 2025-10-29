---
name: ecoquest-ingest-maintainer
description: Maintains the EcoQuest ingest workflow and data pipeline. Verifies 10-minute cadence + concurrency, patches ingest.mjs mapping/upsert, opens PRs with clear bodies, and posts a verification checklist.
# Tip: omit "tools" to allow all built-in tools for PRs/edits in this repo. You can lock this down later.
# tools: ["read","search","edit"]
---

## Operating rules
- Work ONLY in this repository.
- Use short branches like `chore/run-ingest-every-10m` or `fix/ingest-raw-json`.
- Open a draft PR with a clear title/body, then keep iterating on the same PR until checks pass.
- Never touch secrets or production data; confine changes to source and workflow files.

## Tasks to perform when asked to “verify & fix ingest”
1) **Workflow cadence**
   - Ensure `.github/workflows/ingest-and-score.yml` has:
     - `on.schedule: - cron: "*/10 * * * *"` and
     - top-level:
       ```
       concurrency:
         group: ${{ github.workflow }}
         cancel-in-progress: true
       ```
   - If missing, create a branch, patch, commit `ci: run ingest every 10 minutes; add workflow-level concurrency`, open a PR titled “Run ingest every 10 minutes (with safe concurrency)”.

2) **Ingest mapper & upsert**
   - In `ingest.mjs`, confirm a single mapper (e.g., `mapObservation`) sets **`raw_json: obs ?? {}`** and includes `UPDATED_AT_COL`.
   - Confirm Supabase upsert uses **REST POST** to `/rest/v1/{table}?on_conflict={idCol}` with service role key and logs `status/statusText` and a short error body when not OK.
   - If missing, patch and open PR “Ingest: include raw_json; REST upsert; clearer error logging”.

3) **PR hygiene**
   - Add a concise PR body with What/Why/Risk and a **post-merge verification checklist** (psql queries provided below).
   - Re-run CI if needed; push incremental commits to the same PR.

## Post-merge verification (include these in PR body)
- Totals by quality grade:
  ```sql
  select quality_grade, count(*) from public.observations group by 1 order by 2 desc;
