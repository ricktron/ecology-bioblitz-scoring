import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const BATCH_SIZE = 500;
const INAT_API_BASE = 'https://api.inaturalist.org/v1';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INAT_PROJECT_SLUG = process.env.INAT_PROJECT_SLUG;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !INAT_PROJECT_SLUG) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

const dbClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function getMostRecentUpdateTime() {
  const { data, error } = await dbClient
    .from('job_metadata')
    .select('last_inat_update_utc')
    .eq('job_name', 'ingest')
    .single();

  if (error && error.code !== 'PGRST116') { // Ignore "Row not found"
    console.error('Error fetching last update time:', error);
    return null;
  }
  return data?.last_inat_update_utc;
}

async function updateLastUpdateTime(timestamp) {
  const { error } = await dbClient
    .from('job_metadata')
    .upsert({ job_name: 'ingest', last_inat_update_utc: timestamp }, { onConflict: 'job_name' });

  if (error) {
    console.error('Error updating last update time:', error);
  }
}

async function fetchObservations(updatedSince) {
  let allObservations = [];
  let page = 1;
  const per_page = 200; // Max allowed by iNat API

  while (true) {
    const params = new URLSearchParams({
      project_id: INAT_PROJECT_SLUG,
      per_page: per_page,
      page: page,
      order_by: 'updated_at',
      order: 'asc'
    });
    if (updatedSince) {
      params.append('updated_since', updatedSince);
    }

    const url = `${INAT_API_BASE}/observations?${params.toString()}`;
    console.log(`Fetching page ${page} from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`iNaturalist API error: ${response.statusText}`);
      break;
    }

    const data = await response.json();
    if (data.results.length === 0) {
      break;
    }

    allObservations.push(...data.results);
    page++;
  }
  return allObservations;
}

function transformObservation(obs) {
  return {
    inat_obs_id: obs.id,
    user_id: obs.user.id,
    user_login: obs.user.login,
    observed_at_utc: obs.observed_on_string,
    created_at_utc: obs.created_at,
    updated_at_utc: obs.updated_at,
    quality_grade: obs.quality_grade,
    species_guess: obs.species_guess,
    taxon_id: obs.taxon?.id,
    taxon_rank: obs.taxon?.rank,
    latitude: obs.location?.split(',')[0],
    longitude: obs.location?.split(',')[1],
    project_ids: obs.project_ids,
    raw_json: obs
  };
}

async function upsertObservations(observations) {
  if (observations.length === 0) {
    console.log("No new observations to upsert.");
    return;
  }

  for (let i = 0; i < observations.length; i += BATCH_SIZE) {
    const batch = observations.slice(i, i + BATCH_SIZE).map(transformObservation);
    console.log(`Upserting batch ${i / BATCH_SIZE + 1}...`);
    const { error } = await dbClient
      .from('observations')
      .upsert(batch, { onConflict: 'inat_obs_id' });

    if (error) {
      console.error('Error upserting batch:', error);
    }
  }
}

// --- NEW FUNCTION ---
async function handleDeletions(since) {
    if (!since) {
        console.log("Skipping deletion check on initial run.");
        return;
    }

    const params = new URLSearchParams({
        since: since
    });
    const url = `${INAT_API_BASE}/observation_deletions?${params.toString()}`;
    console.log(`Checking for deletions from: ${url}`);
    
    const response = await fetch(url);
    if (!response.ok) {
        console.error(`iNaturalist Deletions API error: ${response.statusText}`);
        return;
    }

    const data = await response.json();
    const deletedIds = data.results.map(del => del.observation_id);

    if (deletedIds.length === 0) {
        console.log("No deletions to process.");
        return;
    }

    console.log(`Found ${deletedIds.length} deleted observations. Removing from database...`);

    // We can rely on ON DELETE CASCADE for assignment_observations, so we only need to delete from the parent 'observations' table.
    const { error } = await dbClient
        .from('observations')
        .delete()
        .in('inat_obs_id', deletedIds);

    if (error) {
        console.error('Error deleting observations:', error);
    } else {
        console.log(`Successfully removed ${deletedIds.length} observations.`);
    }
}


async function main() {
  const startTime = new Date().toISOString();
  console.log(`Ingest script started at ${startTime}`);
  
  const lastUpdate = await getMostRecentUpdateTime();
  console.log(lastUpdate ? `Fetching updates since ${lastUpdate}` : 'Performing initial full sync.');

  // --- MODIFIED ORDER ---
  // 1. Handle Deletions first
  await handleDeletions(lastUpdate);

  // 2. Fetch and Upsert new/updated observations
  const observations = await fetchObservations(lastUpdate);
  await upsertObservations(observations);

  // 3. Update the timestamp to the start time of this run
  await updateLastUpdateTime(startTime);
  
  console.log('Ingest script finished.');
}

main().catch(console.error);
