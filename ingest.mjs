// ingest.mjs — multi-assignment ingest + scoring (with iconic_taxon_name)

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INAT = process.env.INAT_BASE || "https://api.inaturalist.org/v1";
const RPS  = Number(process.env.RATE_LIMIT_RPS || 1);

// Comma/space/newline separated list of assignment ids
const ASSIGN_IDS = (process.env.ASSIGNMENT_IDS || process.env.ASSIGNMENT_ID || "")
  .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

if (!SB_URL || !SB_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
if (!ASSIGN_IDS.length) throw new Error("No ASSIGNMENT_IDS/ASSIGNMENT_ID provided.");

const PGR = `${SB_URL}/rest/v1`;
const HDR = {
  "Authorization": `Bearer ${SB_KEY}`,
  "apikey": SB_KEY,
  "Content-Type": "application/json",
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const throttleMs = Math.ceil(1000 / Math.max(1, RPS));

async function http(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers },
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}\n${json?.message || text}`);
  return { json, text, headers: Object.fromEntries(res.headers) };
}

const toUTC = (iso) => iso ? new Date(iso).toISOString() : null;
const round  = (n, d = 2) => n == null ? null : Number(n.toFixed(d));

function localDayCR(iso) {
  // 2am boundary (8h behind UTC ≈ Costa Rica in Nov)
  const t = new Date(iso);
  if (isNaN(t)) return null;
  return new Date(t.getTime() - 8 * 3600e3).toISOString().slice(0, 10);
}

function isSL(r) { return ["species", "subspecies", "variety", "form"].includes(r || ""); }
const ln1 = (x) => Math.log((x || 0) + 1);

// ---------- Assignment & identities ----------
async function readAssignment(aid) {
  // assignment + rubric
  const { json: as } = await http(
    "GET",
    `${PGR}/assignments?select=*,rubric:rubric_id(*)&id=eq.${aid}`,
    null, HDR
  );
  if (!as?.length) {
    const { json: recent } = await http(
      "GET",
      `${PGR}/assignments?select=id,name,created_at&order=created_at.desc&limit=5`,
      null, HDR
    );
    const snap = (recent || []).map(r => `${r.name} => ${r.id}`).join(" | ") || "none";
    throw new Error(`Assignment not found for '${aid}'. Recent: ${snap}`);
  }
  const a = as[0];

  const d1 = new Date(a.start_utc).toISOString().slice(0, 10);
  const d2 = new Date(a.end_utc).toISOString().slice(0, 10);

  // student identities (inat)
  const { json: ids } = await http(
    "GET",
    `${PGR}/student_identities?provider=eq.inat&select=student_id,external_id,external_username`,
    null, HDR
  );

  // last inat_updated_through_utc (for incremental)
  const { json: lastRuns } = await http(
    "GET",
    `${PGR}/score_runs?select=inat_updated_through_utc&assignment_id=eq.${aid}&order=as_of_utc.desc&limit=1`,
    null, HDR
  );
  const updatedSince = lastRuns?.[0]?.inat_updated_through_utc || null;

  return { a, d1, d2, ids: ids || [], updatedSince };
}

// ---------- iNat fetch ----------
async function* inatObsPager(params) {
  let page = 1;
  while (true) {
    const q = new URLSearchParams({
      per_page: "200",
      page: String(page),
      order: "asc",
      order_by: "updated_at",
      ...params
    });
    try {
      const { json } = await http("GET", `${INAT}/observations?${q}`, null, {});
      const rows = json?.results || [];
      if (!rows.length) break;
      yield rows;
      page++;
      await sleep(throttleMs);
    } catch (e) {
      if (String(e).includes("429")) { await sleep(1500 + Math.random() * 1000); continue; }
      throw e;
    }
  }
}

// map iNat -> observations row
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
    iconic_taxon_name: o.taxon?.iconic_taxon_name ?? null,

    quality_grade: o.quality_grade ?? null,
    species_guess: o.species_guess ?? null,

    latitude:  o.geojson?.coordinates ? o.geojson.coordinates[1] :
               (o.location ? Number(String(o.location).split(",")[0]) : null),
    longitude: o.geojson?.coordinates ? o.geojson.coordinates[0] :
               (o.location ? Number(String(o.location).split(",")[1]) : null),

    project_ids: Array.isArray(o.project_ids) ? o.project_ids : [],
    raw_json: o
  };
}

// novelty bucketing
function noveltyKey(rubric, obs) {
  const nb = rubric?.novelty_bonus || {};
  if (!nb.enabled) return null;

  const rankOk = ["species","subspecies","variety","form"].includes(obs.taxon_rank || "");
  const qualOk = (nb.require_quality || ["needs_id","research"]).includes(obs.quality_grade || "");
  if (!(rankOk && qualOk)) return null;

  const latb = round(obs.latitude,  nb.geo_round_decimals ?? 2);
  const lonb = round(obs.longitude, nb.geo_round_decimals ?? 2);
  if (latb == null || lonb == null) return null;

  const hrs = nb.time_bucket_hours ?? 6;
  const t = new Date(obs.observed_at_utc || obs.created_at_utc || obs.updated_at_utc);
  if (isNaN(t)) return null;
  const bucket = new Date(Math.floor(t.getTime() / (hrs * 3600e3)) * (hrs * 3600e3)).toISOString();
  return `${obs.taxon_id}|${latb},${lonb}|${bucket}`;
}

async function upsert(table, rows, onConflict) {
  if (!rows.length) return;
  const CH = 200;
  for (let i = 0; i < rows.length; i += CH) {
    await http(
      "POST",
      `${PGR}/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      rows.slice(i, i + CH),
      HDR
    );
    await sleep(80);
  }
}

