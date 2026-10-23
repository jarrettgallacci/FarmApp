-- Seasonal procedures, v3: a pump station's checklist carries a pivot section for each circle it serves,
-- so a tick is per step per pivot (sub_id = the pivot; 0 = the system itself). Safe to re-run.
alter table public.procedure_checks add column if not exists sub_id bigint not null default 0;
do $$ begin
  if exists (select 1 from information_schema.key_column_usage
             where table_schema = 'public' and table_name = 'procedure_checks' and constraint_name = 'procedure_checks_pkey' and column_name = 'sub_id') then return; end if;
  alter table public.procedure_checks drop constraint if exists procedure_checks_pkey;
  alter table public.procedure_checks add primary key (task_id, step_id, sub_id);
end $$;
