-- Money tables: every dollar figure lives here, readable only by admins and managers.
-- Needs user_roles.sql run first. Safe to re-run.
--
-- What moves where (old columns are copied, then emptied; dropping them is a later file):
--   operation_types.cost_per_acre, equipment.cost_per_acre,
--   application_rates, customers.default_rate          -> rates (the one rate card)
--   work_events.cost_* and custom_rate/custom_total      -> work_costs (filled by the database on save)
--   chemical_events.app_cost_*                           -> chemical_costs (filled by the database on save)
--   crop_years.contract_*                                -> contracts + contract_crop_years
--   equipment.purchase_price                             -> equipment_finance
--   leases.rate, leases.rate_basis                       -> lease_terms
--   maint_jobs.cost                                      -> maint_job_costs
--   bee_lots.cost                                        -> bee_lot_costs

-- 1. The rate card: $/acre by work type, machine (overrides the work type or method),
--    application method, and custom-work customer.
create table if not exists public.rates (
  kind          text not null check (kind in ('work_type', 'equipment', 'method', 'customer')),
  ref           text not null,            -- operation / equipment_id / method / customer_id
  cost_per_acre numeric(10,2),
  updated_at    timestamptz not null default now(),
  primary key (kind, ref)
);

-- 2. Frozen costs on records
create table if not exists public.work_costs (
  event_id      bigint primary key references public.work_events on delete cascade,
  cost_per_acre numeric(10,2),
  cost_total    numeric(12,2),
  cost_basis    text,                     -- where the rate came from
  custom_rate   numeric(10,2),            -- $/acre charged on custom work
  custom_total  numeric(12,2),
  updated_at    timestamptz not null default now()
);
create table if not exists public.chemical_costs (
  event_id          bigint primary key references public.chemical_events on delete cascade,
  app_cost_per_acre numeric(10,2),
  app_cost_basis    text,
  updated_at        timestamptz not null default now()
);

-- 3. Contracts, linked to the crop years (fields) they cover
create table if not exists public.contracts (
  contract_id     bigint generated always as identity primary key,
  company         text,
  contract_number text,
  crop_id         bigint references public.crops,
  season          smallint,
  price           numeric(12,4),
  bonus           numeric(12,4),
  unit            text,                   -- price per: lb, bu, cwt, ton, acre
  minimum         numeric(14,2),
  overage         text,
  notes           text,
  created_at      timestamptz not null default now()
);
create table if not exists public.contract_crop_years (
  contract_id  bigint not null references public.contracts on delete cascade,
  crop_year_id bigint not null references public.crop_years on delete cascade,
  primary key (contract_id, crop_year_id)
);
create index if not exists contract_crop_years_cy on public.contract_crop_years (crop_year_id);

-- 4. Other money, one row per parent record
create table if not exists public.equipment_finance (
  equipment_id   bigint primary key references public.equipment on delete cascade,
  purchase_price numeric(12,2)
);
create table if not exists public.lease_terms (
  lease_id   bigint primary key references public.leases on delete cascade,
  rate       numeric(10,2),
  rate_basis text                         -- per acre, flat, crop share
);
create table if not exists public.maint_job_costs (
  job_id bigint primary key references public.maint_jobs on delete cascade,
  cost   numeric(10,2)
);
create table if not exists public.bee_lot_costs (
  lot_id bigint primary key references public.bee_lots on delete cascade,
  cost   numeric(12,2)
);

-- Staff only (apply_role_policies comes from user_roles.sql)
do $$ declare t text; begin
  foreach t in array array['rates', 'work_costs', 'chemical_costs', 'contracts', 'contract_crop_years',
                           'equipment_finance', 'lease_terms', 'maint_job_costs', 'bee_lot_costs'] loop
    perform public.apply_role_policies(t, 'staff');
  end loop;
end $$;

-- 5. Copy what's in the old columns, then empty them so employees can't read them.
insert into public.rates (kind, ref, cost_per_acre)
  select 'work_type', operation, cost_per_acre from public.operation_types where cost_per_acre is not null
  on conflict do nothing;
insert into public.rates (kind, ref, cost_per_acre)
  select 'equipment', equipment_id::text, cost_per_acre from public.equipment where cost_per_acre is not null
  on conflict do nothing;
