## Summary

<!-- Briefly describe what this PR does and why -->

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Database migration (requires manual DB changes)
- [ ] Documentation update
- [ ] CI/CD improvement

## Changes Made

<!-- List the key changes in this PR -->

-
-
-

## Database Migration Checklist

<!-- If this PR includes database migrations, complete this checklist -->

**Required for all migration PRs:**

- [ ] Migration file follows naming convention: `YYYYMMDDHHMMSS_description.sql`
- [ ] Migration is **idempotent** (safe to run multiple times)
- [ ] Migration has been tested on a local/dev database
- [ ] Migration applies cleanly to a fresh database
- [ ] Migration includes rollback instructions in comments or RUNBOOK
- [ ] All new tables have RLS enabled (`alter table ... enable row level security`)
- [ ] RLS policies are documented and reviewed
- [ ] Performance impact assessed (indexes added where needed)
- [ ] No hardcoded values that should be environment variables
- [ ] Backfill script handles existing data safely (no duplicate key errors)

**Security checks:**

- [ ] RLS blocks unauthorized writes (verified with anon key test)
- [ ] Service role key is NOT used in application code
- [ ] Sensitive data is properly protected by RLS policies
- [ ] Functions use `security definer` appropriately
- [ ] No SQL injection vulnerabilities in dynamic queries

**Testing:**

- [ ] Read operations work with anon key for public data
- [ ] Write operations are properly restricted by RLS
- [ ] Ran `scripts/verify_supabase.mjs` successfully
- [ ] Ran `assert_security_and_perf_ok()` function - no issues
- [ ] Tested with existing production-like data

## Rollback Plan

<!-- Describe how to rollback this change if needed -->

**If migration fails or causes issues:**

1.
2.
3.

**SQL rollback commands:**
```sql
-- Add rollback SQL here
```

## Testing Performed

<!-- Describe the testing you've done -->

- [ ] Manual testing in local environment
- [ ] Unit tests added/updated (if applicable)
- [ ] Integration tests added/updated (if applicable)
- [ ] Tested on staging/dev environment
- [ ] Load tested (if performance-critical)

## Screenshots/Output

<!-- Include relevant screenshots, logs, or CLI output -->

```
# Example: Output from scripts/verify_supabase.mjs

```

## Documentation

- [ ] README updated (if needed)
- [ ] RUNBOOK updated (if migration changes DB schema)
- [ ] Code comments added for complex logic
- [ ] API documentation updated (if applicable)

## Dependencies

<!-- List any dependencies or prerequisites -->

- [ ] No new dependencies added
- [ ] New dependencies added (listed in PR description)
- [ ] Environment variables added/changed (documented in README)

**New environment variables:**
- `VARIABLE_NAME` - description

## Breaking Changes

<!-- If this PR includes breaking changes, describe them and the migration path -->

None / N/A

## Related Issues

<!-- Link to related issues -->

Closes #
Relates to #

## Reviewer Notes

<!-- Any specific areas you'd like reviewers to focus on -->

-
-

---

## Pre-merge Checklist

- [ ] CI passes (all checks green)
- [ ] Code reviewed and approved
- [ ] Migration reviewed by database admin (if applicable)
- [ ] Documentation is complete
- [ ] Tests are passing
- [ ] No merge conflicts
