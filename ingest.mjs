import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INAT_PROJECT_SLUG = process.env.INAT_PROJECT_SLUG;

// Minimal check for essential variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Error: Missing Supabase environment variables.');
  process.exit(1);
}

const dbClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const INAT_API_BASE = 'https://api.inaturalist.org/v1';

async function getMostRecentUpdateTime() {
  const { data, error } = await dbClient
    .from('job_metadata')
    .select('last_inat_update_utc')
    .eq('job_name', 'ingest')
    .single();

  if (error && error.code !== 'PGRST116') {
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
  const per_page = 200;

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
    
    const response = await fetch(url); // No special headers, as per the working version

    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`iNaturalist API error: ${response.status} ${response.statusText}`);
        console.error(`Error details: ${errorBody}`);
        throw new Error(`iNaturalist API request failed with status ${response.status}`);
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

    const BATCH_SIZE = 500;
    for (let i = 0; i < observations.length; i += BATCH_SIZE) {
        const batch = observations.slice(i, i + BATCH_SIZE).map(transformObservation);
        console.log(`Upserting batch ${Math.floor(i / BATCH_SIZE) + 1}...`);
        const { error } = await dbClient
        .from('observations')
        .upsert(batch, { onConflict: 'inat_obs_id' });

        if (error) {
        console.error('Error upserting batch:', error);
        }
    }
}

async function main() {
  const startTime = new Date().toISOString();
  console.log(`Ingest script started at ${startTime}`);
  
  const lastUpdate = await getMostRecentUpdateTime();
  console.log(lastUpdate ? `Fetching updates since ${lastUpdate}` : 'Performing initial full sync.');

  const observations = await fetchObservations(lastUpdate);
  await upsertObservations(observations);

  await updateLastUpdateTime(startTime);
  
  console.log('Ingest script finished successfully.');
}

main().catch(error => {
    console.error("Critical error in main execution:", error);
    process.exit(1);
});