insert into public.rates (kind, ref, cost_per_acre)
  select 'method', method, cost_per_acre from public.application_rates where cost_per_acre is not null
  on conflict do nothing;
insert into public.rates (kind, ref, cost_per_acre)
  select 'customer', customer_id::text, default_rate from public.customers where default_rate is not null
  on conflict do nothing;
update public.operation_types set cost_per_acre = null where cost_per_acre is not null;
update public.equipment set cost_per_acre = null where cost_per_acre is not null;
update public.application_rates set cost_per_acre = null where cost_per_acre is not null;
update public.customers set default_rate = null where default_rate is not null;

insert into public.work_costs (event_id, cost_per_acre, cost_total, cost_basis, custom_rate, custom_total)
  select event_id, cost_per_acre, cost_total, cost_basis, custom_rate, custom_total from public.work_events
  where coalesce(cost_per_acre, cost_total, custom_rate, custom_total) is not null or cost_basis is not null
  on conflict do nothing;
insert into public.chemical_costs (event_id, app_cost_per_acre, app_cost_basis)
  select event_id, app_cost_per_acre, app_cost_basis from public.chemical_events
  where app_cost_per_acre is not null or app_cost_basis is not null
  on conflict do nothing;

do $$
declare c record; new_id bigint;
begin
  for c in select * from public.crop_years
           where coalesce(contract_company, contract_number, contract_unit, contract_overage) is not null
              or coalesce(contract_price, contract_bonus, contract_minimum) is not null loop
    insert into public.contracts (company, contract_number, crop_id, season, price, bonus, unit, minimum, overage)
      values (c.contract_company, c.contract_number, c.crop_id, c.season, c.contract_price, c.contract_bonus,
              c.contract_unit, c.contract_minimum, c.contract_overage)
      returning contract_id into new_id;
    insert into public.contract_crop_years (contract_id, crop_year_id) values (new_id, c.crop_year_id);
    update public.crop_years set contract_company = null, contract_number = null, contract_price = null,
      contract_bonus = null, contract_unit = null, contract_minimum = null, contract_overage = null
      where crop_year_id = c.crop_year_id;
  end loop;
end $$;

insert into public.equipment_finance (equipment_id, purchase_price)
  select equipment_id, purchase_price from public.equipment where purchase_price is not null on conflict do nothing;
insert into public.lease_terms (lease_id, rate, rate_basis)
  select lease_id, rate, rate_basis from public.leases where rate is not null or rate_basis is not null on conflict do nothing;
insert into public.maint_job_costs (job_id, cost)
  select job_id, cost from public.maint_jobs where cost is not null on conflict do nothing;
insert into public.bee_lot_costs (lot_id, cost)
  select lot_id, cost from public.bee_lots where cost is not null on conflict do nothing;

update public.work_events set cost_per_acre = null, cost_total = null, cost_basis = null, custom_rate = null, custom_total = null
  where coalesce(cost_per_acre, cost_total, custom_rate, custom_total) is not null or cost_basis is not null;
update public.chemical_events set app_cost_per_acre = null, app_cost_basis = null
  where app_cost_per_acre is not null or app_cost_basis is not null;
update public.equipment set purchase_price = null where purchase_price is not null;
update public.leases set rate = null, rate_basis = null where rate is not null or rate_basis is not null;
update public.maint_jobs set cost = null where cost is not null;
update public.bee_lots set cost = null where cost is not null;

-- 6. Costs are worked out by the database when a record is saved, so an employee's
--    phone never needs the rates. Machine rate first, then the work type's / method's.
create or replace function public.rate_for(p_kind text, p_ref text)
returns numeric language sql stable security definer set search_path = public as $$
  select cost_per_acre from public.rates where kind = p_kind and ref = p_ref
$$;
revoke execute on function public.rate_for(text, text) from public, anon, authenticated;

