// ingest.mjs — Multi-assignment ingest + link + novelty + basic scoring

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PGR    = `${SB_URL}/rest/v1`;
const INAT   = process.env.INAT_BASE || "https://api.inaturalist.org/v1";
const RPS    = Number(process.env.RATE_LIMIT_RPS || 1);

const HDR = {
  Authorization: `Bearer ${SB_KEY}`,
  apikey: SB_KEY,
  "Content-Type": "application/json",
};

// Parse one-or-many assignment IDs from ASSIGNMENT_IDS or ASSIGNMENT_ID
const ASSIGNMENTS = (() => {
  const raw = `${process.env.ASSIGNMENT_IDS || ""},${process.env.ASSIGNMENT_ID || ""}`;
  const uuids = [...raw.matchAll(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g)]
    .map(m => m[0]);
  return Array.from(new Set(uuids));
})();

if (!ASSIGNMENTS.length) {
  throw new Error("No ASSIGNMENT_IDS/ASSIGNMENT_ID provided.");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const throttleMs = Math.ceil(1000 / Math.max(1, RPS));

async function http(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers },
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}\n${json?.message || text}`);
  return { json, text, headers: Object.fromEntries(res.headers) };
}

const toUTC = (iso) => (iso ? new Date(iso).toISOString() : null);

/* Assignment loader (id only; schema-agnostic fallback via list+match) */
async function readAssignment(assignmentId) {
  console.log(`→ Looking for assignment '${assignmentId}'`);
  const base = `${PGR}/assignments`;
  const sel  = "*,rubric:rubric_id(*)";

  // try direct by id
  const qp = new URLSearchParams({ select: sel });
  qp.append("id", `eq.${assignmentId}`);
  try {
    const { json } = await http("GET", `${base}?${qp.toString()}`, null, HDR);
    if (Array.isArray(json) && json.length) {
      return await hydrate(json[0]);
    }
  } catch (e) {
    console.warn("id lookup failed, will list+match:", String(e));
  }

  // fallback: list a few recent and match on client
  const { json: list } = await http(
    "GET",
    `${base}?select=id,name,created_at,start_utc,end_utc,assignment_tz,project_slug,rubric:rubric_id(*)&order=created_at.desc&limit=20`,
    null, HDR
  );
  const found = (Array.isArray(list) ? list : []).find(r => String(r.id) === assignmentId);
  if (!found) {
    const snap = (list || []).map(r => `${r.name} => ${r.id}`).join(" | ") || "none";
    throw new Error(`Assignment not found for '${assignmentId}'. Recent: ${snap}`);
  }
  return await hydrate(found);

  async function hydrate(a) {
    const d1 = new Date(a.start_utc).toISOString().slice(0,10);
    const d2 = new Date(a.end_utc).toISOString().slice(0,10);
    const { json: ids } = await http(
      "GET",
      `${PGR}/student_identities?provider=eq.inat&select=student_id,external_id,external_username`,
      null, HDR
    );
    return { a, d1, d2, ids: ids || [] };
  }
}

/* iNat fetch */
async function* inatObsPager(params) {
  let page = 1;
  for (;;) {
    const q = new URLSearchParams({ per_page: "200", page: String(page), order: "asc", order_by: "updated_at", ...params });
    try {
      const { json } = await http("GET", `${INAT}/observations?${q}`, null, {});
      const rows = json?.results || [];
      if (!rows.length) break;
      yield rows;
      page++; await sleep(throttleMs);
    } catch (e) {
      if (String(e).includes("429")) { await sleep(1500 + Math.random()*1000); continue; }
      throw e;
    }
  }
}

function mapObs(o) {
  let observed_at_utc = toUTC(o.time_observed_at);
  if (!observed_at_utc && o.observed_on) observed_at_utc = toUTC(`${o.observed_on}T18:00:00Z`);
  return {
    inat_obs_id: o.id,
    user_id: o.user?.id,
    user_login: o.user?.login,
    observed_at_utc,
    updated_at_utc: toUTC(o.updated_at),
    created_at_utc: toUTC(o.created_at),
    taxon_id: o.taxon?.id ?? null,
    taxon_rank: o.taxon?.rank ?? null,
    quality_grade: o.quality_grade ?? null,
    species_guess: o.species_guess ?? null,
    latitude: o.geojson?.coordinates ? o.geojson.coordinates[1]
            : o.location ? Number(String(o.location).split(",")[0]) : null,
    longitude: o.geojson?.coordinates ? o.geojson.coordinates[0]
             : o.location ? Number(String(o.location).split(",")[1]) : null,
    project_ids: Array.isArray(o.project_ids) ? o.project_ids : [],
    raw_json: o,
  };
}

async function upsert(table, rows, onConflict) {
  if (!rows.length) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await http("POST", `${PGR}/${table}?on_conflict=${encodeURIComponent(onConflict)}`, rows.slice(i, i + CHUNK), HDR);
    await sleep(100);
  }
}

const round = (n, d=2) => (n == null ? null : Number(n.toFixed(d)));

function noveltyKey(rubric, obs) {
  const nb = rubric?.novelty_bonus || {};
  if (!nb.enabled) return null;
  const rankOk = ["species","subspecies","variety","form"].includes(obs.taxon_rank || "");
  const qualOk = (nb.require_quality || ["needs_id","research"]).includes(obs.quality_grade || "");
  if (!(rankOk && qualOk)) return null;

  const latb = round(obs.latitude, nb.geo_round_decimals ?? 2);
  const lonb = round(obs.longitude, nb.geo_round_decimals ?? 2);
  if (latb == null || lonb == null) return null;

  const hrs = nb.time_bucket_hours ?? 6;
  const t = new Date(obs.observed_at_utc || obs.created_at_utc || obs.updated_at_utc);
  if (isNaN(t)) return null;
  const bucket = new Date(Math.floor(t.getTime()/(hrs*3600e3))*(hrs*3600e3)).toISOString();

  return `${obs.taxon_id}|${latb},${lonb}|${bucket}`;
}

function mapLinks(assignmentId, idsMap, rubric, mapped) {
  return mapped.map(o => {
    const byId   = idsMap.id.get(String(o.user_id));
    const byUser = idsMap.login.get(String((o.user_login || "").toLowerCase()));
    return {
      assignment_id: assignmentId,
      inat_obs_id: o.inat_obs_id,
      student_id: byId || byUser || null,
      included: true,
      novelty_key: noveltyKey(rubric, o),
    };
  });
}

async function rankNovelty(assignmentId) {
  await http("POST", `${PGR}/rpc/rank_novelty_for_assignment`, { p_assignment: assignmentId }, HDR);
}

/* CR day helper for scoring */
const isSL = (r) => ["species","subspecies","variety","form"].includes(r || "");
const ln1  = (x) => Math.log((x || 0) + 1);
function localDayCR(iso) {
  const t = new Date(iso); if (isNaN(t)) return null;
  return new Date(t.getTime() - 8*3600e3).toISOString().slice(0,10); // 02:00 CR reset
}

async function loadJoined(assignmentId) {
  const { json } = await http(
    "GET",
    `${PGR}/assignment_observations?assignment_id=eq.${assignmentId}&included=is.true&select=*,observations(*)`,
    null, HDR
  );
  return json || [];
}

function scoreAll(rows, rubric) {
  const rankPts     = rubric?.novelty_bonus?.rank_points || [5,3,2,1,1,0.5];
  const afterPts    = rubric?.novelty_bonus?.after_points ?? 0.2;
  const dupWindowMs = (rubric?.duplicates?.window_hours ?? 1) * 3600e3;
  const dupPenalty  = rubric?.duplicates?.penalty_each ?? 1;

  const perStudent = new Map(), byStudent = new Map();

  for (const r of rows) {
    if (!r.student_id) continue;
    const o = r.observations || {};
    let st = perStudent.get(r.student_id);
    if (!st) { st = { obs: [], noveltySum: 0, dupCount: 0 }; perStudent.set(r.student_id, st); }
    st.obs.push(o);
    if (r.novelty_rank != null) {
      const idx = Math.max(1, Number(r.novelty_rank));
      st.noveltySum += (rankPts[idx-1] ?? afterPts);
    }
  }

  const round2 = n => (n == null ? null : Number(n.toFixed(2)));

  for (const [sid, st] of perStudent) {
    const obs = st.obs.filter(o => o.observed_at_utc).sort((a,b)=>a.observed_at_utc.localeCompare(b.observed_at_utc));
    let dup = 0;
    for (let i=1;i<obs.length;i++) {
      const a = obs[i-1], b = obs[i];
      if (a.taxon_id && b.taxon_id && a.taxon_id === b.taxon_id) {
        const ta = new Date(a.observed_at_utc).getTime();
        const tb = new Date(b.observed_at_utc).getTime();
        const timeClose = (tb - ta) <= dupWindowMs;
        const la = Number(a.latitude?.toFixed?.(2)), lb = Number(b.latitude?.toFixed?.(2));
        const loa = Number(a.longitude?.toFixed?.(2)), lob = Number(b.longitude?.toFixed?.(2));
        const whereClose = [la,lb,loa,lob].every(Number.isFinite) && la===lb && loa===lob;
        if (timeClose && whereClose) dup++;
      }
    }
    st.dupCount = dup;
  }

  for (const [sid, st] of perStudent) {
    const O  = st.obs.length;
    const U  = new Set(st.obs.map(o=>o.taxon_id).filter(Boolean)).size;
    const RG = st.obs.filter(o=>o.quality_grade==='research').length;
    const SL = st.obs.filter(o=>isSL(o.taxon_rank)).length;
    const Dset = new Set(st.obs.map(o=>localDayCR(o.observed_at_utc)).filter(Boolean)); const D = Dset.size;

    const s = rubric?.scoring || {};
    const total =
      (s.volume_ln_k ?? 6) * ln1(O) +
      (s.unique_ln_k ?? 7) * ln1(U) +
      (s.research_grade_each ?? 1.5) * RG +
      (s.species_or_lower_each ?? 0.5) * SL +
      (s.day_participation_each ?? 3) * D +
      st.noveltySum -
      st.dupCount * (dupPenalty);

    byStudent.set(sid, {
      O,U,RG,SL,D,
      novelty_sum: st.noveltySum,
      duplicates: st.dupCount,
      rarity_sum: 0,
      assists_count: 0,
      assists_score: 0,
      total_points: round2(total),
    });
  }

  return byStudent;
}

async function writeScores(assignmentId, byStudent, maxUpdated) {
  const run = [{
    assignment_id: assignmentId,
    as_of_utc: new Date().toISOString(),
    inat_updated_through_utc: maxUpdated || new Date().toISOString(),
    observations_fetched: 0,
    notes: "GH Action basic scoring (no rarity/assists)"
  }];

  // Ask PostgREST to return the inserted row so we get the id
  const { json } = await http(
    "POST",
    `${PGR}/score_runs`,            // no need for on_conflict here
    run,
    { ...HDR, Prefer: "return=representation" }
  );

  const runId = Array.isArray(json) ? json[0]?.id : null;
  if (!runId) throw new Error("score_run insert failed");

  const entries = [];
  for (const [sid, m] of byStudent) {
    entries.push({
      score_run_id: runId,
      assignment_id: assignmentId,
      student_id: sid,
      total_points: m.total_points,
      breakdown_json: m,
    });
  }
  if (entries.length) await upsert("score_entries", entries, "id");
  console.log(`✓ ${assignmentId}: score run ${runId} with ${entries.length} entries.`);
}


/* Ingest (per assignment) */
async function ingest(assignmentId) {
  const { a, d1, d2, ids } = await readAssignment(assignmentId);
  const rubric = a.rubric?.json || a.rubric;

  const idsMap = { id:new Map(), login:new Map() };
  for (const r of ids) {
    if (r.external_id != null) idsMap.id.set(String(r.external_id), r.student_id);
    if (r.external_username) idsMap.login.set(String(r.external_username).toLowerCase(), r.student_id);
  }
  const userLogins = Array.from(idsMap.login.keys());
  if (!userLogins.length) throw new Error("No iNat usernames in student_identities");

  // Per-assignment filters
  const params = { user_id: userLogins.join(","), d1, d2 };
  if (a.project_slug) params.project_slug = a.project_slug; // optional, if you use it

  let totalFetched = 0, maxUpdated = null;

  for await (const page of inatObsPager(params)) {
    const mapped = page.map(mapObs);
    totalFetched += mapped.length;
    for (const m of mapped) {
      if (m.updated_at_utc && (!maxUpdated || m.updated_at_utc > maxUpdated)) maxUpdated = m.updated_at_utc;
    }
    await upsert("observations", mapped, "inat_obs_id");
    await upsert("assignment_observations", mapLinks(assignmentId, idsMap, rubric, mapped), "(assignment_id,inat_obs_id)");
    await sleep(throttleMs);
  }

  await rankNovelty(assignmentId);
  return { rubric, maxUpdated, totalFetched };
}

/* MAIN: process all assignments, keep going even if one fails */
(async () => {
  let ok = 0;
  for (const assignmentId of ASSIGNMENTS) {
    try {
      const stats = await ingest(assignmentId);
      const rows  = await loadJoined(assignmentId);
      const byStu = scoreAll(rows, stats.rubric);
      await writeScores(assignmentId, byStu, stats.maxUpdated);
      ok++;
    } catch (e) {
      console.error(`✗ ${assignmentId}:`, String(e));
    }
  }
  if (!ok) process.exit(1);
  console.log(`Done. Successful assignments: ${ok}/${ASSIGNMENTS.length}`);
})();
