-- Loads (one tank mix sprayed across a queue of fields), start/stop times and
-- weather on chemical records, and applicator license info. Safe to re-run.

-- 1. A load: the tank mix and settings shared by every field in the queue.
--    Each queued field is a normal chemical record (status 'planned' until it's done).
create table if not exists public.chemical_loads (
  load_id       bigint generated always as identity primary key,
  name          text,
  applied_on    date not null default current_date,
  method        text,
  performed_by  bigint references public.operators,
  carrier_gpa   numeric(8,2),
  record_times  boolean not null default true,   -- start/stop times + weather (required for pesticides in WA)
  status        text not null default 'open' check (status in ('open', 'closed')),
  notes         text,
  created_at    timestamptz not null default now()
);
alter table public.chemical_loads enable row level security;
drop policy if exists "authenticated full access" on public.chemical_loads;
create policy "authenticated full access" on public.chemical_loads
  for all to authenticated using (true) with check (true);

-- 2. Chemical records: load link, queue order, times and weather (WAC 16-228-1320)
alter table public.chemical_events add column if not exists load_id bigint references public.chemical_loads on delete set null;
alter table public.chemical_events add column if not exists queue_pos smallint;
alter table public.chemical_events add column if not exists started_at timestamptz;
alter table public.chemical_events add column if not exists stopped_at timestamptz;
alter table public.chemical_events add column if not exists wind_dir text;              -- direction the wind blows FROM
alter table public.chemical_events add column if not exists wind_mph numeric(5,1);      -- low end (or the only reading)
alter table public.chemical_events add column if not exists wind_mph_max numeric(5,1);  -- high end when it varied
alter table public.chemical_events add column if not exists gust_mph numeric(5,1);
alter table public.chemical_events add column if not exists temp_f numeric(5,1);
alter table public.chemical_events add column if not exists weather_source text;        -- 'auto' (weather service) or 'measured'
alter table public.chemical_events add column if not exists applied_by_names text;      -- people who made the application
create index if not exists chemical_events_load_idx on public.chemical_events (load_id);

-- 3. Applicator details for the record
alter table public.operators add column if not exists license_no text;
alter table public.operators add column if not exists phone text;
alter table public.operators add column if not exists address text;
