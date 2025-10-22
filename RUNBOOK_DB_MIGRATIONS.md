# Database Migration Runbook

This runbook provides step-by-step procedures for planning, applying, verifying, and rolling back database migrations safely.

## Table of Contents

1. [Overview](#overview)
2. [Migration Workflow](#migration-workflow)
3. [Planning a Migration](#planning-a-migration)
4. [Applying a Migration](#applying-a-migration)
5. [Verifying a Migration](#verifying-a-migration)
6. [Rolling Back a Migration](#rolling-back-a-migration)
7. [Emergency Procedures](#emergency-procedures)
8. [Best Practices](#best-practices)

---

## Overview

### Key Principles

- **Safety First**: All migrations must be idempotent (safe to run multiple times)
- **RLS Always On**: Row Level Security must be enabled on all tables
- **Test Before Apply**: Always test on dev/staging before production
- **Document Rollback**: Every migration must have a documented rollback path
- **No Service Role in App**: Only use anon key in application code

### Directory Structure

```
ecology-bioblitz-scoring/
├── supabase/
│   └── migrations/
│       ├── 20251022000000_user_login_and_scoring_v2.sql
│       └── ... (more migrations)
├── scripts/
│   └── verify_supabase.mjs
└── RUNBOOK_DB_MIGRATIONS.md (this file)
```

---

## Migration Workflow

### Standard Migration Process

```
┌─────────┐     ┌───────┐     ┌────────┐     ┌──────────┐
│  PLAN   │ --> │ APPLY │ --> │ VERIFY │ --> │ MONITOR  │
└─────────┘     └───────┘     └────────┘     └──────────┘
     │               │              │               │
     │               │              │               ▼
     │               │              │         ┌──────────┐
     │               │              └────────>│ ROLLBACK │
     │               │                        └──────────┘
     │               │
     ▼               ▼
 (Review)      (Backup First)
```

---

## Planning a Migration

### Step 1: Define Requirements

- [ ] Document what needs to change (table, column, index, function, etc.)
- [ ] Identify affected tables and views
- [ ] Assess impact on existing data
- [ ] Determine if this is a breaking change

### Step 2: Design the Migration

- [ ] Write SQL in `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
- [ ] Use `IF NOT EXISTS` / `IF EXISTS` for idempotency
- [ ] Add appropriate indexes for performance
- [ ] Enable RLS on new tables
- [ ] Write RLS policies
- [ ] Include backfill logic if needed

### Step 3: Plan Rollback Strategy

- [ ] Document rollback SQL (inverse operations)
- [ ] Test rollback on dev database
- [ ] Document data recovery process if needed
- [ ] Identify point of no return (e.g., DROP COLUMN)

### Step 4: Review Checklist

- [ ] Migration is idempotent
- [ ] RLS is enabled on all new tables
- [ ] No hardcoded secrets or environment-specific values
- [ ] Indexes added for performance
- [ ] Functions use `security definer` appropriately
- [ ] Rollback plan documented

---

## Applying a Migration

### Prerequisites

- [ ] Migration tested on local dev database
- [ ] Rollback plan documented
- [ ] Database backup created (production only)
- [ ] Team notified of maintenance window (if downtime expected)

### Step 1: Backup Database (Production)

**For Supabase hosted:**

1. Go to Supabase Dashboard → Database → Backups
2. Create a manual backup: "Before migration YYYYMMDD"
3. Wait for backup to complete
4. Download backup for local safety

**For self-hosted PostgreSQL:**

```bash
pg_dump -h <host> -U <user> -d <database> -F c -f backup_before_migration_$(date +%Y%m%d).dump
```

### Step 2: Apply Migration

**Option A: Via Supabase Dashboard (Recommended for hosted)**

1. Log into Supabase Dashboard
2. Navigate to SQL Editor
3. Copy contents of migration file
4. Paste into editor
5. Review SQL carefully
6. Click "Run"
7. Check for errors

**Option B: Via Supabase CLI**

```bash
# Install Supabase CLI if not already installed
npm install -g supabase

# Link to your project
supabase link --project-ref <your-project-ref>

# Apply migrations
supabase db push
```

**Option C: Via psql (direct connection)**

```bash
psql -h <host> -U postgres -d postgres -f supabase/migrations/20251022000000_user_login_and_scoring_v2.sql
```

### Step 3: Check for Errors

If migration fails:

1. **Read error message carefully**
2. **DO NOT panic** - most issues are fixable
3. **Check**: Does table/column already exist? (Usually safe to ignore)
4. **If syntax error**: Fix SQL and re-run
5. **If constraint violation**: Check existing data
6. **If serious error**: Proceed to rollback

---

## Verifying a Migration

### Step 1: Run Verification Script

```bash
# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"

# Run verification
node scripts/verify_supabase.mjs
```

**Expected output:**

```
✅ Read successful!
✅ RLS is working correctly!
✅ All security and performance checks passed!
```

### Step 2: Manual Verification Queries

Connect to your database and run:

```sql
-- Check table exists and has data
SELECT count(*) FROM public.user_login;

-- Check RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'user_login';
-- Should show rowsecurity = true

-- Check policies exist
SELECT policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'user_login';

-- Run security audit
SELECT * FROM public.assert_security_and_perf_ok();
-- Should return empty array if all checks pass

-- Check indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'user_login';
```

### Step 3: Test Application Functionality

- [ ] Test login flow (if auth-related)
- [ ] Test read operations
- [ ] Test write operations (should fail with anon key if RLS working)
- [ ] Test leaderboards refresh
- [ ] Check application logs for errors

### Step 4: Monitor Performance

- [ ] Check query performance (use Supabase Dashboard → Database → Query Performance)
- [ ] Monitor error rates
- [ ] Check database CPU/memory usage
- [ ] Verify slow query log (if any new slow queries appear)

---

## Rolling Back a Migration

### When to Rollback

- Migration caused application errors
- Data corruption detected
- Performance degradation
- Security issue discovered
- Business requirement changed

### Rollback Procedure

#### 1. **Assess Impact**

- How long has migration been live?
- How much data has been created/modified?
- Are there dependent changes in application code?

#### 2. **Prepare Rollback SQL**

**For the user_login migration, rollback would be:**

```sql
-- ROLLBACK: user_login_and_scoring_v2.sql
-- WARNING: This will drop the user_login table and all related objects

-- Drop trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Drop functions
DROP FUNCTION IF EXISTS public.handle_new_user();
DROP FUNCTION IF EXISTS public.safe_upsert_user_login(uuid, text, text);
DROP FUNCTION IF EXISTS public.refresh_leaderboards_v1();
DROP FUNCTION IF EXISTS public.assert_security_and_perf_ok();

-- Drop views
DROP VIEW IF EXISTS public.public_leaderboard_unified_v1;
DROP VIEW IF EXISTS public.daily_scoreboard_v2;

-- Drop table (THIS WILL DELETE ALL DATA)
DROP TABLE IF EXISTS public.user_login;

-- Drop indexes (if table not dropped)
DROP INDEX IF EXISTS public.user_login_email_key;
DROP INDEX IF EXISTS public.idx_user_login_provider;
DROP INDEX IF EXISTS public.idx_observations_observed_at;
DROP INDEX IF EXISTS public.idx_observations_user_login;
DROP INDEX IF EXISTS public.idx_daily_scores_roster_id;
```

#### 3. **Execute Rollback**

**IMPORTANT: Backup first!**

```bash
# Create a backup before rollback
pg_dump -h <host> -U <user> -d <database> -F c -f backup_before_rollback_$(date +%Y%m%d).dump

# Apply rollback SQL
psql -h <host> -U postgres -d postgres -f rollback.sql
```

#### 4. **Verify Rollback**

- [ ] Check that dropped objects are gone
- [ ] Application is functioning
- [ ] No orphaned data
- [ ] Errors cleared

#### 5. **Post-Rollback**

- [ ] Document what went wrong
- [ ] Fix migration SQL
- [ ] Re-test in dev/staging
- [ ] Plan re-application timeline

---

## Emergency Procedures

### Production Database is Down

1. **Check Supabase status**: https://status.supabase.com
2. **Check connection**: `pg_isready -h <host>`
3. **Review recent migrations**: Was a migration just applied?
4. **Check logs**: Supabase Dashboard → Logs
5. **If migration caused it**: Rollback immediately
6. **If not migration**: Contact Supabase support

### Data Corruption Detected

1. **STOP all writes immediately** (pause application if possible)
2. **Assess scope**: Which tables? How many rows?
3. **Restore from backup**:
   ```bash
   pg_restore -h <host> -U <user> -d <database> backup_file.dump
   ```
4. **Investigate root cause**
5. **Fix and re-apply migration**

### RLS Bypassed (Security Issue)

1. **Verify with test**:
   ```bash
   node scripts/verify_supabase.mjs
   ```
2. **If RLS is off**: Enable immediately:
   ```sql
   ALTER TABLE public.user_login ENABLE ROW LEVEL SECURITY;
   ```
3. **Check policies exist**:
   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'user_login';
   ```
4. **Review access logs** for unauthorized access

---

## Best Practices

### DO ✅

- **Always test migrations in dev/staging first**
- **Use `IF NOT EXISTS` / `IF EXISTS` clauses**
- **Enable RLS on all new tables**
- **Add indexes for foreign keys and frequently queried columns**
- **Use `security definer` for functions that need elevated privileges**
- **Document rollback plan before applying**
- **Backup production before applying**
- **Use transactions where possible**
- **Name migrations with timestamps**: `YYYYMMDDHHMMSS_description.sql`
- **Keep migrations small and focused**

### DON'T ❌

- **Don't use `DROP TABLE` without `IF EXISTS`**
- **Don't apply untested migrations to production**
- **Don't skip RLS policies**
- **Don't use service role key in application code**
- **Don't run `TRUNCATE` or `DELETE` without WHERE clause**
- **Don't make breaking changes without coordination**
- **Don't forget to grant permissions after creating functions**
- **Don't hardcode environment-specific values**
- **Don't skip backups before major migrations**

### Idempotent Patterns

**Good (idempotent):**
```sql
CREATE TABLE IF NOT EXISTS users (...);
DROP TABLE IF EXISTS old_table;
CREATE OR REPLACE FUNCTION my_func() ...;
```

**Bad (not idempotent):**
```sql
CREATE TABLE users (...);  -- Fails if table exists
DROP TABLE old_table;      -- Fails if table doesn't exist
```

---

## Troubleshooting

### Common Issues

| Error | Cause | Solution |
|-------|-------|----------|
| `relation "table" already exists` | Table created in previous run | Use `IF NOT EXISTS` |
| `column "col" does not exist` | Column was dropped or renamed | Check table schema |
| `permission denied` | Missing GRANT | Add `GRANT` statements |
| `new row violates RLS` | RLS policy too restrictive | Review RLS policies |
| `function does not exist` | Function name mismatch | Check function signature |
| `deadlock detected` | Concurrent transactions | Retry or simplify migration |

---

## Support

- **Supabase Docs**: https://supabase.com/docs
- **PostgreSQL Docs**: https://www.postgresql.org/docs/
- **Team Contact**: [Add your team's contact info]

---

**Last Updated**: 2025-10-22
**Maintained By**: Engineering Team
