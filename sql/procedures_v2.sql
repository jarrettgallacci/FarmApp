-- Seasonal procedures, v2: one procedure covers pump stations, pivots and solid sets, each with its own steps;
-- notes on a step for one system ("this station has wooden plugs"). Safe to re-run. Run after irrigation_procedures.sql.
alter table public.procedure_steps add column if not exists system_type text;   -- pumps, pivots, solid_sets, wells; blank = every system
alter table public.procedure_steps drop constraint if exists procedure_steps_system_type_check;
alter table public.procedure_steps add constraint procedure_steps_system_type_check
  check (system_type in ('pumps', 'pivots', 'solid_sets', 'wells'));

create table if not exists public.procedure_step_notes (
  step_id       bigint not null references public.procedure_steps on delete cascade,
  equipment_id  bigint not null references public.equipment on delete cascade,
  note          text not null,
  primary key (step_id, equipment_id)
);
alter table public.procedure_step_notes enable row level security;
drop policy if exists "authenticated full access" on public.procedure_step_notes;
create policy "authenticated full access" on public.procedure_step_notes
  for all to authenticated using (true) with check (true);
