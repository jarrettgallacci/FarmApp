-- User roles and row rules (RLS). Safe to re-run.
-- Run this BEFORE money_tables.sql.
--
-- Roles (on profiles.role):
--   admin     the partners: everything, including assigning roles
--   manager   everything except assigning roles
--   employee  reads the farm's records; adds and edits work, repairs, scale tickets,
--             checklist ticks, water-change ticks, photos and bee logs; never deletes
--   none      new logins until an admin gives them a role: sees nothing
-- Plus profiles.can_apply ("licensed applicator"): an employee who can record the actual
-- application (start/stop, weather, acres, notes, done) on chemical records assigned to them
-- (performed_by = their operator, matched by operators.login_email). Never products or rates.
--
-- Every login that exists when this first runs becomes an admin (only the partners
-- have logins today). Logins created later start as 'none'.

-- 1. Role column
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'role') then
    alter table public.profiles add column role text;
    update public.profiles set role = 'admin';
  end if;
end $$;
update public.profiles set role = 'none' where role is null;
alter table public.profiles alter column role set default 'none';
alter table public.profiles alter column role set not null;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'manager', 'employee', 'none'));
alter table public.profiles add column if not exists can_apply boolean not null default false;

-- 2. Helpers used by the rules below. security definer so they can read profiles
--    without tripping profiles' own rules.
create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where user_id = auth.uid()), 'none')
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_role() = 'admin'
$$;
create or replace function public.is_staff()     -- admin or manager: can see money
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_role() in ('admin', 'manager')
$$;
create or replace function public.is_member()    -- anyone with a working role
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_role() in ('admin', 'manager', 'employee')
$$;
create or replace function public.my_operator_id()   -- the operator record linked to this login
returns bigint language sql stable security definer set search_path = public as $$
  select o.operator_id from public.operators o join public.profiles p on lower(trim(o.login_email)) = lower(p.email)
  where p.user_id = auth.uid() order by o.active desc, o.operator_id limit 1
$$;
create or replace function public.is_applicator()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_member() and coalesce((select can_apply from public.profiles where user_id = auth.uid()), false)
$$;

-- 3. Profiles: you see your own row (staff see all); only an admin changes roles;
--    the last admin can't be removed or demoted.
create or replace function public.guard_profile_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;   -- SQL editor / service key
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.email <> old.email then
      raise exception 'Login and email can''t be changed here';
    end if;
    if new.role <> old.role or new.can_apply <> old.can_apply then
      if not public.is_admin() then raise exception 'Only an admin can change roles'; end if;
      if old.role = 'admin' and (select count(*) from public.profiles where role = 'admin') <= 1 then
        raise exception 'There has to be at least one admin';
      end if;
    end if;
    return new;
  end if;
  if old.role = 'admin' and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'There has to be at least one admin';
  end if;
  return old;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update or delete on public.profiles
  for each row execute function public.guard_profile_change();

-- New logins always start with no access, whatever the insert says.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, role) values (new.id, new.email, 'none')
  on conflict (user_id) do nothing;
  return new;
end $$;

alter table public.profiles enable row level security;
drop policy if exists "authenticated full access" on public.profiles;
drop policy if exists "profiles: read" on public.profiles;
drop policy if exists "profiles: edit own or admin" on public.profiles;
drop policy if exists "profiles: admin delete" on public.profiles;
create policy "profiles: read" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_staff());
create policy "profiles: edit own or admin" on public.profiles for update to authenticated
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());
create policy "profiles: admin delete" on public.profiles for delete to authenticated
  using (public.is_admin());

-- 4. Farm tables. Three kinds:
--    read    : members read, staff add/edit/delete (setup lists, fields, crops, water, chemical, templates)
--    entry   : members read/add/edit, staff delete (day-to-day records employees fill in)
--    anything else in public (incl. tables added later and the money tables) : staff only
create or replace function public.apply_role_policies(t text, kind text)
returns void language plpgsql as $$
begin
  execute format('alter table public.%I enable row level security', t);
  execute format('drop policy if exists "authenticated full access" on public.%I', t);
  execute format('drop policy if exists "staff: all" on public.%I', t);
  execute format('drop policy if exists "members: read" on public.%I', t);
  execute format('drop policy if exists "members: add" on public.%I', t);
  execute format('drop policy if exists "members: edit" on public.%I', t);
  execute format('create policy "staff: all" on public.%I for all to authenticated using (public.is_staff()) with check (public.is_staff())', t);
  if kind in ('read', 'entry') then
    execute format('create policy "members: read" on public.%I for select to authenticated using (public.is_member())', t);
  end if;
  if kind = 'entry' then
    execute format('create policy "members: add" on public.%I for insert to authenticated with check (public.is_member())', t);
    execute format('create policy "members: edit" on public.%I for update to authenticated using (public.is_member()) with check (public.is_member())', t);
  end if;
