-- Maintenance & repair: service intervals (hours and/or months), repair/service jobs with status,
-- problem and invoice photos. Pivots, pumps, wells, mainlines and buildings are added as equipment
-- (type Pivot, Pump, Well, Mainline, Building) so everything shares one list. Safe to re-run.

-- 1. (Fields a pivot / pump serves: see irrigation_procedures.sql)

-- 2. Service intervals: "Engine oil & filter every 500 hrs", "Gearbox oil every 12 months"
create table if not exists public.service_intervals (
  interval_id   bigint generated always as identity primary key,
  equipment_id  bigint not null references public.equipment on delete cascade,
  name          text not null,
  every_hours   numeric(8,1),
  every_months  smallint,
  start_hours   numeric(10,1),          -- hours when last done before tracking began (first due = this + every_hours)
  start_date    date default current_date,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  check (every_hours is not null or every_months is not null)
);
create index if not exists service_intervals_eq_idx on public.service_intervals (equipment_id);

-- 3. Jobs: a reported problem (repair) or a completed service, with status
create table if not exists public.maint_jobs (
  job_id        bigint generated always as identity primary key,
  equipment_id  bigint not null references public.equipment,
  kind          text not null default 'repair' check (kind in ('repair', 'service')),
  interval_id   bigint references public.service_intervals on delete set null,
  status        text not null default 'open' check (status in ('open', 'in_progress', 'done')),
  down          boolean not null default false,       -- machine can't be used
  title         text not null,
  description   text,
  reported_by   bigint references public.operators,
  reported_on   date not null default current_date,
  completed_on  date,
  done_by       text,                                 -- who fixed it (shop, dealer, person)
  hours_at      numeric(10,1),                        -- machine hours when done
  cost          numeric(10,2),
  vendor        text,
  invoice_no    text,
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists maint_jobs_eq_idx on public.maint_jobs (equipment_id);
create index if not exists maint_jobs_status_idx on public.maint_jobs (status);

create table if not exists public.maint_photos (
  photo_id   bigint generated always as identity primary key,
  job_id     bigint not null references public.maint_jobs on delete cascade,
  path       text not null,                           -- file in the 'maintenance' storage bucket
  kind       text not null default 'problem' check (kind in ('problem', 'invoice')),
  taken_at   timestamptz not null default now()
);
create index if not exists maint_photos_job_idx on public.maint_photos (job_id);

do $$ declare t text; begin
  foreach t in array array['service_intervals', 'maint_jobs', 'maint_photos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "authenticated full access" on public.%I', t);
    execute format('create policy "authenticated full access" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- 4. Private photo storage
insert into storage.buckets (id, name, public) values ('maintenance', 'maintenance', false)
on conflict (id) do nothing;
drop policy if exists "maintenance: signed-in read" on storage.objects;
drop policy if exists "maintenance: signed-in write" on storage.objects;
drop policy if exists "maintenance: signed-in delete" on storage.objects;
create policy "maintenance: signed-in read"   on storage.objects for select to authenticated using (bucket_id = 'maintenance');
create policy "maintenance: signed-in write"  on storage.objects for insert to authenticated with check (bucket_id = 'maintenance');
create policy "maintenance: signed-in delete" on storage.objects for delete to authenticated using (bucket_id = 'maintenance');

-- 5. Fix: deleting a field set old maintenance rows' field to blank, which that table doesn't allow.
--    Those (unused) rows are now removed with the field instead.
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
  delete from public.leases                where field_id = p_field;
  delete from public.field_lineage         where field_id = p_field or predecessor_id = p_field;
  delete from public.fields                where field_id = p_field;
end $$;
