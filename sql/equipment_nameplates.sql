-- Nameplates: a pump station has a motor plate and a pump plate, each with its own make, model and serial,
-- so plates live in their own table (one row per plate) instead of more columns on equipment. Safe to re-run.
create table if not exists public.equipment_nameplates (
  nameplate_id    bigint generated always as identity primary key,
  equipment_id    bigint not null references public.equipment on delete cascade,
  component       text not null default 'motor',   -- motor, pump, other
  make            text,
  model           text,
  serial_no       text,
  catalog_no      text,
  -- motor
  hp              numeric(7,1),
  volts           text,          -- as printed, e.g. '230/460'
  amps            text,          -- full-load amps as printed, e.g. '118/59'
  rpm             integer,
  phase           smallint,
  hz              smallint,
  frame           text,
  service_factor  numeric(4,2),
  efficiency_pct  numeric(4,1),
  enclosure       text,          -- TEFC, ODP, WPI ...
  -- pump
  gpm             numeric(8,1),
  head_ft         numeric(7,1),
  impeller_in     numeric(5,2),
  stages          smallint,
  -- record
  photo_path      text,          -- file in the 'equipment' storage bucket
  unreadable      text,          -- fields that could not be read off the plate
  notes           text,
  created_at      timestamptz not null default now(),
  check (component in ('motor', 'pump', 'other'))
);
create index if not exists equipment_nameplates_eq_idx on public.equipment_nameplates (equipment_id);
alter table public.equipment_nameplates enable row level security;
drop policy if exists "authenticated full access" on public.equipment_nameplates;
create policy "authenticated full access" on public.equipment_nameplates
  for all to authenticated using (true) with check (true);