create or replace function public.price_work_event(p_event bigint)
returns void language plpgsql security definer set search_path = public as $$
declare w record; r numeric; basis text; cr numeric;
begin
  select * into w from public.work_events where event_id = p_event;
  if not found then return; end if;
  r := public.rate_for('equipment', w.equipment_id::text);
  if r is not null then basis := (select name from public.equipment where equipment_id = w.equipment_id);
  else
    r := public.rate_for('work_type', w.operation);
    if r is not null then basis := initcap(replace(w.operation, '_', ' ')) || ' rate'; end if;
  end if;
  insert into public.work_costs as c (event_id, cost_per_acre, cost_basis, cost_total)
    values (p_event, r, basis, case when r is not null and w.acres is not null then round(r * w.acres, 2) end)
  on conflict (event_id) do update set cost_per_acre = excluded.cost_per_acre, cost_basis = excluded.cost_basis,
    cost_total = excluded.cost_total, updated_at = now();
  -- Custom work: default the charge from the customer's rate; keep the total in step with acres.
  if w.customer_id is null then
    update public.work_costs set custom_rate = null, custom_total = null where event_id = p_event and custom_rate is not null;
  else
    select custom_rate into cr from public.work_costs where event_id = p_event;
    cr := coalesce(cr, public.rate_for('customer', w.customer_id::text));
    update public.work_costs set custom_rate = cr,
      custom_total = case when cr is not null and w.acres is not null then round(cr * w.acres, 2) end
      where event_id = p_event;
  end if;
end $$;
revoke execute on function public.price_work_event(bigint) from public, anon, authenticated;

create or replace function public.price_chemical_event(p_event bigint)
returns void language plpgsql security definer set search_path = public as $$
declare e record; r numeric; basis text;
begin
  select * into e from public.chemical_events where event_id = p_event;
  if not found then return; end if;
  if e.split_of is not null then
    basis := 'split';   -- the first record of a split tank mix carries the cost
  else
    if e.method = 'spray' then r := public.rate_for('equipment', e.sprayer_id::text); end if;
    if r is not null then basis := (select name from public.equipment where equipment_id = e.sprayer_id);
    else
      r := public.rate_for('method', e.method);
      if r is not null then basis := initcap(replace(e.method, '_', ' ')) || ' rate'; end if;
    end if;
  end if;
  insert into public.chemical_costs (event_id, app_cost_per_acre, app_cost_basis) values (p_event, r, basis)
  on conflict (event_id) do update set app_cost_per_acre = excluded.app_cost_per_acre,
    app_cost_basis = excluded.app_cost_basis, updated_at = now();
end $$;
revoke execute on function public.price_chemical_event(bigint) from public, anon, authenticated;

create or replace function public.work_events_price()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.price_work_event(new.event_id);
  return null;
end $$;
drop trigger if exists work_events_price on public.work_events;
create trigger work_events_price after insert or update of operation, equipment_id, acres, customer_id
  on public.work_events for each row execute function public.work_events_price();

create or replace function public.chemical_events_price()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.price_chemical_event(new.event_id);
  return null;
end $$;
drop trigger if exists chemical_events_price on public.chemical_events;
create trigger chemical_events_price after insert or update of method, sprayer_id, split_of
  on public.chemical_events for each row execute function public.chemical_events_price();

-- Custom charge: keep the total = rate × acres, whoever sets the rate.
create or replace function public.work_costs_custom_total()
returns trigger language plpgsql security definer set search_path = public as $$
declare ac numeric;
begin
  select acres into ac from public.work_events where event_id = new.event_id;
  new.custom_total := case when new.custom_rate is not null and ac is not null then round(new.custom_rate * ac, 2) end;
  return new;
end $$;
drop trigger if exists work_costs_custom_total on public.work_costs;
create trigger work_costs_custom_total before insert or update
  on public.work_costs for each row execute function public.work_costs_custom_total();

-- 7. Re-price records in a date range with today's rates (staff only; Setup → Cost rates).
create or replace function public.reprice_costs(p_from date, p_to date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; id bigint;
begin
  if not public.is_staff() then raise exception 'Only admins and managers can re-price'; end if;
  for id in select event_id from public.work_events where performed_on between p_from and p_to loop
    perform public.price_work_event(id); n := n + 1;
  end loop;
  for id in select event_id from public.chemical_events where applied_on between p_from and p_to loop
    perform public.price_chemical_event(id); n := n + 1;
  end loop;
  return n;
end $$;
