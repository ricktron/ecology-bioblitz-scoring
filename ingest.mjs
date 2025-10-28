// ingest.mjs
// Robust iNaturalist → Supabase ingestor (ID Scrolling Version with Full, Standardized Mapping)
// Node 20+ (fetch available).

import { createClient } from "@supabase/supabase-js";

// ------------------ Env ------------------
const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();

const SUPABASE_URL = env("SUPABASE_URL");
// Use Service Role Key for secure access
const SUPABASE_SERVICE_KEY = env("SUPABASE_SERVICE_KEY") || env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
const TABLE = env("OBS_TABLE", "observations");
// The primary key column name in Supabase that matches the iNat observation ID.
const ID_COL = env("OBS_ID_COLUMN", "inat_obs_id");
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
    table: TABLE,
    batch_size: BATCH_SIZE,
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
  p.set("per_page", "100");
  
  // Optimization: Request only the fields needed for the database mapping.
  // We explicitly request taxon.ancestors to populate the taxonomic hierarchy.
  p.set("fields", "id,created_at,updated_at,observed_on,time_observed_at,user.id,user.login,taxon.id,taxon.name,taxon.rank,taxon.rank_level,taxon.ancestors,quality_grade,location,geojson,cached_votes_total,faves_count,num_identification_agreements,num_identification_disagreements,captive,photos,sounds,ofvs");

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
    await sleep(1000);
  }
}

// ------------------ Supabase & Data Mapping ------------------
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing Supabase URL or key");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// Helper to extract the primary photo URL (medium size)
function getPhotoUrl(photos) {
  if (!photos || photos.length === 0) return null;
  // Try to get 'medium' by replacing 'square' (thumbnail) in the URL
  return photos[0].url?.replace("/square.", "/medium.") || photos[0].url;
}

// Robust helper to find a specific rank in the ancestors array
function getAncestorRank(ancestors, rank) {
    if (!ancestors) return null;
    const ancestor = ancestors.find(a => a.rank === rank);
    return ancestor ? ancestor.name : null;
}

// Comprehensive mapping from iNat API object to Supabase schema
async function upsertObservations(batch) {
  if (!batch.length) return;

  const rows = batch.map((o) => {
    // Extract coordinates robustly
    let latitude = null;
    let longitude = null;
    
    // 1. Prefer GeoJSON (standard format: [longitude, latitude])
    if (o.geojson && o.geojson.coordinates && o.geojson.coordinates.length === 2) {
        longitude = o.geojson.coordinates[0];
        latitude = o.geojson.coordinates[1];
    } 
    // 2. Fallback to 'location' string (iNat format: "latitude,longitude")
    else if (o.location) {
        const coords = o.location.split(',');
        if (coords.length === 2) {
            latitude = parseFloat(coords[0]);
            longitude = parseFloat(coords[1]);
        }
    }
    
    // Ensure coordinates are valid numbers
    if (!Number.isFinite(latitude)) latitude = null;
    if (!Number.isFinite(longitude)) longitude = null;

    
    // Map to the database schema (Column names must match the standardized Supabase table)
    return {
      [ID_COL]: o.id, // e.g., inat_obs_id
      
      user_id: o.user?.id || null, 
      user_login: o.user?.login || null,
      
      // Timestamps (using standard ISO formats)
      observed_on: o.observed_on || null, // Date only (YYYY-MM-DD)
      time_observed_at: o.time_observed_at || null, // Full timestamp
      created_at: o.created_at,
      updated_at: o.updated_at || o.created_at,
      
      // Location
      latitude: latitude,
      longitude: longitude,
      
      // Taxon Information
      taxon_id: o.taxon?.id || null,
      taxon_name: o.taxon?.name || null,
      taxon_rank: o.taxon?.rank || null,
      taxon_rank_level: o.taxon?.rank_level || null,
      
      // Taxonomic Hierarchy (derived from ancestors)
      // FIX: Renamed to standardized taxon_* prefix to align with DB schema and avoid reserved keywords
      taxon_kingdom: getAncestorRank(o.taxon?.ancestors, 'kingdom'),
      taxon_phylum: getAncestorRank(o.taxon?.ancestors, 'phylum'),
      taxon_class: getAncestorRank(o.taxon?.ancestors, 'class'),
      taxon_order: getAncestorRank(o.taxon?.ancestors, 'order'),
      taxon_family: getAncestorRank(o.taxon?.ancestors, 'family'),
      taxon_genus: getAncestorRank(o.taxon?.ancestors, 'genus'),

      // Metrics and Quality
      quality_grade: o.quality_grade,
      is_research: o.quality_grade === "research",
      votes: o.cached_votes_total || 0,
      faves: o.faves_count || 0,
      ident_agreements: o.num_identification_agreements || 0,
      ident_disagreements: o.num_identification_disagreements || 0,
      
      // Media
      photo_url: getPhotoUrl(o.photos),
      photo_count: o.photos?.length || 0,
      sound_count: o.sounds?.length || 0,
      
      // Misc
      is_captive: o.captive || false,
      ofvs: o.ofvs || [], // Observation Field Values (JSONB)
    };
  });

  // Perform the UPSERT. The conflict column must match the ID_COL environment variable.
  const { error } = await supabase.from(TABLE).upsert(rows, { onConflict: ID_COL });
  
  if (error) {
    // Log detailed error information for debugging
    console.error("❌ Supabase UPSERT Error:", JSON.stringify(error, null, 2));
    // Throw the error so the node process exits with failure
    throw new Error(`Supabase error: ${error.message} (Code: ${error.code})`);
  }
}

// ------------------ Main ------------------
async function main() {
  let total = 0;
  let buffer = [];

  for await (const page of iNatScroll()) {
    for (const obs of page) {
      buffer.push(obs);
      if (buffer.length >= BATCH_SIZE) {
        await upsertObservations(buffer);
        total += buffer.length;
        buffer = [];
        console.log(`... processed ${total} records ...`);
      }
    }
  }

  if (buffer.length) {
    await upsertObservations(buffer);
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