function mapLinks(assignmentId, idsMap, rubric, mapped) {
  return mapped.map(o => {
    const byId    = idsMap.id.get(String(o.user_id));
    const byLogin = idsMap.login.get(String((o.user_login || "").toLowerCase()));
    return {
      assignment_id: assignmentId,
      inat_obs_id: o.inat_obs_id,
      student_id: byId || byLogin || null,
      included: true,
      novelty_key: noveltyKey(rubric, o)
    };
  });
}

async function rankNovelty(assignmentId) {
  await http("POST", `${PGR}/rpc/rank_novelty_for_assignment`, { p_assignment: assignmentId }, HDR);
}

// ---------- Scoring ----------
function scoreAll(rows, rubric) {
  const rankPts   = rubric?.novelty_bonus?.rank_points || [5, 3, 2, 1, 1, 0.5];
  const afterPts  = rubric?.novelty_bonus?.after_points ?? 0.2;
  const dupWindow = (rubric?.duplicates?.window_hours ?? 1) * 3600e3;
  const dupPenalty = rubric?.duplicates?.penalty_each ?? 1;

  const per = new Map(), out = new Map();

  for (const r of rows) {
    if (!r.student_id) continue;
    const o = r.observations || {};
    let st = per.get(r.student_id);
    if (!st) { st = { obs: [], nov: 0, dup: 0 }; per.set(r.student_id, st); }
    st.obs.push(o);
    if (r.novelty_rank != null) {
      const idx = Math.max(1, Number(r.novelty_rank));
      st.nov += (rankPts[idx - 1] ?? afterPts);
    }
  }

  for (const [sid, st] of per) {
    const obs = st.obs.filter(o => o.observed_at_utc)
                      .sort((a, b) => a.observed_at_utc.localeCompare(b.observed_at_utc));
    let dup = 0;
    for (let i = 1; i < obs.length; i++) {
      const a = obs[i - 1], b = obs[i];
      if (a.taxon_id && b.taxon_id && a.taxon_id === b.taxon_id) {
        const ta = new Date(a.observed_at_utc).getTime();
        const tb = new Date(b.observed_at_utc).getTime();
        const timeClose = (tb - ta) <= dupWindow;
        const la = Number(a.latitude?.toFixed?.(2)), lb = Number(b.latitude?.toFixed?.(2));
        const loa = Number(a.longitude?.toFixed?.(2)), lob = Number(b.longitude?.toFixed?.(2));
        const whereClose = [la, lb, loa, lob].every(Number.isFinite) && la === lb && loa === lob;
        if (timeClose && whereClose) dup++;
      }
    }
    st.dup = dup;
  }

  for (const [sid, st] of per) {
    const O  = st.obs.length;
    const U  = new Set(st.obs.map(o => o.taxon_id).filter(Boolean)).size;
    const RG = st.obs.filter(o => o.quality_grade === "research").length;
    const SL = st.obs.filter(o => isSL(o.taxon_rank)).length;
    const D  = new Set(st.obs.map(o => localDayCR(o.observed_at_utc)).filter(Boolean)).size;

    const s  = rubric?.scoring || {};
    const total =
      (s.volume_ln_k ?? 6) * ln1(O) +
      (s.unique_ln_k ?? 7) * ln1(U) +
      (s.research_grade_each ?? 1.5) * RG +
      (s.species_or_lower_each ?? 0.5) * SL +
      (s.day_participation_each ?? 3) * D +
      st.nov -
      st.dup * (dupPenalty);

    out.set(sid, {
      O, U, RG, SL, D,
      novelty_sum: st.nov,
      duplicates: st.dup,
      rarity_sum: 0,
      assists_count: 0,
      assists_score: 0,
      total_points: Number(total.toFixed(2))
    });
  }
  return out;
}

