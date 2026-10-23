-- Pivot towers, and irrigation seasons (start / end). Safe to re-run.

-- 1. Towers on pivots (and whether it has a corner machine). Filled from the notes where they say so.
alter table public.equipment add column if not exists towers smallint;
alter table public.equipment add column if not exists corner_arm boolean not null default false;
update public.equipment
   set towers = substring(notes from '(\d+)\s*[Tt]owers?')::smallint
 where towers is null and type ilike '%pivot%' and notes ~* '\d+\s*towers?';
update public.equipment set corner_arm = true
 where type ilike '%pivot%' and notes ~* 'corner' and not corner_arm;

-- 2. Irrigation seasons. While a season is ended, the dashboard stops asking for water orders.
create table if not exists public.irrigation_seasons (
  season_id   bigint generated always as identity primary key,
  year        smallint not null unique,
  start_date  date,
  end_date    date,          -- water shut off (blank = season still running)
  notes       text,
  created_at  timestamptz not null default now()
);
alter table public.irrigation_seasons enable row level security;
drop policy if exists "authenticated full access" on public.irrigation_seasons;
create policy "authenticated full access" on public.irrigation_seasons
  for all to authenticated using (true) with check (true);
