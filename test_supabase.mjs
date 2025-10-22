import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('ERROR: Missing required environment variables:');
  console.error('  SUPABASE_URL:', supabaseUrl ? 'Set' : 'MISSING');
  console.error('  SUPABASE_ANON_KEY:', supabaseAnonKey ? 'Set' : 'MISSING');
  process.exit(1);
}

console.log('Creating Supabase client...');
console.log('  URL:', supabaseUrl);
console.log('  Key:', supabaseAnonKey.substring(0, 20) + '...');

const supabase = createClient(supabaseUrl, supabaseAnonKey);

console.log('\nTesting connection to spider_trip_windows_v1 table...');

const { data, error } = await supabase
  .from('spider_trip_windows_v1')
  .select('*')
  .limit(1);

if (error) {
  console.error('\nERROR:');
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
}

console.log('\nSUCCESS! Data retrieved:');
console.log(JSON.stringify(data, null, 2));
