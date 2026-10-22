-- Per-acre cost rates (set once) and frozen costs on records. Safe to re-run.
-- Cost = implement/machine override if it has one, otherwise the work type's rate.
-- The rate is copied onto each record when it's saved, so changing a rate later doesn't rewrite history.

-- 1. Rates
alter table public.operation_types add column if not exists cost_per_acre numeric(10,2);
alter table public.equipment add column if not exists cost_per_acre numeric(10,2);   -- override when this machine is used

create table if not exists public.application_rates (
  method        text primary key,          -- spray, chemigation, spread, aerial, worked_in, planter_band
  cost_per_acre numeric(10,2)
);
alter table public.application_rates enable row level security;
drop policy if exists "authenticated full access" on public.application_rates;
create policy "authenticated full access" on public.application_rates
  for all to authenticated using (true) with check (true);
insert into public.application_rates (method) values
  ('spray'), ('chemigation'), ('spread'), ('aerial'), ('worked_in'), ('planter_band')
on conflict (method) do nothing;

-- 2. Frozen costs on records
alter table public.work_events add column if not exists cost_per_acre numeric(10,2);
alter table public.work_events add column if not exists cost_total numeric(12,2);
alter table public.work_events add column if not exists cost_basis text;           -- where the rate came from
alter table public.chemical_events add column if not exists app_cost_per_acre numeric(10,2);
alter table public.chemical_events add column if not exists app_cost_basis text;

-- crop_year_id on non-planting work records now means "charged to this crop" (manual choice).
-- Blank = automatic: tillage goes to the next crop planted in the field, everything else to the crop standing in it.
