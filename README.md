# Ecology BioBlitz Scoring

Scoring and leaderboard system for Ecology BioBlitz assignments. This system ingests iNaturalist observations, calculates scores, and generates leaderboards for students and adult leaders.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Database Setup](#database-setup)
- [Running Locally](#running-locally)
- [Scripts](#scripts)
- [Database Migrations](#database-migrations)
- [CI/CD](#cicd)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

---

## Features

- **iNaturalist Integration**: Automatically ingest observations from iNaturalist API
- **Flexible Scoring**: Calculate daily and trip-wide scores with customizable rules
- **Leaderboards**: Generate student-only rankings with adult leader footnotes
- **Row Level Security**: All database access protected by Supabase RLS policies
- **Migration Support**: Version-controlled database schema with rollback capability
- **CI/CD**: Automated testing and validation on every pull request

---

## Prerequisites

- **Node.js**: v20.0.0 or higher
- **npm**: v9.0.0 or higher
- **Supabase Account**: Free tier is sufficient
- **Git**: For version control

---

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/ricktron/ecology-bioblitz-scoring.git
cd ecology-bioblitz-scoring
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Environment Variables

Create a `.env` file in the root directory (or use your platform's environment variable configuration):

```bash
# Supabase Configuration
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here

# Optional: For admin scripts ONLY (never use in app code)
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
```

**IMPORTANT**: Never commit the `.env` file. It's already in `.gitignore`.

**Where to find these values:**
1. Log into [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Go to Settings → API
4. Copy `URL` and `anon public` key

---

## Database Setup

### Initial Setup (New Project)

If you're setting up a new Supabase project:

1. **Create a Supabase Project** at https://app.supabase.com
2. **Apply the base schema** (if you have one) or wait for migrations
3. **Apply migrations** (see below)

### Applying Migrations

Migrations are located in `supabase/migrations/`. Apply them in order:

**Option A: Via Supabase Dashboard**

1. Go to Supabase Dashboard → SQL Editor
2. Open migration file: `supabase/migrations/20251022000000_user_login_and_scoring_v2.sql`
3. Copy contents and paste into SQL Editor
4. Click "Run"

**Option B: Via Supabase CLI**

```bash
# Install Supabase CLI
npm install -g supabase

# Link to your project
supabase link --project-ref your-project-ref

# Apply all pending migrations
supabase db push
```

**Option C: Via psql**

```bash
psql -h db.your-project-ref.supabase.co -U postgres -d postgres -f supabase/migrations/20251022000000_user_login_and_scoring_v2.sql
```

### Verifying Database Setup

After applying migrations, run the verification script:

```bash
node scripts/verify_supabase.mjs
```

**Expected output:**
```
✅ Read successful!
✅ RLS is working correctly!
✅ All security and performance checks passed!
```

For detailed migration procedures, see [RUNBOOK_DB_MIGRATIONS.md](./RUNBOOK_DB_MIGRATIONS.md).

---

## Running Locally

### Start Development

```bash
# Run the ingestion script (example)
npm run ingest

# Or run TypeScript build (if configured)
npm run build
```

### Testing Supabase Connection

```bash
# Quick connection test
node test_supabase.mjs

# Comprehensive verification
node scripts/verify_supabase.mjs
```

---

## Scripts

### Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| **Ingest** | `npm run ingest` | Run iNaturalist data ingestion |
| **Verify** | `node scripts/verify_supabase.mjs` | Verify database connection and security |
| **Test** | `npm test` | Run test suite (if configured) |
| **Build** | `npm run build` | Build TypeScript (if configured) |
| **Lint** | `npm run lint` | Run linter (if configured) |

### Verification Script

The `scripts/verify_supabase.mjs` script performs comprehensive checks:

- ✅ **Connection Test**: Verifies Supabase is reachable
- ✅ **RLS Enforcement**: Confirms anon key cannot write to protected tables
- ✅ **Security Audit**: Runs database security checks
- ✅ **Table Validation**: Checks that required tables exist

**Usage:**
```bash
# Set environment variables first
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"

# Run verification
node scripts/verify_supabase.mjs
```

---

## Database Migrations

### Migration Philosophy

- **Idempotent**: All migrations can be run multiple times safely
- **Versioned**: Migrations use timestamp naming: `YYYYMMDDHHMMSS_description.sql`
- **Rollback Ready**: Every migration has documented rollback procedure
- **RLS First**: Row Level Security is enabled on all tables

### Creating a New Migration

1. Create file: `supabase/migrations/YYYYMMDDHHMMSS_your_description.sql`
2. Write idempotent SQL (use `IF NOT EXISTS`, `CREATE OR REPLACE`)
3. Test on local/dev database
4. Document rollback in comments or RUNBOOK
5. Apply to staging, then production

### Migration Best Practices

- Use `CREATE TABLE IF NOT EXISTS`
- Use `CREATE OR REPLACE FUNCTION`
- Enable RLS: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- Add indexes for performance
- Use `security definer` for privileged functions
- Never use service role key in app code

**Full migration guide**: [RUNBOOK_DB_MIGRATIONS.md](./RUNBOOK_DB_MIGRATIONS.md)

---

## CI/CD

### GitHub Actions

The project uses GitHub Actions for continuous integration:

**Workflows:**
- **Build & Test** (`build-test`): Runs npm install, lint, build, and tests
- **SQL Validation** (`sql-lint`): Validates migration syntax and safety
- **Code Quality** (`code-quality`): Checks for secrets and code issues
- **Security Audit** (`security`): Runs npm audit for vulnerabilities

**Configuration**: `.github/workflows/ci.yml`

### Pull Request Checks

All PRs must pass:
- ✅ Build succeeds
- ✅ Tests pass (if present)
- ✅ SQL migrations are valid
- ✅ No hardcoded secrets
- ✅ No security vulnerabilities (or acknowledged)

---

## Project Structure

```
ecology-bioblitz-scoring/
├── .github/
│   ├── workflows/
│   │   └── ci.yml                    # CI/CD pipeline
│   └── pull_request_template.md      # PR checklist
├── src/
│   └── lib/
│       └── supabase.ts               # Supabase client adapter
├── scripts/
│   └── verify_supabase.mjs           # Database verification script
├── supabase/
│   └── migrations/
│       └── 20251022000000_user_login_and_scoring_v2.sql
├── sql/
│   └── leaderboard_views.template.sql # Legacy SQL templates
├── ingest.mjs                        # iNaturalist ingestion script
├── test_supabase.mjs                 # Quick connection test
├── package.json
├── .env                              # Environment variables (not committed)
├── .gitignore
├── README.md                         # This file
└── RUNBOOK_DB_MIGRATIONS.md          # Migration procedures
```

---

## Key Tables

### Core Tables

- **`observations`**: iNaturalist observation data
- **`daily_scores`**: Calculated scores per student per day
- **`roster`**: Student/participant directory
- **`student_identities`**: Maps roster to iNaturalist accounts
- **`user_login`**: Auth user metadata with RLS protection
- **`spider_trip_windows_v1`**: Trip date configuration
- **`score_runs`**: Ingestion audit log

### Views

- **`active_participants_v1`**: Active students with iNat logins
- **`scoreboard_day_v1`**: Daily leaderboard with rankings
- **`leaderboard_trip_v1`**: Trip-wide leaderboard
- **`public_leaderboard_unified_v1`**: Unified leaderboard with user info

---

## Security

### Row Level Security (RLS)

All tables have RLS enabled. Key policies:

- **`user_login`**: Users can only read their own row
- **Protected writes**: Only service role or security definer functions can write

### API Keys

- **Anon Key**: Safe to use in frontend/app code (RLS protects data)
- **Service Role Key**: NEVER use in app code (bypasses RLS)

**Best Practice**: Always use anon key. Write security definer functions for privileged operations.

### Verification

Run security checks:
```bash
node scripts/verify_supabase.mjs
```

Or query directly:
```sql
SELECT * FROM public.assert_security_and_perf_ok();
```

---

## Contributing

### Workflow

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make changes
3. Test locally: `node scripts/verify_supabase.mjs`
4. Commit with clear messages
5. Push and create PR
6. Ensure CI passes
7. Request review

### Database Changes

If your PR includes database changes:

1. Create migration in `supabase/migrations/`
2. Test on dev database
3. Document rollback plan
4. Run verification script
5. Update RUNBOOK if needed
6. Fill out migration checklist in PR template

---

## Troubleshooting

### "fetch failed" error

**Cause**: No network access or incorrect URL

**Solution**:
```bash
# Verify SUPABASE_URL is correct
echo $SUPABASE_URL

# Test connectivity
curl https://your-project-ref.supabase.co
```

### "relation does not exist"

**Cause**: Migration not applied

**Solution**: Apply migrations (see [Database Setup](#database-setup))

### "permission denied" or RLS error

**Cause**: RLS policy blocking access

**Solution**:
- Check if you're authenticated
- Review RLS policies
- Use service role key for admin operations (scripts only)

### "Migration already applied"

**Cause**: Trying to re-run non-idempotent migration

**Solution**: Migrations should be idempotent. Update SQL to use `IF NOT EXISTS` / `CREATE OR REPLACE`

---

## License

ISC

---

## Support

For issues or questions:
- Open an issue on GitHub
- Check [RUNBOOK_DB_MIGRATIONS.md](./RUNBOOK_DB_MIGRATIONS.md) for migration help
- Review Supabase docs: https://supabase.com/docs
