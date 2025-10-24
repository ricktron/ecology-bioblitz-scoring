// ingest.mjs
// EcoQuest Live — P1 hardening + DEMO/TRIP toggle + flexible table/columns + column autodetect
// Node 20+, ESM ("type": "module" in package.json)

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "INAT_PROJECT_SLUG"];
for (const k of REQUIRED_ENV) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL.replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INAT_PROJECT_SLUG = process.env.INAT_PROJECT_SLUG;

// Flexible schema knobs (via GH Secrets)
const OBS_TABLE = process.env.OBS_TABLE || "observations";
const OBS_ID_COLUMN = process.env.OBS_ID_COLUMN || "id";            // e.g., "inat_obs_id"
const OBS_UPDATED_AT_COLUMN = process.env.OBS_UPDATED_AT_COLUMN || "updated_at";
const SKIP_DELETES = String(process.env.SKIP_DELETES || "").toLowerCase() === "true";

const INAT_MODE = (process.env.INAT_MODE || "TRIP").toUpperCase();  // DEMO or TRIP
const DEMO_D1 = process.env.DEMO_D1 || "";
const DEMO_D2 = process.env.DEMO_D2 || "";
const DEMO_BBOX = (process.env.DEMO_BBOX || "").split(",").map(Number);
const DEMO_USER_LOGINS = (process.env.DEMO_USER_LOGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const TRIP_D1 = process.env.TRIP_D1 || "";
const TRIP_D2 = process.env.TRIP_D2 || "";
const TRIP_BBOX = (process.env.TRIP_BBOX || "").split(",").map(Number);

// Tunables
const SAFETY_OVERLAP_SECONDS = 30;
const PER_PAGE = 200;
const MAX_PAGES = 200;
const MAX_RETRIES = 6;
const BASE_WAIT_MS = 500;
const RUNS_TABLE = "score_runs";
const USER_AGENT = "EcoQuestLive/ingest (+contact: maintainer)";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, { method = "GET", headers = {}, body, retryLabel } = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method, body, headers: { "User-Agent": USER_AGENT, ...headers } });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep((retryAfter + attempt) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw new Error(`${retryLabel || "fetch"} failed: ${err.message}`);
      await sleep(BASE_WAIT_MS * Math.pow(2, attempt));
    }
  }
}

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
}
async function sbSelect(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase SELECT ${path} → ${res.status} ${await res.text()}`);
  return await res.json();
}
async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return { count: 0 };
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  const url = `${SUPABASE_URL}/rest/v1/${table}${qs}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} → ${res.status} ${await res.text()}`);
  return { count: rows.length };
}
async function sbDeleteByIds(table, idColumn, ids) {
  if (!ids.length) return { count: 0 };
  let total = 0;
  const chunk = 5000;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk).map(x => encodeURIComponent(x));
    const url = `${SUPABASE_URL}/rest/v1/${table}?${encodeURIComponent(idColumn)}=in.(${slice.join(",")})`;
    const res = await fetch(url, { method: "DELETE", headers: sbHeaders() });
    if (!res.ok) throw new Error(`Supabase DELETE ${table} → ${res.status} ${await res.text()}`);
    total += slice.length;
  }
  return { count: total };
}

// ---------- Chunked UPSERT wrapper (drop-in) ----------
// Tune batch size via env UPSERT_BATCH_SIZE (default 100)
const UPSERT_BATCH_SIZE = parseInt(process.env.UPSERT_BATCH_SIZE || "100", 10);
/**
 * upsertInChunks: calls sbUpsert in small batches to avoid PostgREST 57014 (statement timeout)
 * Preserves Prefer header and all sbUpsert behavior. No DB/RPC signature changes.
 */
async function upsertInChunks(table, rows, onConflict) {
  if (!rows || !rows.length) return { count: 0 };
  let total = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const slice = rows.slice(i, i + UPSERT_BATCH_SIZE);
    // Tiny internal retry for transient 5xx/429/timeout per chunk
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await sbUpsert(table, slice, onConflict);
        total += r.count || slice.length;
        break;
      } catch (err) {
        const msg = String((err && err.message) || err || "");
        if (attempt < 2 && /(?:^|[^a-z])(5\d\d|429|timeout)/i.test(msg)) {
          const backoffMs = 500 * attempt;
          console.warn(`[UPSERT CHUNK RETRY ${attempt}] ${msg} — sleeping ${backoffMs}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }
  }
  return { count: total };
}

