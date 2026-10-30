-- Seasonal tasks: steps that repeat for each tower of a pivot, photos per round, and repairs logged from a step.
-- Run BEFORE deploying the matching app.js. Safe to run more than once.

-- A pivot step can repeat once per tower (and the corner arm).
alter table public.procedure_steps add column if not exists per_tower boolean not null default false;

-- A tick is per step, per pivot section (sub_id) and per tower (0 = not a tower step).
alter table public.procedure_checks add column if not exists tower smallint not null default 0;
do $$ begin
  if exists (select 1 from information_schema.key_column_usage
             where table_schema = 'public' and table_name = 'procedure_checks' and constraint_name = 'procedure_checks_pkey' and column_name = 'tower') then return; end if;
  alter table public.procedure_checks drop constraint if exists procedure_checks_pkey;
  alter table public.procedure_checks add primary key (task_id, step_id, sub_id, tower);
end $$;

-- Photos taken on a round belong to that round (and tower); older photos keep task_id null.
alter table public.procedure_step_photos add column if not exists task_id bigint references public.procedure_tasks on delete cascade;
alter table public.procedure_step_photos add column if not exists tower smallint not null default 0;

-- A repair logged from a checklist step remembers where it came from.
alter table public.maint_jobs add column if not exists task_id bigint references public.procedure_tasks on delete set null;
alter table public.maint_jobs add column if not exists step_id bigint references public.procedure_steps on delete set null;
alter table public.maint_jobs add column if not exists tower   smallint;
create index if not exists maint_jobs_task_idx on public.maint_jobs (task_id);
