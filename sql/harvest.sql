-- Harvest: passes (swath/cut, merge/lift, combine/thresh) are work records with a stage;
-- yield lives on the crop: scale tickets ("in the dirt" lb) + estimated clean-out, later the settlement. Safe to re-run.

-- 1. Stage on harvest work records
alter table public.work_events add column if not exists harvest_stage text;
alter table public.work_events drop constraint if exists work_events_harvest_stage_check;
alter table public.work_events add constraint work_events_harvest_stage_check
  check (harvest_stage in ('swath', 'merge', 'thresh', 'other'));

-- 2. Scale tickets (one row per ticket; yield = in-the-dirt lb)
alter table public.harvest_records add column if not exists ticket_no text;
alter table public.harvest_records enable row level security;
drop policy if exists "authenticated full access" on public.harvest_records;
create policy "authenticated full access" on public.harvest_records
  for all to authenticated using (true) with check (true);

-- 3. Clean-out estimate and settlement on the crop
alter table public.crop_years add column if not exists est_cleanout_pct numeric(5,2);   -- expected clean ÷ dirt, %
alter table public.crop_years add column if not exists clean_lb numeric(12,1);          -- net clean lb from the settlement
alter table public.crop_years add column if not exists settled_on date;
alter table public.crop_years add column if not exists settlement_ref text;             -- lot / settlement number
alter table public.crop_years add column if not exists harvest_notes text;
