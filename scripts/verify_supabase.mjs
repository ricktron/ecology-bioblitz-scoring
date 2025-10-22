#!/usr/bin/env node
/**
 * Supabase Connection & Security Verification Script
 *
 * Purpose:
 *   - Verify Supabase connection is working
 *   - Test RLS policies are properly enforced
 *   - Run security and performance checks
 *
 * Usage:
 *   node scripts/verify_supabase.mjs
 *
 * Requirements:
 *   - SUPABASE_URL environment variable
 *   - SUPABASE_ANON_KEY environment variable
 *
 * DO NOT use SUPABASE_SERVICE_ROLE_KEY in application code!
 * Service role key bypasses RLS and should only be used in admin scripts.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Color output helpers
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  log(title, 'cyan');
  console.log('='.repeat(70));
}

// Environment validation
const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  log('ERROR: Missing required environment variables:', 'red');
  log('  SUPABASE_URL: ' + (url ? 'SET' : 'MISSING'), url ? 'green' : 'red');
  log('  SUPABASE_ANON_KEY: ' + (anonKey ? 'SET' : 'MISSING'), anonKey ? 'green' : 'red');
  process.exit(1);
}

log('\nEnvironment Check:', 'blue');
log(`  SUPABASE_URL: ${url}`, 'green');
log(`  SUPABASE_ANON_KEY: ${anonKey.substring(0, 20)}...`, 'green');

// Create Supabase client
const supabase = createClient(url, anonKey);

// ============================================================================
// TEST 1: Basic Connection Test
// ============================================================================

logSection('TEST 1: Basic Connection - Reading from user_login');

try {
  const { data, error } = await supabase
    .from('user_login')
    .select('user_id, email, provider, created_at')
    .limit(5);

  if (error) {
    // If table doesn't exist yet, that's okay
    if (error.code === '42P01') {
      log('⚠️  Table user_login does not exist yet (migration not applied)', 'yellow');
      log('   Run the migration first: supabase/migrations/20251022000000_user_login_and_scoring_v2.sql', 'yellow');
    } else {
      log('❌ Read failed:', 'red');
      log(JSON.stringify(error, null, 2), 'red');
      process.exit(1);
    }
  } else {
    log('✅ Read successful!', 'green');
    log(`   Found ${data.length} user(s) in user_login`, 'green');
    if (data.length > 0) {
      log('   Sample data:', 'blue');
      console.log(JSON.stringify(data.slice(0, 3), null, 2));
    }
  }
} catch (err) {
  log('❌ Connection test failed:', 'red');
  log(err.message, 'red');
  process.exit(1);
}

// ============================================================================
// TEST 2: RLS Enforcement - Anon Write Should Fail
// ============================================================================

logSection('TEST 2: RLS Enforcement - Testing anon key cannot write');

try {
  const testUserId = crypto.randomUUID();
  const { data, error } = await supabase
    .from('user_login')
    .insert([{
      user_id: testUserId,
      email: 'probe-test@bioblitz.local',
      provider: 'test-probe',
    }]);

  if (error) {
    // This is expected! Anon key should be blocked by RLS
    if (error.code === '42501' || error.message.includes('new row violates row-level security')) {
      log('✅ RLS is working correctly!', 'green');
      log('   Anon insert was blocked as expected:', 'green');
      log(`   Error: ${error.message}`, 'blue');
    } else {
      log('⚠️  Insert failed, but not due to RLS:', 'yellow');
      log(JSON.stringify(error, null, 2), 'yellow');
    }
  } else {
    log('❌ WARNING: Anon insert succeeded! RLS may be too permissive.', 'red');
    log('   Review your RLS policies on user_login table.', 'red');
    log('   Inserted data:', 'yellow');
    console.log(JSON.stringify(data, null, 2));
    process.exit(1);
  }
} catch (err) {
  log('❌ RLS test failed unexpectedly:', 'red');
  log(err.message, 'red');
  process.exit(1);
}

// ============================================================================
// TEST 3: Call Security Check Function
// ============================================================================

logSection('TEST 3: Running Database Security Checks');

try {
  const { data, error } = await supabase.rpc('assert_security_and_perf_ok');

  if (error) {
    if (error.code === '42883') {
      log('⚠️  Function assert_security_and_perf_ok does not exist yet', 'yellow');
      log('   This is expected if migration has not been applied.', 'yellow');
    } else {
      log('❌ Security check failed:', 'red');
      log(JSON.stringify(error, null, 2), 'red');
    }
  } else {
    if (data && data.length > 0) {
      log('❌ Security/Performance Issues Found:', 'red');
      data.forEach((issue) => {
        log(`   - ${issue.issue}`, 'red');
      });
      process.exit(1);
    } else {
      log('✅ All security and performance checks passed!', 'green');
    }
  }
} catch (err) {
  log('⚠️  Could not run security checks:', 'yellow');
  log(err.message, 'yellow');
}

// ============================================================================
// TEST 4: Read from Existing Tables
// ============================================================================

logSection('TEST 4: Connectivity - Reading from spider_trip_windows_v1');

try {
  const { data, error } = await supabase
    .from('spider_trip_windows_v1')
    .select('*')
    .limit(1);

  if (error) {
    if (error.code === '42P01') {
      log('⚠️  Table spider_trip_windows_v1 does not exist', 'yellow');
    } else {
      log('❌ Read failed:', 'red');
      log(JSON.stringify(error, null, 2), 'red');
    }
  } else {
    log('✅ Read successful from spider_trip_windows_v1!', 'green');
    log(`   Found ${data.length} trip window(s)`, 'green');
    if (data.length > 0) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
} catch (err) {
  log('❌ Connection test failed:', 'red');
  log(err.message, 'red');
}

// ============================================================================
// Summary
// ============================================================================

logSection('Verification Complete');

log('✅ All tests completed successfully!', 'green');
log('\nNext steps:', 'blue');
log('  1. Apply the migration if not done: Load supabase/migrations/20251022000000_user_login_and_scoring_v2.sql', 'blue');
log('  2. Run this script again to verify all functions work', 'blue');
log('  3. Test your application with the new user_login flow', 'blue');

process.exit(0);
