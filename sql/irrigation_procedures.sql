-- Irrigation equipment linked to fields, and seasonal procedures (startup / shutdown checklists). Safe to re-run.
-- Run after maintenance.sql.

-- 1. Which fields a pivot / pump / well serves (a pump can serve several fields; 84/85 Big covers two)
create table if not exists public.equipment_fields (
  equipment_id  bigint not null references public.equipment on delete cascade,
  field_id      bigint not null references public.fields on delete cascade,
  primary key (equipment_id, field_id)
);
create index if not exists equipment_fields_field_idx on public.equipment_fields (field_id);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment' and column_name = 'field_id') then
    insert into public.equipment_fields (equipment_id, field_id)
      select equipment_id, field_id from public.equipment where field_id is not null on conflict do nothing;
    alter table public.equipment drop column field_id;
  end if;
end $$;

-- 2. Procedures: a checklist template ("Pivot fall shutdown"). Steps with no equipment are shared;
--    steps with an equipment_id are extra steps for that one system only.
create table if not exists public.procedures (
  procedure_id  bigint generated always as identity primary key,
  name          text not null,
  kind          text not null default 'other' check (kind in ('startup', 'shutdown', 'other')),
  applies_to    text not null default 'pivots',     -- pivots, pumps, wells (mainlines & wells), irrigation, all
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create table if not exists public.procedure_steps (
  step_id       bigint generated always as identity primary key,
  procedure_id  bigint not null references public.procedures on delete cascade,
  equipment_id  bigint references public.equipment on delete cascade,   -- null = every system
  position      integer not null default 0,
  text          text not null,
  photo_path    text,                                                    -- 'maintenance' storage bucket
  active        boolean not null default true
);
create index if not exists procedure_steps_proc_idx on public.procedure_steps (procedure_id);

-- 3. A round: run a procedure across systems for a season; one task per system.
create table if not exists public.procedure_runs (
  run_id        bigint generated always as identity primary key,
  procedure_id  bigint not null references public.procedures,
  season        smallint not null,
  started_on    date not null default current_date,
  due_on        date,
  notes         text,
  created_at    timestamptz not null default now()
);
create table if not exists public.procedure_tasks (
  task_id       bigint generated always as identity primary key,
  run_id        bigint not null references public.procedure_runs on delete cascade,
  equipment_id  bigint not null references public.equipment,
  assigned_to   bigint references public.operators,
  status        text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  completed_on  date,
  notes         text,
  unique (run_id, equipment_id)
);
create table if not exists public.procedure_checks (
  task_id       bigint not null references public.procedure_tasks on delete cascade,
  step_id       bigint not null references public.procedure_steps on delete cascade,
  done_at       timestamptz not null default now(),
  done_by       uuid default auth.uid(),
  done_by_name  text,
  primary key (task_id, step_id)
);

do $$ declare t text; begin
  foreach t in array array['equipment_fields', 'procedures', 'procedure_steps', 'procedure_runs', 'procedure_tasks', 'procedure_checks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "authenticated full access" on public.%I', t);
    execute format('create policy "authenticated full access" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- 4. Link a person to their app login (by sign-in email) so "My tasks" works.
alter table public.operators add column if not exists login_email text;

-- 5. Deleting a field also removes its equipment links.
create or replace function public.delete_field_everywhere(p_field bigint)
returns void language plpgsql security invoker as $$
declare h bigint;
begin
  for h in select field_id from public.fields where parent_field_id = p_field loop
    perform public.delete_field_everywhere(h);
  end loop;
  delete from public.water_order_lines     where field_id = p_field;
  delete from public.water_order_subunits  where subunit_field_id = p_field;
  delete from public.water_events          where field_id = p_field;
  delete from public.chemical_events       where field_id = p_field;
  delete from public.planting_details      where crop_year_id in (select crop_year_id from public.crop_years where field_id = p_field);
  delete from public.crop_years            where field_id = p_field;
  delete from public.planting_details      where event_id in (select event_id from public.work_events where field_id = p_field);
  delete from public.work_events           where field_id = p_field;
  delete from public.maintenance_records   where field_id = p_field;
  delete from public.equipment_fields      where field_id = p_field;
  delete from public.leases                where field_id = p_field;
  delete from public.field_lineage         where field_id = p_field or predecessor_id = p_field;
  delete from public.fields                where field_id = p_field;
end $$;
