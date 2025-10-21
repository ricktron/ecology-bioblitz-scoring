// ingest.mjs
// EcoQuest Live — P1 hardening + DEMO/TRIP toggle
// Node 20+ (uses global fetch). ESM enabled via package.json "type": "module".

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

const INAT_MODE = (process.env.INAT_MODE || "TRIP").toUpperCase(); // DEMO or TRIP

// DEMO (5y + Costa Rica bbox) — set via .env or GitHub secrets
const DEMO_D1 = process.env.DEMO_D1 || ""; // e.g., 2019-11-01
const DEMO_D2 = process.env.DEMO_D2 || ""; // e.g., 2025-11-01
const DEMO_BBOX = (process.env.DEMO_BBOX || "").split(",").map(Number); // swlat,swlng,nelat,nelng
const DEMO_USER_LOGINS = (process.env.DEMO_USER_LOGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// TRIP (project + optional bbox/dates) — set a week before departure
const TRIP_D1 = process.env.TRIP_D1 || "";
const TRIP_D2 = process.env.TRIP_D2 || "";
const TRIP_BBOX = (process.env.TRIP_BBOX || "").split(",").map(Number);

const SAFETY_OVERLAP_SECONDS = 30;  // –30s overlap window
const PER_PAGE = 200;               // iNat max = 200
const MAX_PAGES = 200;              // hard cap
const MAX_RETRIES = 6;              // exp backoff
const BASE_WAIT_MS = 500;
const OBS_TABLE = "observations";
const RUNS_TABLE = "score_runs";    // ledger with inat_updated_through_utc
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
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
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

async function sbDeleteByIds(table, ids) {
  if (!ids.length) return { count: 0 };
  let total = 0;
  const chunk = 5000;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const url = `${SUPABASE_URL}/rest/v1/${table}?id=in.(${slice.map(x => encodeURIComponent(x)).join(",")})`;
    const res = await fetch(url, { method: "DELETE", headers: sbHeaders() });
    if (!res.ok) throw new Error(`Supabase DELETE ${table} → ${res.status} ${await res.text()}`);
    total += slice.length;
  }
  return { count: total };
}

function iso(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  return d.toISOString();
}

async function getSinceTimestamp() {
  // Use the last ledgered 'inat_updated_through_utc' minus overlap; fallback to epoch
  const rows = await sbSelect(`${RUNS_TABLE}?select=inat_updated_through_utc&order=inat_updated_through_utc.desc&limit=1`);
  const last = rows?.[0]?.inat_updated_through_utc;
  const base = last ? new Date(last) : new Date(0);
  return new Date(base.getTime() - SAFETY_OVERLAP_SECONDS * 1000);
}

