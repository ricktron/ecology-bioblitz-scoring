// ingest.mjs
// Robust iNaturalist → Supabase ingestor (ID Scrolling Version)
// Node 20+ (fetch available).

import { createClient } from "@supabase/supabase-js";

// ------------------ Env ------------------
const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();

const SUPABASE_URL = env("SUPABASE_URL");
// Use Service Role Key for secure access
const SUPABASE_SERVICE_KEY = env("SUPABASE_SERVICE_KEY") || env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
const TABLE = env("OBS_TABLE", "observations");
const ID_COL = env("OBS_ID_COLUMN", "inat_obs_id");
const UPDATED_AT_COL = env("OBS_UPDATED_AT_COLUMN", "updated_at");
const BATCH_SIZE = parseInt(env("UPSERT_BATCH_SIZE", "50"), 10) || 50;

// iNat inputs
const INAT_USER_AGENT =
  env("INAT_USER_AGENT") ||
  `ecology-bioblitz-scoring/ingest (+github-actions@users.noreply.github.com)`;

const INAT_EXPLICIT_MODE = env("INAT_MODE"); // optional, set by workflow
const INAT_PROJECT_SLUG = env("INAT_PROJECT_SLUG");
const INAT_USER_LOGIN = env("INAT_USER_LOGIN"); // For USER mode
const TRIP_BBOX = env("TRIP_BBOX"); // "west,south,east,north"
const TRIP_D1 = env("TRIP_D1"); // YYYY-MM-DD
const TRIP_D2 = env("TRIP_D2"); // YYYY-MM-DD
const UPDATED_SINCE = env("UPDATED_SINCE"); // ISO, optional

// Decide mode: prioritize USER, then explicit mode, then PROJECT, default to TRIP
let MODE;

if (INAT_USER_LOGIN) {
  MODE = "USER";
} else if (INAT_EXPLICIT_MODE) {
  MODE = INAT_EXPLICIT_MODE.toUpperCase();
} else if (INAT_PROJECT_SLUG) {
  MODE = "PROJECT";
} else {
  MODE = "TRIP";
}

// Validation and Safety Checks
if (MODE === "USER" && !INAT_USER_LOGIN) {
  throw new Error("INAT_USER_LOGIN is required for USER mode");
}
if (MODE === "PROJECT" && !INAT_PROJECT_SLUG) {
  throw new Error("INAT_PROJECT_SLUG is required for PROJECT mode");
}
// CRITICAL SAFETY CHECK: Prevent accidental global download in TRIP mode
if (MODE === "TRIP" && !TRIP_BBOX && !TRIP_D1 && !TRIP_D2 && !UPDATED_SINCE) {
  console.error("❌ ERROR: TRIP mode requires at least one filter (TRIP_BBOX, TRIP_D1/D2, or UPDATED_SINCE) to prevent excessive load.");
  process.exit(1);
}

// Print config line
console.log(
  JSON.stringify({
    mode: MODE,
    user: INAT_USER_LOGIN || null,
    project: INAT_PROJECT_SLUG || null,
    table: TABLE,
    batch_size: BATCH_SIZE,
    trip_d1: TRIP_D1 || null,
    trip_d2: TRIP_D2 || null,
    trip_bbox: TRIP_BBOX || null,
  })
);

// ------------------ Helpers ------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonWithRetries(url, init = {}, { maxRetries = 7, initialDelayMs = 800 } = {}) {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": INAT_USER_AGENT,
        Accept: "application/json",
        ...init.headers,
      },
    }).catch((e) => ({ ok: false, status: 0, statusText: e.message }));

    if (res.ok) {
      return res.json();
    }

    const status = res.status;
    const retryAfter = res.headers?.get?.("retry-after");
    const show = `HTTP ${status} ${res.statusText || ""}`.trim();

    // Rate limiting (429/403) or temporary server errors (50x)
    if ((status === 429 || status === 403 || status >= 500) && attempt < maxRetries) {
      let wait = delay + Math.floor(Math.random() * 300);
      // Honor Retry-After header if present
      if (retryAfter) {
        const ra = parseFloat(retryAfter);
        if (!Number.isNaN(ra)) wait = Math.max(wait, Math.ceil(ra * 1000));
      }
      // Ensure minimum wait of 1 second if rate limited
      wait = Math.max(wait, 1000);
      
      console.warn(`⚠️  [Attempt ${attempt}] ${show}, retry in ${wait}ms`);
      await sleep(wait);
      // Exponential backoff capped at 45s
      delay = Math.min(Math.floor(delay * 1.9), 45_000);
      continue;
    }

    // Read body safely for logging
    let body = "";
    try { body = await res.text(); } catch { body = ""; }
    throw new Error(`${show}: ${body.slice(0, 240)}`);
  }
  throw new Error(`Exceeded ${maxRetries} retries for ${url}`);
}

