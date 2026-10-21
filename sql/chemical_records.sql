-- Chemical records: products, applications and their product lines.

-- 1. Products (the chemicals table)
alter table public.chemicals add column if not exists manufacturer text;
alter table public.chemicals add column if not exists notes text;
alter table public.chemicals add column if not exists legacy_id integer unique;   -- Access ProductTable ID
alter table public.chemicals alter column unit drop not null;
alter table public.chemicals drop constraint if exists chemicals_type_check;
update public.chemicals set type = 'adjuvant' where type is null;
alter table public.chemicals add constraint chemicals_type_check check (type in
  ('herbicide','insecticide','fungicide','fertilizer','adjuvant','soil_amendment','growth_regulator','other'));

-- 2. Applications: one row per field per pass
drop table if exists public.chemical_fertigation_details, public.chemical_spread_details,
                     public.chemical_spray_details cascade;
-- Replace the original product-lines table (only if it still has the old layout, so re-running keeps data)
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'chemical_event_products')
     and not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'chemical_event_products' and column_name = 'line_id') then
    drop table public.chemical_event_products cascade;
  end if;
end $$;

alter table public.chemical_events drop constraint if exists chemical_events_method_check;
update public.chemical_events set method = 'chemigation' where method = 'fertigation';
update public.chemical_events set method = 'spread' where method = 'dry_spread';
alter table public.chemical_events alter column method drop not null;
alter table public.chemical_events add constraint chemical_events_method_check
  check (method in ('spray','chemigation','spread','aerial','worked_in'));

alter table public.chemical_events add column if not exists status text not null default 'done';
alter table public.chemical_events drop constraint if exists chemical_events_status_check;
alter table public.chemical_events add constraint chemical_events_status_check check (status in ('planned','done'));
alter table public.chemical_events add column if not exists crop_year_id bigint references public.crop_years on delete set null;
alter table public.chemical_events add column if not exists crop_label text;          -- crop as written on the original record
alter table public.chemical_events add column if not exists carrier_gpa numeric(8,2); -- spray: gallons of water per acre
alter table public.chemical_events add column if not exists water_in numeric(6,2);    -- chemigation: inches of water
alter table public.chemical_events add column if not exists pivot_speed_pct numeric(5,1); -- chemigation: pivot speed, 100 = full speed
alter table public.chemical_events add column if not exists runtime_hr numeric(6,2);  -- chemigation: hours run
alter table public.chemical_events add column if not exists injection_gph numeric(8,2); -- chemigation: injection rate
alter table public.chemical_events add column if not exists base_solution text;       -- original carrier / base text
alter table public.chemical_events add column if not exists hours numeric(6,2);       -- hours to complete
alter table public.chemical_events add column if not exists legacy_id integer;        -- Access ProductApplicationsTable ID
create index if not exists chemical_events_date_idx on public.chemical_events (applied_on);

-- 3. Product lines: as many as needed per application
create table if not exists public.chemical_event_products (
  line_id      bigint generated always as identity primary key,
  event_id     bigint not null references public.chemical_events on delete cascade,
  chemical_id  bigint not null references public.chemicals,
  position     smallint not null default 1,
  rate         numeric(12,4),
  rate_unit    text,             -- oz, pt, qt, gal, lb, %
  rate_basis   text,             -- acre, 100gal, tank, total, volume
  tank_gal     numeric(8,1),     -- for "per tank" rates
  rate_text    text              -- the rate as originally written
);
create index if not exists cep_event_idx on public.chemical_event_products (event_id);
create index if not exists cep_chemical_idx on public.chemical_event_products (chemical_id);
alter table public.chemical_event_products enable row level security;
drop policy if exists "authenticated full access" on public.chemical_event_products;
create policy "authenticated full access" on public.chemical_event_products
  for all to authenticated using (true) with check (true);
