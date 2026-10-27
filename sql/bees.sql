-- Bees (alfalfa leafcutter): DRAFT schema, not yet used by the app.
-- Follows each lot of cells from cooler to incubator to field shelter and back,
-- so every season ends with a return ratio per field and per shelter.
-- Sprays near shelters are not stored here: they come from chemical_events on
-- the shelter's field during the placement dates. Safe to re-run.

-- Rooms: coolers, incubation rooms, fall warm/drying rooms.
create table if not exists public.bee_rooms (
  room_id           bigint generated always as identity primary key,
  name              text not null unique,
  kind              text not null check (kind in ('cooler','incubator','fall')),
  controller_make   text,                 -- for pulling readings / pushing setpoints later
  controller_model  text,
  active            boolean not null default true,
  notes             text
);

-- A lot = cells that are counted and sampled together (a purchase, or one fall's
-- stripped cells). Recovered lots point back to the season they came from.
create table if not exists public.bee_lots (
  lot_id          bigint generated always as identity primary key,
  name            text not null,          -- e.g. '2026 recovered', 'Canada purchase Mar 2027'
  source          text not null check (source in ('purchased','recovered')),
  supplier        text,
  acquired_on     date,
  gallons         numeric(8,2),
  pounds          numeric(8,2),
  cost            numeric(12,2),
  from_season     smallint,               -- recovered: the season the bees flew
  -- fall handling (recovered lots)
  warm_start_on   date,
  cooled_on       date,
  stripped_on     date,
  bleached_on     date,
  notes           text,
  created_at      timestamptz not null default now()
);

-- Cell samples: Parma lab X-ray, own cut test, or an emergence test.
create table if not exists public.bee_samples (
  sample_id         bigint generated always as identity primary key,
  lot_id            bigint not null references public.bee_lots on delete cascade,
  sampled_on        date not null,
  method            text not null check (method in ('lab','cut','emergence')),
  lab               text,
  cells_counted     integer,
  pct_live          numeric(5,2),
  pct_chalkbrood    numeric(5,2),
  pct_pollen_ball   numeric(5,2),
  pct_parasitized   numeric(5,2),
  pct_dead          numeric(5,2),
  pct_machine_damage numeric(5,2),
  live_per_lb       integer,
  pct_female        numeric(5,2),
  pct_emerged       numeric(5,2),
  notes             text
);
create index if not exists bee_samples_lot_idx on public.bee_samples (lot_id, sampled_on);

-- Where a lot is held, and when. Days in cold storage = out_on - in_on.
create table if not exists public.bee_storage (
  storage_id  bigint generated always as identity primary key,
  lot_id      bigint not null references public.bee_lots on delete cascade,
  room_id     bigint not null references public.bee_rooms,
  in_on       date not null,
  out_on      date,
  notes       text
);

-- Temperature / humidity, typed in or pulled from a controller.
create table if not exists public.bee_room_readings (
  reading_id  bigint generated always as identity primary key,
  room_id     bigint not null references public.bee_rooms on delete cascade,
  read_at     timestamptz not null,
  temp_f      numeric(5,1),
  rh_pct      numeric(5,1),
  source      text not null default 'manual' check (source in ('manual','controller'))
);
create index if not exists bee_room_readings_room_idx on public.bee_room_readings (room_id, read_at);

-- Per field per season: when bees need to be flying, and how many.
create table if not exists public.bee_plans (
  plan_id            bigint generated always as identity primary key,
  season             smallint not null,
  field_id           bigint not null references public.fields,
  crop_year_id       bigint references public.crop_years,
  target_flight_on   date not null,         -- start of bloom
  bees_per_acre      integer,                -- live bees; 30,000-40,000 established
  acres              numeric(8,2),           -- blank = field acres
  notes              text,
  unique (season, field_id)
);

