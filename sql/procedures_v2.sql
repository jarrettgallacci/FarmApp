-- Seasonal procedures, v2: one procedure covers pump stations, pivots and solid sets, each with its own steps;
-- notes, photos and "not on this system" on a step for one system. Safe to re-run. Run after irrigation_procedures.sql.
alter table public.procedure_steps add column if not exists system_type text;   -- pumps, pivots, solid_sets, wells; blank = every system
alter table public.procedure_steps drop constraint if exists procedure_steps_system_type_check;
alter table public.procedure_steps add constraint procedure_steps_system_type_check
  check (system_type in ('pumps', 'pivots', 'solid_sets', 'wells'));

create table if not exists public.procedure_step_notes (
  step_id       bigint not null references public.procedure_steps on delete cascade,
  equipment_id  bigint not null references public.equipment on delete cascade,
  note          text,
  photo_path    text,                      -- photo for this system ('maintenance' bucket)
  skip          boolean not null default false,   -- step doesn't apply to this system
  primary key (step_id, equipment_id)
);
alter table public.procedure_step_notes alter column note drop not null;
alter table public.procedure_step_notes add column if not exists photo_path text;
alter table public.procedure_step_notes add column if not exists skip boolean not null default false;
alter table public.procedure_step_notes enable row level security;
drop policy if exists "authenticated full access" on public.procedure_step_notes;
create policy "authenticated full access" on public.procedure_step_notes
  for all to authenticated using (true) with check (true);
