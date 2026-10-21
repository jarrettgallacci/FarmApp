-- =====================================================================
-- Farm records schema — Supabase / Postgres
-- Every record traces back to fields.field_id.
-- Run once in the Supabase SQL editor on a fresh project.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------

-- App users (the three partners). Linked 1:1 to Supabase Auth.
create table public.profiles (
  user_id     uuid primary key references auth.users on delete cascade,
  email       text not null,
  name        text,
  created_at  timestamptz not null default now()
);

-- Create a profile row automatically when an auth user is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email) values (new.id, new.email);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Who physically did the work. Partners go in here too.
create table public.operators (
  operator_id  bigint generated always as identity primary key,
  name         text not null,
  type         text not null check (type in ('partner','employee','contractor')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.ditch_riders (
  rider_id  bigint generated always as identity primary key,
  name      text not null,
  phone     text,                       -- for the later direct-texting feature
  active    boolean not null default true,
  sort_order integer                    -- display order on the water order screen
);

-- ---------------------------------------------------------------------
-- Water infrastructure and fields
-- ---------------------------------------------------------------------

-- A turnout belongs to one ditch rider. Fields sharing a turnout are
-- aggregated into one line on the order.
create table public.turnouts (
  turnout_id  bigint generated always as identity primary key,
  name        text not null unique,     -- e.g. 'TO-3'
  rider_id    bigint not null references public.ditch_riders,
  sort_order  integer,
  notes       text
);

create table public.fields (
  field_id         bigint generated always as identity primary key,  -- permanent, never reused
  name             text not null,
  block            text,
  farm_unit        text,                -- '43', '108' — with block, how the district identifies it
  acres            numeric(8,2),        -- irrigated acres
  turnout_id       bigint references public.turnouts,
  flow_rate_cfs    numeric(6,2),
  parent_field_id  bigint references public.fields,  -- set on split halves (108-A east/west)
  active           boolean not null default true,     -- retire instead of delete
  sort_order       integer,             -- display order on the water order screen
  retired_on       date,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Sub-units share the parent's turnout; orders always go on the parent.
  constraint subunit_has_no_own_turnout
    check (parent_field_id is null or turnout_id is null),
  constraint not_own_parent check (parent_field_id <> field_id)
);
create index on public.fields (farm_unit);
create index on public.fields (parent_field_id);
create index on public.fields (turnout_id);

-- History when fields are re-drawn (split, merge, boundary change).
-- parent_field_id above is for live sub-units; this is lineage.
create table public.field_lineage (
  field_id            bigint not null references public.fields,
  predecessor_id      bigint not null references public.fields,
  change_type         text not null check (change_type in ('split','merge','boundary')),
  effective_on        date not null,
  notes               text,
  primary key (field_id, predecessor_id)
);

-- Deeded unless a lease or partnership is in effect.
create table public.leases (
  lease_id    bigint generated always as identity primary key,
  field_id    bigint not null references public.fields,
  agreement_type text not null default 'lease'
                check (agreement_type in ('lease','partnership','leased_out')),
  lessor      text not null,          -- landowner: lessor or partner grower
  start_date  date not null,
  end_date    date,
  rate        numeric(10,2),
  rate_basis  text,                     -- 'per acre', 'flat', 'crop share'
  notes       text,
  check (end_date is null or end_date >= start_date)
);
create index on public.leases (field_id);

-- ---------------------------------------------------------------------
-- Reference tables
-- ---------------------------------------------------------------------
create table public.chemicals (
  chemical_id        bigint generated always as identity primary key,
  name               text not null,
  active_ingredient  text,
  type               text not null check (type in
                       ('fertilizer','herbicide','insecticide','fungicide','adjuvant','other')),
  unit               text not null,     -- default unit: 'gal', 'lb', 'oz', 'ton'
  epa_reg_no         text,
  active             boolean not null default true
);

-- Mobile gear only. Fixed pivots are represented by the field.
create table public.equipment (
  equipment_id  bigint generated always as identity primary key,
  name          text not null,
  type          text,
  active        boolean not null default true,
  notes         text
);

-- ---------------------------------------------------------------------
-- Water ordering
-- Each submitted order is a FULL SNAPSHOT of what should be running
-- from order_date until the next order. The app pre-fills a new order
-- from the previous one, so "no change" is just re-submitting.
-- ---------------------------------------------------------------------
create table public.water_orders (
  order_id      bigint generated always as identity primary key,
  order_date    date not null unique,   -- the day the water runs
  submitted_at  timestamptz,
  status        text not null default 'draft'
                  check (status in ('draft','submitted','confirmed')),
  notes         text,
  created_by    uuid default auth.uid() references public.profiles,
  created_at    timestamptz not null default now()
);

-- One line per PARENT field. Turnout is copied at order time so the
-- record stays true if a field is later moved to a different turnout.
create table public.water_order_lines (
  order_id    bigint not null references public.water_orders on delete cascade,
  field_id    bigint not null references public.fields,
  turnout_id  bigint not null references public.turnouts,
  is_on       boolean not null default false,
  cfs         numeric(6,2) not null default 0 check (cfs >= 0),
  primary key (order_id, field_id)
);

-- Which half of a split field actually got water. The order is the same
-- either way; this is for the record.
create table public.water_order_subunits (
  order_id          bigint not null,
  field_id          bigint not null,              -- the parent on the line
  subunit_field_id  bigint not null references public.fields,
  watered           boolean not null default false,
  primary key (order_id, subunit_field_id),
  foreign key (order_id, field_id)
    references public.water_order_lines (order_id, field_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Water applied (pivot runtime). start/stop are timestamps so a run
-- that crosses midnight is one row.
-- 1 CFS for 1 second = 1 cubic foot; 43,560 cu ft = 1 acre-foot.
-- ---------------------------------------------------------------------
create table public.water_events (
  event_id    bigint generated always as identity primary key,
  field_id    bigint not null references public.fields,
  start_at    timestamptz not null,
  stop_at     timestamptz not null,
  cfs         numeric(6,2) not null,    -- rate during this run (defaults from field in the app)
  acre_feet   numeric(10,3) generated always as
                (round((cfs * date_part('epoch', stop_at - start_at) / 43560.0)::numeric, 3)) stored,
  source      text not null default 'manual' check (source in ('manual','basestation')),
  source_ref  text unique,              -- BaseStation row key, so re-imports don't duplicate
  notes       text,
  created_by  uuid default auth.uid() references public.profiles,
  created_at  timestamptz not null default now(),
  check (stop_at > start_at)
);
create index on public.water_events (field_id, start_at);

-- ---------------------------------------------------------------------
-- Chemical applications
-- One event = one pass. Products are separate lines, so a spray tank mix
-- of three products is one event with three product lines.
-- ---------------------------------------------------------------------
create table public.chemical_events (
  event_id       bigint generated always as identity primary key,
  field_id       bigint not null references public.fields,
  applied_on     date not null,
  method         text not null check (method in ('fertigation','dry_spread','spray')),
  acres_treated  numeric(8,2),
  notes          text,
  created_by     uuid default auth.uid() references public.profiles,
  performed_by   bigint references public.operators,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on public.chemical_events (field_id, applied_on);

create table public.chemical_event_products (
  event_id      bigint not null references public.chemical_events on delete cascade,
  chemical_id   bigint not null references public.chemicals,
  rate          numeric(10,3),          -- per acre
  rate_unit     text,                   -- 'gal/ac', 'lb/ac', 'oz/ac'
  total_amount  numeric(12,3),
  total_unit    text,
  primary key (event_id, chemical_id)
);

create table public.chemical_fertigation_details (
  event_id             bigint primary key references public.chemical_events on delete cascade,
  pump_rate            numeric(8,2),
  pump_rate_unit       text default 'gal/hr',
  pivot_runtime_hours  numeric(6,2)
);

create table public.chemical_spread_details (
  event_id    bigint primary key references public.chemical_events on delete cascade,
  contractor  text,                     -- or use performed_by with a contractor operator
  blend       text                      -- e.g. '11-52-0 + potash'
);

create table public.chemical_spray_details (
  event_id          bigint primary key references public.chemical_events on delete cascade,
  gallons_per_acre  numeric(6,2),
  carrier           text default 'water'
);

-- ---------------------------------------------------------------------
-- Crop years and harvest
-- One row per crop/variety per field per season. Peas then grass in the
-- same year = two rows with sequence 1 and 2.
-- ---------------------------------------------------------------------
create table public.crops (
  crop_id     bigint generated always as identity primary key,
  name        text not null unique,
  yield_unit  text,                     -- usual unit: bu, ton, cwt, lb
  multi_year  boolean not null default false,  -- usually a multi-year stand (form default)
  active      boolean not null default true
);

create table public.crop_years (
  crop_year_id   bigint generated always as identity primary key,
  field_id       bigint not null references public.fields,
  season         smallint not null,     -- 2026
  sequence       smallint not null default 1,
  crop_id        bigint not null references public.crops,
  variety        text,
  acres          numeric(8,2),          -- acres planted; blank = whole field
  multi_year     boolean not null default false,  -- stand carries into later seasons
  end_season     smallint,              -- last season in the field; blank = still in
  grown_by       text,                  -- tenant, when the field was leased out
  planting_date  date,
  notes          text,
  created_at     timestamptz not null default now(),
  unique (field_id, season, sequence, variety)
);
create index on public.crop_years (season);

create table public.harvest_records (
  harvest_id      bigint generated always as identity primary key,
  crop_year_id    bigint not null references public.crop_years on delete cascade,
  harvested_on    date not null,
  stage           text,                 -- 'cut', 'harvest', '1st cutting'
  yield           numeric(12,2),
  unit            text,                 -- 'bu', 'ton', 'cwt', 'lb'
  acres_harvested numeric(8,2),
  moisture_pct    numeric(5,2),
  notes           text,
  created_by      uuid default auth.uid() references public.profiles,
  created_at      timestamptz not null default now()
);
create index on public.harvest_records (crop_year_id);

-- ---------------------------------------------------------------------
-- Work events (tillage, planting, cultivating, …)
-- Add a new operation by inserting a row here and, if it needs extra
-- fields, adding one detail table. Nothing else changes.
-- ---------------------------------------------------------------------
create table public.operation_types (
  operation  text primary key,
  active     boolean not null default true
);
insert into public.operation_types (operation)
values ('tillage'), ('planting'), ('cultivating');

create table public.work_events (
  event_id      bigint generated always as identity primary key,
  field_id      bigint not null references public.fields,
  performed_on  date not null,
  operation     text not null references public.operation_types,
  equipment_id  bigint references public.equipment,
  hours         numeric(6,2),
  notes         text,
  created_by    uuid default auth.uid() references public.profiles,
  performed_by  bigint references public.operators,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on public.work_events (field_id, performed_on);

-- Variety lives on the crop year; the planting event points at it.
create table public.planting_details (
  event_id          bigint primary key references public.work_events on delete cascade,
  crop_year_id      bigint references public.crop_years,
  seed_plate        text,
  sprocket_setting  text,
  target_rate       numeric(10,2),
  rate_unit         text default 'seeds/ac',
  heading           text                -- direction of travel
);

-- ---------------------------------------------------------------------
-- Maintenance
-- Fixed pivots -> field_id. Mobile gear -> equipment_id. Exactly one.
-- ---------------------------------------------------------------------
create table public.maintenance_records (
  record_id     bigint generated always as identity primary key,
  field_id      bigint references public.fields,
  equipment_id  bigint references public.equipment,
  performed_on  date not null,
  type          text not null check (type in ('pre_season','post_season','in_season')),
  description   text not null,
  cost          numeric(10,2),
  performed_by  bigint references public.operators,
  notes         text,
  created_by    uuid default auth.uid() references public.profiles,
  created_at    timestamptz not null default now(),
  check (num_nonnulls(field_id, equipment_id) = 1)
);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
create trigger fields_updated   before update on public.fields
  for each row execute function public.set_updated_at();
create trigger chem_updated     before update on public.chemical_events
  for each row execute function public.set_updated_at();
create trigger work_updated     before update on public.work_events
  for each row execute function public.set_updated_at();

-- =====================================================================
-- Views
-- =====================================================================

-- What goes to each ditch rider: shared turnouts collapsed to one line.
create view public.water_order_summary with (security_invoker = true) as
select o.order_id,
       o.order_date,
       r.name                 as ditch_rider,
       t.name                 as turnout,
       bool_or(l.is_on)       as is_on,
       sum(l.cfs) filter (where l.is_on) as cfs,
       string_agg(f.name, ', ' order by f.name) filter (where l.is_on) as fields
from public.water_orders o
join public.water_order_lines l on l.order_id = o.order_id
join public.turnouts t          on t.turnout_id = l.turnout_id
join public.ditch_riders r      on r.rider_id = t.rider_id
join public.fields f            on f.field_id = l.field_id
group by o.order_id, o.order_date, r.name, t.name;

-- Ordered water per field per day. Each submitted order carries forward
-- until the next one. 1 CFS for 24 h = 1.9835 acre-feet.
create view public.water_ordered_daily with (security_invoker = true) as
with o as (
  select order_id, order_date,
         lead(order_date) over (order by order_date) as next_date
  from public.water_orders
  where status <> 'draft'
)
select d::date               as day,
       l.field_id,
       l.cfs,
       round(l.cfs * 1.9835, 3) as acre_feet_ordered
from o
join public.water_order_lines l on l.order_id = o.order_id and l.is_on
cross join lateral generate_series(
  o.order_date,
  coalesce(o.next_date - 1, current_date),
  interval '1 day') as d;

-- Ordered vs applied by field and season: the "paid for, not used" gap.
create view public.water_balance_by_season with (security_invoker = true) as
with ordered as (
  select field_id, extract(year from day)::int as season,
         sum(acre_feet_ordered) as af_ordered
  from public.water_ordered_daily group by 1, 2
),
applied as (
  -- sub-unit runs roll up to the parent field
  select coalesce(f.parent_field_id, e.field_id) as field_id,
         extract(year from e.start_at)::int as season,
         sum(e.acre_feet) as af_applied
  from public.water_events e
  join public.fields f on f.field_id = e.field_id
  group by 1, 2
)
select coalesce(o.field_id, a.field_id) as field_id,
       coalesce(o.season, a.season)     as season,
       coalesce(o.af_ordered, 0)        as af_ordered,
       coalesce(a.af_applied, 0)        as af_applied,
       coalesce(o.af_ordered, 0) - coalesce(a.af_applied, 0) as af_unused
from ordered o
full join applied a on a.field_id = o.field_id and a.season = o.season;

-- Crop year with harvest totals derived (not stored twice).
create view public.crop_year_summary with (security_invoker = true) as
select c.*,
       max(h.harvested_on) as last_harvest_date,
       sum(h.yield)        as total_yield,
       min(h.unit)         as yield_unit
from public.crop_years c
left join public.harvest_records h on h.crop_year_id = c.crop_year_id
group by c.crop_year_id;

-- =====================================================================
-- Row-level security: any signed-in user can read and write everything.
-- IMPORTANT: turn OFF public sign-ups in Supabase Auth settings and
-- invite the three partners manually, or anyone could create an account
-- and get full access.
-- =====================================================================
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "authenticated full access" on public.%I
         for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Last watered per field (and split half), from sent orders. Full definition
-- in stands_leaseout_water.sql.