-- One incubation run = one room started on one day. The app works the start
-- date back from the plans it serves with the degree-day model (60F base).
create table if not exists public.bee_incubation_runs (
  run_id           bigint generated always as identity primary key,
  season           smallint not null,
  room_id          bigint not null references public.bee_rooms,
  started_on       date not null,
  setpoint_f       numeric(4,1) not null default 85,
  target_release_on date,
  status           text not null default 'planned' check (status in ('planned','running','released','done')),
  notes            text
);
create table if not exists public.bee_run_lots (
  run_id    bigint not null references public.bee_incubation_runs on delete cascade,
  lot_id    bigint not null references public.bee_lots,
  gallons   numeric(8,2),
  trays     integer,
  primary key (run_id, lot_id)
);
create table if not exists public.bee_run_plans (
  run_id   bigint not null references public.bee_incubation_runs on delete cascade,
  plan_id  bigint not null references public.bee_plans on delete cascade,
  primary key (run_id, plan_id)
);

-- Daily log during a run: pupal stage checks, trap counts, setpoint changes, feeding.
create table if not exists public.bee_run_events (
  event_id     bigint generated always as identity primary key,
  run_id       bigint not null references public.bee_incubation_runs on delete cascade,
  happened_at  timestamptz not null default now(),
  kind         text not null check (kind in ('stage_check','trap_count','setpoint','feeding','vacuum','note')),
  pupal_stage  text check (pupal_stage in ('prepupa','white','eyes_pink','eyes_dark','body_darkening','black','males_out','females_out')),
  trap_count   integer,
  setpoint_f   numeric(4,1),
  notes        text
);
create index if not exists bee_run_events_run_idx on public.bee_run_events (run_id, happened_at);

-- Shelters are permanent things with a number; where they sit changes each season.
create table if not exists public.bee_shelters (
  shelter_id  bigint generated always as identity primary key,
  number      text not null unique,
  boards      integer,                -- nest boards it holds
  active      boolean not null default true,
  notes       text
);
create table if not exists public.bee_placements (
  placement_id  bigint generated always as identity primary key,
  season        smallint not null,
  shelter_id    bigint not null references public.bee_shelters,
  field_id      bigint not null references public.fields,
  lat           numeric(9,6),
  lng           numeric(9,6),
  facing        text check (facing in ('N','NE','E','SE','S','SW','W','NW')),
  placed_on     date,
  removed_on    date,
  notes         text,
  unique (season, shelter_id)
);

-- Trays out to a shelter.
create table if not exists public.bee_releases (
  release_id          bigint generated always as identity primary key,
  placement_id        bigint not null references public.bee_placements on delete cascade,
  run_id              bigint references public.bee_incubation_runs,
  released_on         date not null,
  trays               integer,
  gallons             numeric(8,2),
  pct_females_out     numeric(5,2),
  weather             text,
  notes               text
);

-- In-season shelter checks: fill, dead bees out front, problems.
create table if not exists public.bee_shelter_checks (
  check_id       bigint generated always as identity primary key,
  placement_id   bigint not null references public.bee_placements on delete cascade,
  checked_on     date not null,
  pct_filled     numeric(5,2),
  swept          boolean not null default false,
  problem        text,                  -- dead males, mold, wasps, birds...
  notes          text
);

-- Nests in from a shelter. Per-shelter return needs these numbers BEFORE cells
-- from several shelters are stripped together into one lot.
create table if not exists public.bee_recoveries (
  recovery_id     bigint generated always as identity primary key,
  placement_id    bigint not null references public.bee_placements on delete cascade,
  brought_in_on   date not null,
  boards          integer,
  pct_holes_filled numeric(5,2),        -- board probe estimate
  into_lot_id     bigint references public.bee_lots,
  notes           text
);

do $$
declare t text;
begin
  foreach t in array array['bee_rooms','bee_lots','bee_samples','bee_storage','bee_room_readings',
    'bee_plans','bee_incubation_runs','bee_run_lots','bee_run_plans','bee_run_events','bee_shelters',
    'bee_placements','bee_releases','bee_shelter_checks','bee_recoveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "authenticated full access" on public.%I', t);
    execute format('create policy "authenticated full access" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