end $$;
revoke execute on function public.apply_role_policies(text, text) from public, anon, authenticated;

do $$
declare
  t text;
  read_tables text[] := array[
    'ditch_riders', 'turnouts', 'fields', 'field_lineage', 'leases', 'crops', 'crop_years', 'operators',
    'operation_types', 'equipment', 'equipment_fields', 'equipment_work_types', 'customers',
    'chemicals', 'chemical_rotation_rules', 'chemical_events', 'chemical_event_products', 'chemical_loads',
    'water_orders', 'water_order_lines', 'water_order_subunits', 'water_events', 'irrigation_seasons',
    'procedures', 'procedure_steps', 'service_intervals',
    'bee_rooms', 'bee_lots', 'bee_plans', 'bee_run_plans', 'bee_incubation_runs', 'bee_run_lots',
    'bee_shelters', 'bee_storage'];
  entry_tables text[] := array[
    'work_events', 'planting_details', 'harvest_records', 'planter_cal_tests',
    'maint_jobs', 'maint_photos', 'maintenance_records', 'equipment_photos', 'equipment_nameplates',
    'procedure_runs', 'procedure_tasks', 'procedure_checks', 'procedure_step_notes', 'procedure_step_photos',
    'water_change_checks',
    'bee_room_readings', 'bee_run_events', 'bee_samples', 'bee_shelter_checks', 'bee_releases',
    'bee_recoveries', 'bee_placements', 'bee_fumigations'];
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'profiles' loop
    perform public.apply_role_policies(t,
      case when t = any(entry_tables) then 'entry' when t = any(read_tables) then 'read' else 'staff' end);
  end loop;
end $$;

-- Applicators record the actual application on chemical records assigned to them.
drop policy if exists "applicators: record assigned" on public.chemical_events;
create policy "applicators: record assigned" on public.chemical_events for update to authenticated
  using (public.is_applicator() and performed_by = public.my_operator_id())
  with check (public.is_applicator() and performed_by = public.my_operator_id());

create or replace function public.guard_applicator_edit()
returns trigger language plpgsql as $$
declare allowed text[] := array['status', 'applied_on', 'started_at', 'stopped_at', 'runtime_hr', 'hours',
  'acres_treated', 'water_in', 'wind_dir', 'wind_mph', 'wind_mph_max', 'gust_mph', 'temp_f', 'weather_source',
  'applied_by_names', 'notes', 'updated_at'];
begin
  if auth.uid() is null or public.is_staff() then return new; end if;
  if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
    raise exception 'Applicators can record the application but not change products, rates, field or method';
  end if;
  return new;
end $$;
drop trigger if exists chemical_events_applicator_guard on public.chemical_events;
create trigger chemical_events_applicator_guard before update on public.chemical_events
  for each row execute function public.guard_applicator_edit();

-- 5. Storage. Members read all three buckets; members upload to equipment and maintenance;
--    only staff upload labels, replace or delete files.
do $$ declare b text; begin
  foreach b in array array['equipment', 'maintenance', 'labels'] loop
    execute format('drop policy if exists "%s: signed-in read" on storage.objects', b);
    execute format('drop policy if exists "%s: signed-in write" on storage.objects', b);
    execute format('drop policy if exists "%s: signed-in update" on storage.objects', b);
    execute format('drop policy if exists "%s: signed-in delete" on storage.objects', b);
    execute format('drop policy if exists "%s: members read" on storage.objects', b);
    execute format('drop policy if exists "%s: upload" on storage.objects', b);
    execute format('drop policy if exists "%s: staff update" on storage.objects', b);
    execute format('drop policy if exists "%s: staff delete" on storage.objects', b);
    execute format('create policy "%s: members read" on storage.objects for select to authenticated using (bucket_id = %L and public.is_member())', b, b);
    execute format('create policy "%s: upload" on storage.objects for insert to authenticated with check (bucket_id = %L and %s)', b, b,
      case when b = 'labels' then 'public.is_staff()' else 'public.is_member()' end);
    execute format('create policy "%s: staff update" on storage.objects for update to authenticated using (bucket_id = %L and public.is_staff())', b, b);
    execute format('create policy "%s: staff delete" on storage.objects for delete to authenticated using (bucket_id = %L and public.is_staff())', b, b);
  end loop;
end $$;