function iNatUrl(path, params) {
  const u = new URL(`https://api.inaturalist.org/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  });
  return u.toString();
}

function buildQueryParams({ page, perPage, sinceIso }) {
  if (INAT_MODE === "DEMO") {
    const [swlat, swlng, nelat, nelng] = DEMO_BBOX.length === 4 ? DEMO_BBOX : [null, null, null, null];
    const base = {
      order: "asc",
      order_by: "updated_at",
      updated_since: sinceIso,
      per_page: String(perPage),
      page: String(page),
      d1: DEMO_D1,
      d2: DEMO_D2,
      swlat, swlng, nelat, nelng,
    };
    if (DEMO_USER_LOGINS.length) base.user_login = DEMO_USER_LOGINS.join(",");
    return base;
  }
  // TRIP (project-based with optional time/space narrowing)
  const base = {
    project_slug: INAT_PROJECT_SLUG,
    order: "asc",
    order_by: "updated_at",
    updated_since: sinceIso,
    per_page: String(perPage),
    page: String(page),
  };
  if (TRIP_D1) base.d1 = TRIP_D1;
  if (TRIP_D2) base.d2 = TRIP_D2;
  if (TRIP_BBOX.length === 4) {
    const [swlat, swlng, nelat, nelng] = TRIP_BBOX;
    Object.assign(base, { swlat, swlng, nelat, nelng });
  }
  return base;
}

async function fetchUpdates(sinceIso) {
  let page = 1;
  let maxSeen = sinceIso;
  let totalUpserted = 0;

  while (page <= MAX_PAGES) {
    const url = iNatUrl("observations", buildQueryParams({ page, perPage: PER_PAGE, sinceIso }));
    const data = await fetchJson(url, { retryLabel: "iNat updates" });
    const results = data?.results ?? [];
    if (!results.length) break;

    const rows = results.map(r => ({
      id: r.id,
      user_id: r.user?.id ?? null,
      taxon_id: r.taxon?.id ?? null,
      observed_at: r.observed_on_details?.date ? iso(r.observed_on_details.date) : (r.time_observed_at || null),
      updated_at: r.updated_at ? iso(r.updated_at) : null,
      latitude: r.geojson?.coordinates ? r.geojson.coordinates[1] : (r.latitude ?? null),
      longitude: r.geojson?.coordinates ? r.geojson.coordinates[0] : (r.longitude ?? null),
      quality_grade: r.quality_grade ?? null,
      created_at: r.created_at ? iso(r.created_at) : null,
    }));

    await sbUpsert(OBS_TABLE, rows, "id");
    totalUpserted += rows.length;

    for (const r of rows) if (r.updated_at && r.updated_at > maxSeen) maxSeen = r.updated_at;
    if (results.length < PER_PAGE) break;
    page += 1;
  }
  return { totalUpserted, maxSeen };
}

async function fetchDeletedIdsSince(sinceIso) {
  // iNat doesn't expose a stable public "deleted observations" feed for all cases.
  // Try a best-effort; if it fails, we'll do reconciliation.
  try {
    const url = iNatUrl("observations/deleted", {
      project_slug: INAT_PROJECT_SLUG,
      updated_since: sinceIso,
      per_page: String(PER_PAGE),
    });
    const data = await fetchJson(url, { retryLabel: "iNat deletions" });
    const results = data?.results ?? [];
    return results.map(r => r.id).filter(Boolean);
  } catch {
    return null; // trigger reconciliation
  }
}

async function reconcileDeletes(sinceIso) {
  // Pull current IDs from iNat in the same updated window and compare to our recent Supabase set.
  const current = new Set();
  let page = 1;
  while (page <= 50) {
    const url = iNatUrl("observations", buildQueryParams({ page, perPage: PER_PAGE, sinceIso }));
    const data = await fetchJson(url, { retryLabel: "iNat reconciliation updates" });
    const results = data?.results ?? [];
    if (!results.length) break;
    for (const r of results) current.add(r.id);
    if (results.length < PER_PAGE) break;
    page += 1;
  }

  const sbIds = await sbSelect(`${OBS_TABLE}?select=id&updated_at=gte.${sinceIso}`);
  const supabaseRecent = new Set(sbIds.map(x => x.id));
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
  await sbUpsert(RUNS_TABLE, row);
}

async function main() {
  const startedAt = new Date();
  const since = await getSinceTimestamp();
  const sinceIso = iso(since);

  console.log(JSON.stringify({
    mode: INAT_MODE,
    params_preview: buildQueryParams({ page: 1, perPage: PER_PAGE, sinceIso })
  }));

  const { totalUpserted, maxSeen } = await fetchUpdates(sinceIso);

  let deletedIds = await fetchDeletedIdsSince(sinceIso);
  if (deletedIds === null) deletedIds = await reconcileDeletes(sinceIso);
  if (deletedIds.length) await sbDeleteByIds(OBS_TABLE, deletedIds);

  const endedAt = new Date();
  const maxSeenIso = maxSeen || sinceIso;
  await recordRun(maxSeenIso, { startedAt, endedAt, upserts: totalUpserted, deletes: deletedIds.length });

  console.log(JSON.stringify({
    status: "ok",
    upserts: totalUpserted,
    deletes: deletedIds.length,
    inat_updated_through_utc: maxSeenIso
  }));
}

main().catch(err => {
  console.error("[INGEST FAILED]", err.stack || err.message);
  process.exit(1);
});
