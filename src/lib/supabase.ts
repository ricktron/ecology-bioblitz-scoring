/**
 * Supabase Client Adapter
 *
 * Centralizes Supabase client creation with proper error handling.
 * Always uses the anon key for app-level operations.
 * RLS policies enforce security at the database level.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Environment variables (required)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Validation
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing required environment variables: SUPABASE_URL and/or SUPABASE_ANON_KEY'
  );
}

// Validate URL format
try {
  new URL(SUPABASE_URL);
} catch (err) {
  throw new Error(`Invalid SUPABASE_URL format: ${SUPABASE_URL}`);
}

/**
 * Singleton Supabase client instance
 *
 * Usage:
 *   import { supabase } from './lib/supabase';
 *   const { data, error } = await supabase.from('table_name').select('*');
 */
export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

/**
 * Helper: Get current authenticated user
 *
 * @returns User object or null if not authenticated
 */
export async function getCurrentUser() {
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error) {
    console.error('Error fetching current user:', error.message);
    return null;
  }

  return user;
}

/**
 * Helper: Safe upsert user login (calls DB function)
 *
 * @param userId - UUID of the user
 * @param email - User email (optional)
 * @param provider - Auth provider (optional)
 * @returns User login record or error
 */
export async function safeUpsertUserLogin(
  userId: string,
  email?: string,
  provider?: string
) {
  const { data, error } = await supabase.rpc('safe_upsert_user_login', {
    p_user_id: userId,
    p_email: email,
    p_provider: provider,
  });

  if (error) {
    console.error('Error upserting user login:', error.message);
    return { data: null, error };
  }

  return { data, error: null };
}

/**
 * Helper: Refresh leaderboards (calls DB function)
 *
 * @returns Success status
 */
export async function refreshLeaderboards() {
  const { error } = await supabase.rpc('refresh_leaderboards_v1');

  if (error) {
    console.error('Error refreshing leaderboards:', error.message);
    return { success: false, error };
  }

  return { success: true, error: null };
}

/**
 * Helper: Run security and performance checks (calls DB function)
 *
 * @returns Array of issues (empty if all checks pass)
 */
export async function assertSecurityAndPerfOk() {
  const { data, error } = await supabase.rpc('assert_security_and_perf_ok');

  if (error) {
    console.error('Error running security checks:', error.message);
    return { issues: null, error };
  }

  return { issues: data || [], error: null };
}
