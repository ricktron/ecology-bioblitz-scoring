-- Database audit function: checks for security and performance issues
-- Returns empty array [] if OK, otherwise returns array of violation objects

-- Drop existing function first (needed if return type changed from json to jsonb)
drop function if exists public.assert_security_and_perf_ok();

create or replace function public.assert_security_and_perf_ok()
returns jsonb
language plpgsql
security definer
as $$
declare
  violations jsonb := '[]'::jsonb;
  violation jsonb;
begin

  -- Check 1: Ensure RLS is enabled on all user-facing tables
  for violation in
    select jsonb_build_object(
      'check', 'rls_enabled',
      'severity', 'high',
      'table', schemaname || '.' || tablename,
      'message', 'Row Level Security not enabled'
    )
    from pg_tables
    where schemaname = 'public'
      and tablename not like 'pg_%'
      and tablename not in ('score_runs', 'spider_trip_windows_v1')  -- exclude ledger/config tables
      and not exists (
        select 1 from pg_class c
        where c.relname = tablename
          and c.relrowsecurity = true
      )
  loop
    violations := violations || jsonb_build_array(violation);
  end loop;

  -- Check 2: Ensure important tables have indexes on frequently queried columns
  -- Check for missing index on observations.updated_at (used in incremental sync)
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'observations'
      and indexdef like '%updated_at%'
  ) then
    violations := violations || jsonb_build_array(
      jsonb_build_object(
        'check', 'missing_index',
        'severity', 'medium',
        'table', 'public.observations',
        'column', 'updated_at',
        'message', 'Missing index on frequently queried column'
      )
    );
  end if;

  -- Check 3: Ensure observations table has index on id column
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'observations'
      and indexdef like '%inat_obs_id%'
  ) then
    violations := violations || jsonb_build_array(
      jsonb_build_object(
        'check', 'missing_index',
        'severity', 'high',
        'table', 'public.observations',
        'column', 'inat_obs_id',
        'message', 'Missing primary key or unique index'
      )
    );
  end if;

  -- Check 4: Ensure materialized views exist
  if not exists (
    select 1 from pg_matviews
    where schemaname = 'public'
      and matviewname = 'leaderboard_overall_mv'
  ) then
    violations := violations || jsonb_build_array(
      jsonb_build_object(
        'check', 'missing_matview',
        'severity', 'medium',
        'object', 'public.leaderboard_overall_mv',
        'message', 'Expected materialized view not found'
      )
    );
  end if;

  return violations;
end;
$$;

-- Grant execute permission to authenticated users (adjust as needed)
grant execute on function public.assert_security_and_perf_ok() to service_role;
