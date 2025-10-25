// ingest.mjs
// iNaturalist → Supabase observation ingest (ESM, Node 20+, no external deps)
// Handles: incremental sync, robust retry, auto batch shrinking on timeout

// ============================================================================
// CONFIGURATION & VALIDATION
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_KEY = 
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const INAT_PROJECT_SLUG = process.env.INAT_PROJECT_SLUG;

if (!SUPABASE_URL || !SUPABASE_KEY || !INAT_PROJECT_SLUG) {
  console.error("❌ Missing required envs: SUPABASE_URL, one of SUPABASE_*_KEY, INAT_PROJECT_SLUG");
  process.exit(1);
}

// Optional config
const INAT_MODE = (process.env.INAT_MODE || "TRIP").toUpperCase();
const TRIP_D1 = process.env.TRIP_D1 || "";
const TRIP_D2 = process.env.TRIP_D2 || "";
const TRIP_BBOX = process.env.TRIP_BBOX ? process.env.TRIP_BBOX.split(",").map(Number) : [];
const OBS_TABLE = process.env.OBS_TABLE || "observations";
const OBS_ID_COLUMN = process.env.OBS_ID_COLUMN || "id";
const OBS_UPDATED_AT_COLUMN = process.env.OBS_UPDATED_AT_COLUMN || "updated_at";
const SKIP_DELETES = String(process.env.SKIP_DELETES || "").toLowerCase() === "true";
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";

// Performance tuning - default to safer 50, can override to 100 via env
let UPSERT_BATCH_SIZE = parseInt(process.env.UPSERT_BATCH_SIZE || "50", 10);
const MIN_BATCH_SIZE = 10;

// Retry config
const MAX_RETRIES = 6;
const BASE_WAIT_MS = 500;
const USER_AGENT = "ecology-bioblitz/1.0 (+github actions)";

// ============================================================================
// UTILITIES
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.random() * 1000;
}

function iso(dt) {
  return (dt instanceof Date ? dt : new Date(dt)).toISOString();
}