// ---------- schema autodetect ----------
async function sbColumnExists(table, column) {
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(column)}&limit=0`;
  const res = await fetch(url, { headers: sbHeaders() });
  const criticalCols = ["user_login", "raw_json"];
  if (!res.ok && criticalCols.includes(column)) {
    // Log details for critical column detection failures
    console.warn(`[sbColumnExists] ${column} detection returned ${res.status}`);
  }
  return res.ok;
}
async function detectColumns() {
  const must = new Set([OBS_ID_COLUMN]); // must exist
  const optional = [
    "user_id",
    "user_login",     // NEW: map iNat username if column exists (often NOT NULL)
    "taxon_id",
    "observed_at",
    OBS_UPDATED_AT_COLUMN,
    "latitude",
    "longitude",
    "quality_grade",
    "created_at",
    "raw_json",       // Store full iNat API response (often NOT NULL)
  ];
  const present = new Set([...must]);

  // Try to detect each column, with retry logic for critical columns
  const criticalCols = new Set(["user_login", "raw_json"]); // Columns often with NOT NULL constraints

  for (const col of optional) {
    if (!col) continue;
    let detected = false;
    try {
      detected = await sbColumnExists(OBS_TABLE, col);
      // Always assume critical columns exist (common required fields with NOT NULL constraints)
      if (criticalCols.has(col) && !detected) {
        console.warn(`[detectColumns] ${col} not detected, but assuming it exists (common required field)`);
        detected = true;
      }
    } catch (err) {
      // If detection fails for critical columns, assume they exist
      if (criticalCols.has(col)) {
        console.warn(`[detectColumns] Detection error for ${col}, assuming it exists: ${err.message}`);
        detected = true;
      }
    }
    if (detected) present.add(col);
  }

  return present;
}

function iso(dt) { return (dt instanceof Date ? dt : new Date(dt)).toISOString(); }

async function getSinceTimestamp() {
  try {
    const rows = await sbSelect(`${RUNS_TABLE}?select=inat_updated_through_utc&order=inat_updated_through_utc.desc&limit=1`);
    const last = rows?.[0]?.inat_updated_through_utc;
    const base = last ? new Date(last) : new Date(0);
    const ledgerSince = new Date(base.getTime() - SAFETY_OVERLAP_SECONDS * 1000);
    if (INAT_MODE === "DEMO" && DEMO_D1) return new Date(`${DEMO_D1}T00:00:00Z`);
    return ledgerSince;
  } catch {
    return (INAT_MODE === "DEMO" && DEMO_D1) ? new Date(`${DEMO_D1}T00:00:00Z`) : new Date(0);
  }
}

function iNatUrl(path, params) {
  const u = new URL(`https://api.inaturalist.org/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v); });
  return u.toString();
}

function buildQueryParams({ page, perPage, sinceIso }) {
  if (INAT_MODE === "DEMO") {
    const [swlat, swlng, nelat, nelng] = DEMO_BBOX.length === 4 ? DEMO_BBOX : [null, null, null, null];
    const base = { order: "asc", order_by: "updated_at", updated_since: sinceIso, per_page: String(perPage), page: String(page),
                   d1: DEMO_D1, d2: DEMO_D2, swlat, swlng, nelat, nelng };
    if (DEMO_USER_LOGINS.length) base.user_login = DEMO_USER_LOGINS.join(",");
    return base;
  }
  const base = { project_slug: INAT_PROJECT_SLUG, order: "asc", order_by: "updated_at", updated_since: sinceIso,
                 per_page: String(perPage), page: String(page) };
  if (TRIP_D1) base.d1 = TRIP_D1;
  if (TRIP_D2) base.d2 = TRIP_D2;
  if (TRIP_BBOX.length === 4) {
    const [swlat, swlng, nelat, nelng] = TRIP_BBOX;
    Object.assign(base, { swlat, swlng, nelat, nelng });
  }
  return base;
}

async function fetchUpdates(sinceIso, presentCols) {
  let page = 1, maxSeen = sinceIso, totalUpserted = 0;
  while (page <= MAX_PAGES) {
    const url = iNatUrl("observations", buildQueryParams({ page, perPage: PER_PAGE, sinceIso }));
    const data = await fetchJson(url, { retryLabel: "iNat updates" });
    const results = data?.results ?? [];
    if (!results.length) break;

    const rows = results.map(r => {
      const rec = { [OBS_ID_COLUMN]: r.id };
      const ua = r.updated_at ? iso(r.updated_at) : null;

      if (presentCols.has("user_id"))    rec.user_id    = r.user?.id ?? null;

      // Always populate user_login (critical field, often has NOT NULL constraint)
      // Use actual login, fallback to user_ID format, or "unknown" if user data missing
      if (presentCols.has("user_login")) {
        rec.user_login = r.user?.login || (r.user?.id ? `user_${r.user.id}` : "unknown");
      }

      if (presentCols.has("taxon_id"))   rec.taxon_id   = r.taxon?.id ?? null;
      if (presentCols.has("observed_at")) rec.observed_at = r.observed_on_details?.date ? iso(r.observed_on_details.date) : (r.time_observed_at || null);
      if (presentCols.has(OBS_UPDATED_AT_COLUMN)) rec[OBS_UPDATED_AT_COLUMN] = ua;
      if (presentCols.has("latitude"))   rec.latitude   = r.geojson?.coordinates ? r.geojson.coordinates[1] : (r.latitude ?? null);
      if (presentCols.has("longitude"))  rec.longitude  = r.geojson?.coordinates ? r.geojson.coordinates[0] : (r.longitude ?? null);
      if (presentCols.has("quality_grade")) rec.quality_grade = r.quality_grade ?? null;
      if (presentCols.has("created_at")) rec.created_at = r.created_at ? iso(r.created_at) : null;

      // Store full iNat API response (critical field, often has NOT NULL constraint)
      if (presentCols.has("raw_json")) {
        rec.raw_json = r; // Store the entire observation object as JSONB
      }

      if (ua && ua > maxSeen) maxSeen = ua;
      return rec;
    });

    // CHANGED: use chunked upsert to avoid timeouts
    const up = await upsertInChunks(OBS_TABLE, rows, OBS_ID_COLUMN);
    totalUpserted += up.count || rows.length;

    if (results.length < PER_PAGE) break;
    page += 1;
  }
  return { totalUpserted, maxSeen };
}

