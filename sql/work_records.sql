-- Work records (tillage, planting, cultivation, harvest...) with planting details,
-- planter-band link to chemical records, and the sprayer on spray records. Safe to re-run.

-- 1. Work records: one per field per pass. Start/end dates for jobs that take more than a day.
alter table public.work_events add column if not exists end_date date;
alter table public.work_events add column if not exists tractor_id bigint references public.equipment;
alter table public.work_events add column if not exists crop_year_id bigint references public.crop_years on delete set null;
alter table public.work_events add column if not exists acres numeric(8,2);
-- equipment_id = the implement (planter, disk...) or self-propelled machine
alter table public.work_events enable row level security;
drop policy if exists "authenticated full access" on public.work_events;
create policy "authenticated full access" on public.work_events
  for all to authenticated using (true) with check (true);
create index if not exists work_events_crop_year_idx on public.work_events (crop_year_id);

-- 2. Planting details (one row per planting record)
alter table public.planting_details add column if not exists planting_label text;    -- e.g. Female, Male 1, Male 2 (staggered)
alter table public.planting_details add column if not exists seed_lot text;
alter table public.planting_details add column if not exists target_unit text;       -- 'lb/ac' or 'seeds/ac'
alter table public.planting_details add column if not exists seed_used numeric(12,2);
alter table public.planting_details add column if not exists seed_used_unit text;    -- 'lb' or 'seeds'
alter table public.planting_details add column if not exists row_spacing_in numeric(6,2);
alter table public.planting_details add column if not exists sprocket_1 text;
alter table public.planting_details add column if not exists sprocket_2 text;
alter table public.planting_details add column if not exists depth_in numeric(5,2);
alter table public.planting_details add column if not exists speed_mph numeric(5,2);
alter table public.planting_details add column if not exists seeds_per_3ft numeric(7,2);
-- seed_plate (existing) = seed plate (Monosem) or sponge set (Seed Spider)
alter table public.planting_details enable row level security;
drop policy if exists "authenticated full access" on public.planting_details;
create policy "authenticated full access" on public.planting_details
  for all to authenticated using (true) with check (true);

-- 3. Planter band: a chemical record made from a planting record
alter table public.chemical_events add column if not exists work_event_id bigint references public.work_events on delete set null;
alter table public.chemical_events drop constraint if exists chemical_events_method_check;
alter table public.chemical_events add constraint chemical_events_method_check
  check (method in ('spray','chemigation','spread','aerial','worked_in','planter_band'));

-- 4. Which sprayer did the job
alter table public.chemical_events add column if not exists sprayer_id bigint references public.equipment;
alter table public.chemical_loads add column if not exists sprayer_id bigint references public.equipment;