// ============================================================================
// SUPABASE API
// ============================================================================

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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase SELECT ${path} → ${res.status} ${text}`);
  }
  return await res.json();
}

async function sbUpsert(table, rows, onConflict, batchSize = UPSERT_BATCH_SIZE) {
  if (!rows.length) return { count: 0 };
  
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  const url = `${SUPABASE_URL}/rest/v1/${table}${qs}`;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { 
          ...sbHeaders(), 
          Prefer: "resolution=merge-duplicates,return=minimal" 
        },
        body: JSON.stringify(rows),
      });
      
      if (res.ok) {
        return { count: rows.length };
      }
      
      const text = await res.text();
      
      // Handle statement timeout (57014) by auto-shrinking batch
      if (res.status === 500 && text.includes("57014") && batchSize > MIN_BATCH_SIZE) {
        const newBatchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
        console.warn(`⚠️  Statement timeout (57014) detected. Shrinking batch ${batchSize} → ${newBatchSize}`);
        
        // Split current batch and retry recursively
        const mid = Math.ceil(rows.length / 2);
        const left = rows.slice(0, mid);
        const right = rows.slice(mid);
        
        const r1 = await sbUpsert(table, left, onConflict, newBatchSize);
        const r2 = await sbUpsert(table, right, onConflict, newBatchSize);
        
        return { count: r1.count + r2.count };
      }
      
      // Retry on 5xx
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = jitter(BASE_WAIT_MS * Math.pow(2, attempt));
        console.warn(`⚠️  [UPSERT CHUNK RETRY ${attempt + 1}] ${res.status} ${text.substring(0, 100)}`);
        await sleep(waitMs);
        continue;
      }
      
      throw new Error(`Supabase UPSERT ${table} → ${res.status} ${text}`);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const waitMs = jitter(BASE_WAIT_MS * Math.pow(2, attempt));
      console.warn(`⚠️  [UPSERT CHUNK RETRY ${attempt + 1}] ${err.message}`);
      await sleep(waitMs);
    }
  }
}

async function sbColumnExists(table, column) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(column)}&limit=0`;
    const res = await fetch(url, { headers: sbHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// INAT API
// ============================================================================

async function fetchJson(url, { retryLabel = "fetch", maxRetries = MAX_RETRIES } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });
      
      // Handle rate limiting
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
        const waitMs = (retryAfter + attempt) * 1000;
        console.warn(`⚠️  [${retryLabel}] 429 rate limit, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      
      // Handle forbidden (may be transient)
      if (res.status === 403) {
        if (attempt < maxRetries) {
          const waitMs = jitter(BASE_WAIT_MS * Math.pow(2, attempt));
          console.warn(`⚠️  [${retryLabel}] 403 forbidden, retry in ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
      }
      
      // Handle 5xx
      if (res.status >= 500 && attempt < maxRetries) {
        const waitMs = jitter(BASE_WAIT_MS * Math.pow(2, attempt));
        console.warn(`⚠️  [${retryLabel}] ${res.status} server error, retry in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      
      return await res.json();
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`${retryLabel} failed: ${err.message}`);
      }
      const waitMs = jitter(BASE_WAIT_MS * Math.pow(2, attempt));
      console.warn(`⚠️  [${retryLabel}] Error: ${err.message}, retry in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

function buildInatUrl(page, perPage, updatedSince) {
  const base = "https://api.inaturalist.org/v1/observations";
  const params = new URLSearchParams({
    project_slug: INAT_PROJECT_SLUG,
    order: "asc",
    order_by: "updated_at",
    per_page: String(perPage),
    page: String(page),
  });
  
  if (updatedSince) {
    params.set("updated_since", updatedSince);
  }
  
  if (TRIP_D1) params.set("d1", TRIP_D1);
  if (TRIP_D2) params.set("d2", TRIP_D2);
  
  if (TRIP_BBOX.length === 4) {
    const [swlat, swlng, nelat, nelng] = TRIP_BBOX;
    params.set("swlat", swlat);
    params.set("swlng", swlng);
    params.set("nelat", nelat);
    params.set("nelng", nelng);
  }
  
  return `${base}?${params.toString()}`;
}

// ============================================================================
// INCREMENTAL SYNC
// ============================================================================

async function getLastUpdatedAt() {
  try {
    if (!OBS_UPDATED_AT_COLUMN) return null;
    
    const rows = await sbSelect(
      `${OBS_TABLE}?select=${OBS_UPDATED_AT_COLUMN}&order=${OBS_UPDATED_AT_COLUMN}.desc&limit=1`
    );
    
    if (rows && rows.length > 0 && rows[0][OBS_UPDATED_AT_COLUMN]) {
      return new Date(rows[0][OBS_UPDATED_AT_COLUMN]);
    }
  } catch (err) {
    console.warn(`⚠️  Could not fetch last ${OBS_UPDATED_AT_COLUMN}: ${err.message}`);
  }
  return null;
}

// ============================================================================
// OBSERVATION NORMALIZATION
// ============================================================================

function normalizeObservation(obs) {
  const row = {
    [OBS_ID_COLUMN]: obs.id,
    user_id: obs.user?.id ?? null,
    user_login: obs.user?.login ?? null,
    taxon_id: obs.taxon?.id ?? null,
    observed_at: obs.observed_on_details?.date 
      ? iso(obs.observed_on_details.date)
      : (obs.time_observed_at || null),
    [OBS_UPDATED_AT_COLUMN]: obs.updated_at ? iso(obs.updated_at) : null,
    latitude: obs.geojson?.coordinates?.[1] ?? obs.latitude ?? null,
    longitude: obs.geojson?.coordinates?.[0] ?? obs.longitude ?? null,
    quality_grade: obs.quality_grade ?? null,
    created_at: obs.created_at ? iso(obs.created_at) : null,
    raw_json: obs, // Will be stringified by PostgREST
  };
  
  return row;
}

// ============================================================================
// MAIN INGEST
// ============================================================================

async function main() {
  const startedAt = new Date();
  
  // Determine incremental sync point
  const lastUpdated = await getLastUpdatedAt();
  const updatedSince = lastUpdated ? iso(new Date(lastUpdated.getTime() - 30000)) : null; // 30s overlap
  
  // Check if soft delete column exists
  const hasSoftDelete = await sbColumnExists(OBS_TABLE, "is_active");
  
  // Build params preview
  const paramsPreview = {
    mode: INAT_MODE,
    table: OBS_TABLE,
    id_column: OBS_ID_COLUMN,
    updated_at_column: OBS_UPDATED_AT_COLUMN,
    batch_size: UPSERT_BATCH_SIZE,
    updated_since: updatedSince,
    trip_d1: TRIP_D1 || null,
    trip_d2: TRIP_D2 || null,
    trip_bbox: TRIP_BBOX.length === 4 ? TRIP_BBOX : null,
    skip_deletes: SKIP_DELETES,
    has_soft_delete: hasSoftDelete,
  };
  
  console.log(JSON.stringify(paramsPreview));
  
  // Fetch and upsert observations
  let page = 1;
  let totalUpserted = 0;
  let maxSeenUpdatedAt = updatedSince;
  const PER_PAGE = 200;
  const MAX_PAGES = 200;
  
  while (page <= MAX_PAGES) {
    const url = buildInatUrl(page, PER_PAGE, updatedSince);
    const data = await fetchJson(url, { retryLabel: `iNat page ${page}` });
    const results = data?.results ?? [];
    
    if (!results.length) break;
    
    const rows = results.map(normalizeObservation);
    
    // Track max updated_at for next run
    for (const row of rows) {
      const ua = row[OBS_UPDATED_AT_COLUMN];
      if (ua && (!maxSeenUpdatedAt || ua > maxSeenUpdatedAt)) {
        maxSeenUpdatedAt = ua;
      }
    }
    
    // Upsert in chunks
    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
      await sbUpsert(OBS_TABLE, chunk, OBS_ID_COLUMN);
      totalUpserted += chunk.length;
    }
    
    if (results.length < PER_PAGE) break;
    page++;
  }
  
  // Handle deletions (optional)
  if (!SKIP_DELETES && hasSoftDelete) {
    // Soft delete logic would go here if needed
    console.log("ℹ️  Soft delete support detected but not implemented in this version");
  }
  
  const endedAt = new Date();
  const duration = ((endedAt - startedAt) / 1000).toFixed(1);
  
  console.log(JSON.stringify({
    status: "ok",
    upserted: totalUpserted,
    pages: page - 1,
    duration_sec: parseFloat(duration),
    max_seen_updated_at: maxSeenUpdatedAt,
  }));
  
  console.log("✅ ingest ok");
}

// ============================================================================
// ERROR HANDLING & ALERTING
// ============================================================================

main().catch(async (err) => {
  console.error(`❌ INGEST FAILED: ${err.message}`);
  console.error(err.stack);
  
  // Send alert if webhook configured
  if (ALERT_WEBHOOK_URL) {
    try {
      await fetch(ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "ingest",
          message: "iNaturalist ingest failed",
          lastError: err.message,
        }),
      });
    } catch {
      // Ignore alert failures
    }
  }
  
  process.exit(1);
});