// ------------------ iNat query building ------------------
function buildBaseParams() {
  const p = new URLSearchParams();
  p.set("order", "desc");
  p.set("order_by", "id"); // enable id_below scrolling
  p.set("per_page", "100"); // stay well under the 200 hard cap

  if (MODE === "USER") {
    p.set("user_login", INAT_USER_LOGIN);
  } else if (MODE === "PROJECT") {
    p.set("project_slug", INAT_PROJECT_SLUG);
  } else { // TRIP
    // Accept bbox as "west,south,east,north" (lon1,lat1,lon2,lat2)
    if (TRIP_BBOX) {
      const parts = TRIP_BBOX.split(",").map((s) => s.trim()).map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const [west, south, east, north] = parts;
        p.set("swlng", String(west));
        p.set("swlat", String(south));
        p.set("nelng", String(east));
        p.set("nelat", String(north));
      } else {
        console.warn("⚠️  TRIP_BBOX invalid format; ignoring.");
      }
    }
    if (TRIP_D1) p.set("d1", TRIP_D1);
    if (TRIP_D2) p.set("d2", TRIP_D2);
  }

  if (UPDATED_SINCE) p.set("updated_since", UPDATED_SINCE);
  return p;
}

// Robust cursor-based scrolling
async function* iNatScroll() {
  const base = "https://api.inaturalist.org/v1/observations";
  const baseParams = buildBaseParams();
  let idBelow = null;

  while (true) {
    const params = new URLSearchParams(baseParams);
    if (idBelow) params.set("id_below", String(idBelow));
    const url = `${base}?${params.toString()}`;
    const json = await fetchJsonWithRetries(url, {});
    const results = json?.results ?? [];
    if (!results.length) break;
    yield results;
    idBelow = results[results.length - 1].id;
    
    // CRITICAL FIX: Polite pacing (1 req/sec recommended by iNat)
    // The previous configuration caused 403 Forbidden errors due to excessive speed.
    await sleep(1000);
  }
}

// ------------------ Supabase ------------------
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing Supabase URL or key");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

async function upsertMinimal(batch) {
  if (!batch.length) return;
  // Map the full iNat object to the minimal required columns for the DB
  const rows = batch.map((o) => ({
    [ID_COL]: o.id,
    [UPDATED_AT_COL]: o.updated_at || o.created_at || null,
  }));
  const { error } = await supabase.from(TABLE).upsert(rows, { onConflict: ID_COL });
  if (error) throw error;
}

// ------------------ Main ------------------
async function main() {
  let total = 0;
  let buffer = [];

  for await (const page of iNatScroll()) {
    for (const obs of page) {
      buffer.push(obs);
      if (buffer.length >= BATCH_SIZE) {
        await upsertMinimal(buffer);
        total += buffer.length;
        buffer = [];
        console.log(`... processed ${total} records ...`);
      }
    }
  }

  if (buffer.length) {
    await upsertMinimal(buffer);
    total += buffer.length;
  }

  console.log(`✅ [Mode: ${MODE}] Upserted/verified ${total} observations into ${TABLE}`);
}

main().catch((err) => {
  console.error(`❌ INGEST FAILED: ${err.message}`);
  // Ensure the error is visible in GitHub Actions logs
  console.error("::error::" + err.message);
  process.exit(1);
});
