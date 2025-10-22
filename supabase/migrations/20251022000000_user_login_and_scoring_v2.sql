-- Migration: User Login Hardening + Scoring V2
-- Purpose: Fix null user login bugs, add RLS, harden scoring views
-- Safe to re-run: Yes (idempotent patterns throughout)

-- ============================================================================
-- 1. CORE USER_LOGIN TABLE
-- ============================================================================

-- Create user_login table with proper constraints
create table if not exists public.user_login (
  user_id uuid primary key,
  email text not null,
  provider text not null default 'email',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_login_email_not_empty check (length(trim(email)) > 0)
);

-- Unique index on email (case-insensitive)
do $$ begin
  if not exists (select 1 from pg_indexes where indexname = 'user_login_email_key') then
    create unique index user_login_email_key on public.user_login (lower(email));
  end if;
end $$;

-- Index on provider for filtering
do $$ begin
  if not exists (select 1 from pg_indexes where indexname = 'idx_user_login_provider') then
    create index idx_user_login_provider on public.user_login (provider);
  end if;
end $$;

-- ============================================================================
-- 2. SAFE UPSERT FUNCTION (prevents NULL values)
-- ============================================================================

create or replace function public.safe_upsert_user_login(
  p_user_id uuid,
  p_email text default null,
  p_provider text default null
) returns public.user_login
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := coalesce(p_email, 'unknown@bioblitz.local');
  v_provider text := coalesce(p_provider, 'email');
  v_row public.user_login;
begin
  -- Validate required parameters
  if p_user_id is null then
    raise exception 'safe_upsert_user_login: user_id cannot be NULL';
  end if;

  -- Ensure email is not empty after trimming
  if length(trim(v_email)) = 0 then
    v_email := 'unknown@bioblitz.local';
  end if;

  -- Upsert with conflict resolution
  insert into public.user_login (user_id, email, provider)
  values (p_user_id, v_email, v_provider)
  on conflict (user_id) do update
     set email = coalesce(excluded.email, user_login.email),
         provider = coalesce(excluded.provider, user_login.provider),
         updated_at = now()
  returning * into v_row;

  return v_row;
end $$;

-- Grant execute to authenticated users (for profile updates)
grant execute on function public.safe_upsert_user_login to authenticated;

-- ============================================================================
-- 3. AUTH TRIGGER (auto-seed user_login on signup)
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.safe_upsert_user_login(
    new.id,
    coalesce(new.email, new.raw_user_meta_data->>'email', 'unknown@bioblitz.local'),
    coalesce(new.raw_user_meta_data->>'provider', 'email')
  );
  return new;
end $$;

-- Create trigger if it doesn't exist
do $$ begin
  if not exists (
     select 1 from pg_trigger
     where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass) then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end $$;

-- ============================================================================
-- 4. ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on user_login
alter table public.user_login enable row level security;

-- Policy: authenticated users can select their own row
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_login'
      and policyname = 'user_login_select_self'
  ) then
    create policy user_login_select_self
      on public.user_login
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

-- Policy: service role can insert/update (for admin operations)
-- Note: This runs in security definer context, so regular users use safe_upsert_user_login
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_login'
      and policyname = 'user_login_service_role_all'
  ) then
    create policy user_login_service_role_all
      on public.user_login
      for all
      using (auth.role() = 'service_role');
  end if;
end $$;

-- ============================================================================
-- 5. SCORING VIEWS (V2 - improved with better joins and error handling)
-- ============================================================================

-- View: Public leaderboard unified (combines user_login with scoring)
-- Note: Adjust if you have a scores_summary table
create or replace view public.public_leaderboard_unified_v1 as
select
  ul.user_id,
  ul.email,
  ul.provider,
  coalesce(sum(ds.points), 0)::int as total_score,
  dense_rank() over (order by coalesce(sum(ds.points), 0) desc) as rank
from public.user_login ul
left join public.daily_scores ds on ds.roster_id = ul.user_id
  or ds.student_id = ul.user_id
  or ds.person_id = ul.user_id
group by ul.user_id, ul.email, ul.provider;

