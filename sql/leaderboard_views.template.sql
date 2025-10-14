create table if not exists public.spider_trip_windows_v1 (
  trip_key   text primary key,
  start_date date not null,
  end_date   date not null
);

insert into public.spider_trip_windows_v1 (trip_key, start_date, end_date)
values ('Costa Rica 2025 (demo)', '2020-10-13', '2025-10-13')
on conflict (trip_key) do update
set start_date = excluded.start_date,
    end_date   = excluded.end_date;

create or replace view public.active_participants_v1 as
select
  r.id                        as roster_id,
  r.display_name,
  coalesce(r.is_adult, false) as is_adult,
  si.provider_uid             as inat_login
from public.roster r
join public.student_identities si on si.user_id = r.id
where si.provider = 'inat'
  and coalesce(si.active, true);

create or replace view public.scoreboard_day_v1 as
with base as (
  select
    ds.score_date::date as score_date,
    ds.__ID_COL__       as roster_id,
    sum(ds.points)::int as points
  from public.daily_scores ds
  group by 1,2
),
joined as (
  select
    b.score_date,
    ap.roster_id,
    ap.display_name,
    ap.is_adult,
    b.points
  from base b
  join public.active_participants_v1 ap on ap.roster_id = b.roster_id
)
select
  j.score_date,
  j.roster_id,
  j.display_name,
  j.points,
  case when j.is_adult then null
       else dense_rank() over (partition by j.score_date order by j.points desc, j.display_name asc)
  end as student_rank,
  j.is_adult
from joined j
order by j.score_date desc, student_rank nulls last, j.points desc, j.display_name;

create or replace view public.scoreboard_day_adult_footnotes_v1 as
select
  d.score_date,
  array_agg(format('%s — %s pts', d.display_name, d.points) order by d.points desc, d.display_name) as adult_notes
from public.scoreboard_day_v1 d
where d.is_adult
group by d.score_date;

create or replace view public.leaderboard_trip_v1 as
with tw as (
  select start_date, end_date
  from public.spider_trip_windows_v1
  where trip_key = 'Costa Rica 2025 (demo)'
),
base as (
  select
    ds.__ID_COL__ as roster_id,
    sum(ds.points)::int as points
  from public.daily_scores ds, tw
  where ds.score_date >= tw.start_date
    and ds.score_date <= tw.end_date
  group by ds.__ID_COL__
),
joined as (
  select
    ap.roster_id,
    ap.display_name,
    ap.is_adult,
    b.points
  from base b
  join public.active_participants_v1 ap on ap.roster_id = b.roster_id
)
select
  j.roster_id,
  j.display_name,
  j.points,
  case when j.is_adult then null
       else dense_rank() over (order by j.points desc, j.display_name asc)
  end as student_rank,
  j.is_adult
from joined j
order by student_rank nulls last, j.points desc, j.display_name;

create or replace view public.leaderboard_trip_adult_footnotes_v1 as
select
  array_agg(format('%s — %s pts', l.display_name, l.points) order by l.points desc, l.display_name) as adult_notes
from public.leaderboard_trip_v1 l
where l.is_adult;

create index if not exists idx_daily_scores_date on public.daily_scores(score_date);
-- add one of these manually later once you know the id col:
-- create index if not exists idx_daily_scores_student on public.daily_scores(student_id);
-- create index if not exists idx_daily_scores_roster  on public.daily_scores(roster_id);
-- create index if not exists idx_daily_scores_person  on public.daily_scores(person_id);