async function fetchDeletedIdsSince(sinceIso) {
  try {
    const url = iNatUrl("observations/deleted", { project_slug: INAT_PROJECT_SLUG, updated_since: sinceIso, per_page: String(PER_PAGE) });
    const data = await fetchJson(url, { retryLabel: "iNat deletions" });
    const results = data?.results ?? [];
    return results.map(r => r.id).filter(Boolean);
  } catch { return null; }
}

async function reconcileDeletes(sinceIso, presentCols) {
  const current = new Set();
  let page = 1;
  while (page <= 50) {
    const url = iNatUrl("observations", buildQueryParams({ page, perPage: PER_PAGE, sinceIso }));
    const data = await fetchJson(url, { retryLabel: "iNat reconciliation updates" });
    const results = data?.results ?? [];
    if (!results.length) break;
    for (const r of results) current.add(String(r.id));
    if (results.length < PER_PAGE) break;
    page += 1;
  }

  if (!presentCols.has(OBS_UPDATED_AT_COLUMN)) return [];

  const sel = encodeURIComponent(OBS_ID_COLUMN);
  const upd = encodeURIComponent(OBS_UPDATED_AT_COLUMN);
  const rows = await sbSelect(`${OBS_TABLE}?select=${sel}&${upd}=gte.${sinceIso}`);
  const supabaseRecent = new Set(rows.map(x => String(x[OBS_ID_COLUMN])));
  const toDelete = [...supabaseRecent].filter(id => !current.has(id));
  return toDelete;
}

async function recordRun(maxSeenIso, stats) {
  const row = [{
    started_at: iso(stats.startedAt),
    ended_at: iso(stats.endedAt),
    inat_updated_through_utc: maxSeenIso,
    notes: `ingest-only run (${INAT_MODE})`,
    ingested_count: stats.upserts,
    deleted_count: stats.deletes,
  }];
  try { await sbUpsert(RUNS_TABLE, row); }
  catch (e) { console.warn("[recordRun] ledger write skipped:", e.message); }
}

async function main() {
  const startedAt = new Date();
  const since = await getSinceTimestamp();
  const sinceIso = iso(since);

  const presentCols = await detectColumns();

  console.log(JSON.stringify({
    mode: INAT_MODE,
    table: OBS_TABLE,
    id_column: OBS_ID_COLUMN,
    updated_at_column: OBS_UPDATED_AT_COLUMN,
    present_columns: [...presentCols],
    params_preview: buildQueryParams({ page: 1, perPage: PER_PAGE, sinceIso })
  }));

  const { totalUpserted, maxSeen } = await fetchUpdates(sinceIso, presentCols);

  let deletedIds = [];
  if (!SKIP_DELETES) {
    deletedIds = await fetchDeletedIdsSince(sinceIso) ?? await reconcileDeletes(sinceIso, presentCols);
    if (deletedIds.length) await sbDeleteByIds(OBS_TABLE, OBS_ID_COLUMN, deletedIds);
  } else {
    console.log("[deletes] SKIP_DELETES=true — skipping deletions this run");
  }

  const endedAt = new Date();
  const maxSeenIso = maxSeen || sinceIso;
  await recordRun(maxSeenIso, { startedAt, endedAt, upserts: totalUpserted, deletes: deletedIds.length });

  console.log(JSON.stringify({ status: "ok", upserts: totalUpserted, deletes: deletedIds.length, inat_updated_through_utc: maxSeenIso }));
}

main().catch(err => {
  console.error("[INGEST FAILED]", err.stack || err.message);
  process.exit(1);
});