-- View: Daily scoreboard V2 (improved date handling)
create or replace view public.daily_scoreboard_v2 as
with date_series as (
  select generate_series(
    (select min(score_date)::date from public.daily_scores),
    (select max(score_date)::date from public.daily_scores),
    '1 day'::interval
  )::date as day
),
daily_totals as (
  select
    score_date::date as day,
    roster_id as user_id,
    sum(points)::int as score,
    count(*) as observation_count
  from public.daily_scores
  where score_date is not null
  group by score_date::date, roster_id
)
select
  ds.day,
  dt.user_id,
  coalesce(dt.score, 0) as score,
  coalesce(dt.observation_count, 0) as observation_count,
  dense_rank() over (partition by ds.day order by coalesce(dt.score, 0) desc) as daily_rank
from date_series ds
left join daily_totals dt on dt.day = ds.day
order by ds.day desc, daily_rank;

-- ============================================================================
-- 6. INDEXES FOR PERFORMANCE
-- ============================================================================

-- Index on observations for date-based queries
do $$ begin
  if not exists (select 1 from pg_indexes where indexname = 'idx_observations_observed_at') then
    create index idx_observations_observed_at on public.observations (observed_at);
  end if;
end $$;

-- Index on observations for user-based queries
do $$ begin
  if not exists (select 1 from pg_indexes where indexname = 'idx_observations_user_login') then
    create index idx_observations_user_login on public.observations (user_login);
  end if;
end $$;

-- Index on daily_scores for roster_id (if column exists)
-- Note: This is conditional based on your actual column name
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'daily_scores'
      and column_name = 'roster_id'
  ) then
    if not exists (select 1 from pg_indexes where indexname = 'idx_daily_scores_roster_id') then
      create index idx_daily_scores_roster_id on public.daily_scores (roster_id);
    end if;
  end if;
end $$;

-- ============================================================================
-- 7. REFRESH HELPER FUNCTION
-- ============================================================================

create or replace function public.refresh_leaderboards_v1()
returns void
language plpgsql
security definer
as $$
begin
  -- If you have materialized views, refresh them here
  -- For now, this is a no-op since we're using regular views
  -- Future: REFRESH MATERIALIZED VIEW CONCURRENTLY public.some_mv;

  -- Log the refresh (optional)
  raise notice 'Leaderboards refreshed at %', now();
end $$;

grant execute on function public.refresh_leaderboards_v1 to authenticated;

-- ============================================================================
-- 8. BACKFILL EXISTING AUTH USERS
-- ============================================================================

-- Backfill: seed user_login from existing auth.users
-- Safe to re-run (uses safe_upsert which handles conflicts)
do $$
declare
  v_user record;
  v_count int := 0;
begin
  for v_user in
    select id, email, raw_user_meta_data
    from auth.users
  loop
    perform public.safe_upsert_user_login(
      v_user.id,
      coalesce(v_user.email, v_user.raw_user_meta_data->>'email'),
      coalesce(v_user.raw_user_meta_data->>'provider', 'email')
    );
    v_count := v_count + 1;
  end loop;

  raise notice 'Backfilled % users into user_login', v_count;
end $$;

-- ============================================================================
-- 9. HELPER FUNCTION: Assert security and performance
-- ============================================================================

create or replace function public.assert_security_and_perf_ok()
returns table(issue text)
language plpgsql
security definer
as $$
begin
  -- Check 1: RLS is enabled on user_login
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public'
      and tablename = 'user_login'
      and rowsecurity = true
  ) then
    return query select 'RLS not enabled on public.user_login'::text;
  end if;

  -- Check 2: Required indexes exist
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'daily_scores'
      and indexname = 'idx_daily_scores_date'
  ) then
    return query select 'Missing index: idx_daily_scores_date'::text;
  end if;

  -- Check 3: No NULL emails in user_login
  if exists (
    select 1 from public.user_login
    where email is null or length(trim(email)) = 0
  ) then
    return query select 'Found NULL or empty emails in user_login'::text;
  end if;

  -- All checks passed
  return;
end $$;

grant execute on function public.assert_security_and_perf_ok to authenticated;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Verification query (run manually to confirm)
-- select * from public.assert_security_and_perf_ok();
-- select count(*) as user_count from public.user_login;
-- select * from public.public_leaderboard_unified_v1 limit 5;
