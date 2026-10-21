-- Crop history setup — run ONCE in the Supabase SQL Editor.

-- 1. Crops list (the dropdown). Edit it any time under Setup -> Crops.
create table if not exists public.crops (
  crop_id     bigint generated always as identity primary key,
  name        text not null unique,
  yield_unit  text,                       -- usual unit for harvest records: bu, ton, cwt, lb
  active      boolean not null default true
);
alter table public.crops enable row level security;
drop policy if exists "authenticated full access" on public.crops;
create policy "authenticated full access" on public.crops
  for all to authenticated using (true) with check (true);

insert into public.crops (name, yield_unit) values
  ('Alfalfa', 'ton'), ('Beans', 'cwt'), ('Corn', 'bu'), ('Grass seed', 'lb'),
  ('Onions', 'cwt'), ('Peas', 'lb'), ('Potatoes', 'cwt'), ('Wheat', 'bu')
on conflict (name) do nothing;

-- 2. Crop years point at the crops list instead of free text.
drop view if exists public.crop_year_summary;

alter table public.crop_years add column if not exists crop_id bigint references public.crops;
alter table public.crop_years add column if not exists acres numeric(8,2);   -- acres planted; blank = whole field

-- Carry over any crop names already typed in (normally none).
insert into public.crops (name)
  select distinct trim(crop) from public.crop_years where crop is not null and trim(crop) <> ''
on conflict (name) do nothing;
update public.crop_years cy set crop_id = c.crop_id
  from public.crops c where cy.crop_id is null and c.name = trim(cy.crop);

alter table public.crop_years drop column if exists crop;
alter table public.crop_years alter column crop_id set not null;
create index if not exists crop_years_field_idx on public.crop_years (field_id, season);

-- 3. Rebuild the summary view (harvest totals per crop year).
create view public.crop_year_summary with (security_invoker = true) as
select c.*,
       max(h.harvested_on) as last_harvest_date,
       sum(h.yield)        as total_yield,
       min(h.unit)         as yield_unit
from public.crop_years c
left join public.harvest_records h on h.crop_year_id = c.crop_year_id
group by c.crop_year_id;