async function loadJoined(aid) {
  const { json } = await http(
    "GET",
    `${PGR}/assignment_observations?assignment_id=eq.${aid}&included=is.true&select=*,observations(*)`,
    null, HDR
  );
  return json || [];
}

async function writeScores(aid, byStudent, maxUpdated) {
  const runRow = [{
    assignment_id: aid,
    as_of_utc: new Date().toISOString(),
    inat_updated_through_utc: maxUpdated || new Date().toISOString(),
    observations_fetched: 0,
    notes: "GH Action basic scoring"
  }];

  const { json } = await http("POST", `${PGR}/score_runs?on_conflict=id`, runRow, HDR);
  const runId = json?.[0]?.id;
  if (!runId) throw new Error("score_run insert failed");

  const entries = [];
  for (const [sid, m] of byStudent) {
    entries.push({
      score_run_id: runId,
      assignment_id: aid,
      student_id: sid,
      total_points: m.total_points,
      breakdown_json: m
    });
  }
  if (entries.length) await upsert("score_entries", entries, "id");
  console.log(`→ Scored assignment ${aid}: run ${runId} with ${entries.length} entries.`);
}

// ---------- One assignment end-to-end ----------
async function runOne(aid) {
  console.log(`\n→ Looking for assignment '${aid}'`);
  const { a, d1, d2, ids, updatedSince } = await readAssignment(aid);
  const rubric = a.rubric?.json || a.rubric;

  const idsMap = { id: new Map(), login: new Map() };
  for (const r of ids) {
    if (r.external_id != null) idsMap.id.set(String(r.external_id), r.student_id);
    if (r.external_username) idsMap.login.set(r.external_username.toLowerCase(), r.student_id);
  }
  const userLogins = Array.from(idsMap.login.keys());
  if (!userLogins.length) {
    console.warn("  ! No iNat usernames in student_identities; skipping ingest for this assignment.");
    return;
  }

  const params = {
    user_id: userLogins.join(","),
    d1, d2
  };
  if (updatedSince) params.updated_since = new Date(updatedSince).toISOString();

  let totalFetched = 0, maxUpdated = null;

  for await (const page of inatObsPager(params)) {
    const mapped = page.map(mapObs);
    totalFetched += mapped.length;
    for (const m of mapped) {
      if (m.updated_at_utc && (!maxUpdated || m.updated_at_utc > maxUpdated)) maxUpdated = m.updated_at_utc;
    }
    await upsert("observations", mapped, "inat_obs_id");
    await upsert("assignment_observations", mapLinks(aid, idsMap, rubric, mapped), "(assignment_id,inat_obs_id)");
    await sleep(throttleMs);
  }

  console.log(`  • Fetched ${totalFetched} observations${updatedSince ? ` (since ${updatedSince})` : ""}.`);

  await rankNovelty(aid);

  const joined = await loadJoined(aid);
  const scored = scoreAll(joined, rubric);
  await writeScores(aid, scored, maxUpdated);
  console.log(`✓ Done: ${aid}`);
}

// ---------- Orchestrate all ----------
(async () => {
  try {
    for (const aid of ASSIGN_IDS) {
      try { await runOne(aid); }
      catch (e) { console.error(`✗ ${aid}: ${String(e)}`); }
      await sleep(200);
    }
    console.log("OK");
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }
})();
