-- Multi-year stands, ground leased out, and "last watered" — run ONCE in the Supabase SQL Editor.

-- 1. Multi-year crops ------------------------------------------------------
-- crops.multi_year: the crop usually stays in more than one season (sets the default on the form).
alter table public.crops add column if not exists multi_year boolean not null default false;
update public.crops set multi_year = true where name in ('Alfalfa', 'Grass seed');

-- crop_years.multi_year: this planting is a stand that carries into later seasons.
-- end_season: last season it was in the field. Blank = still in.
alter table public.crop_years add column if not exists multi_year boolean not null default false;
alter table public.crop_years add column if not exists end_season smallint;
alter table public.crop_years drop constraint if exists crop_years_end_after_start;
alter table public.crop_years add constraint crop_years_end_after_start
  check (end_season is null or end_season >= season);

-- 2. Ground leased out to someone else -------------------------------------
-- grown_by: who farmed it when it wasn't us (blank = we did).
alter table public.crop_years add column if not exists grown_by text;

alter table public.leases drop constraint if exists leases_agreement_type_check;
alter table public.leases add constraint leases_agreement_type_check
  check (agreement_type in ('lease', 'partnership', 'leased_out'));

-- The summary view lists crop_years columns, so rebuild it to pick up the new ones.
drop view if exists public.crop_year_summary;
create view public.crop_year_summary with (security_invoker = true) as
select c.*,
       max(h.harvested_on) as last_harvest_date,
       sum(h.yield)        as total_yield,
       min(h.unit)         as yield_unit
from public.crop_years c
left join public.harvest_records h on h.crop_year_id = c.crop_year_id
group by c.crop_year_id;

-- 3. Last watered, from sent water orders ----------------------------------
-- For every field (and split half): is it on today, since when, and the last
-- day water ran on it. Only orders dated today (farm time) or earlier count.
create or replace view public.field_water_status with (security_invoker = true) as
with o as (
  select order_id, order_date,
         lead(order_date) over (order by order_date) as next_date
  from public.water_orders
  where status <> 'draft'
),
marks as (
  select l.field_id, o.order_date, o.next_date, l.is_on
  from o join public.water_order_lines l on l.order_id = o.order_id
  union all
  select s.subunit_field_id, o.order_date, o.next_date, s.watered
  from o join public.water_order_subunits s on s.order_id = o.order_id
),
past as (
  select * from marks where order_date <= (now() at time zone 'America/Los_Angeles')::date
),
latest as (
  select distinct on (field_id) field_id, is_on as running
  from past order by field_id, order_date desc
),
last_off as (
  select field_id, max(order_date) as d from past where not is_on group by field_id
),
last_on as (
  select field_id, max(order_date) as d from past where is_on group by field_id
)
select f.field_id,
       coalesce(l.running, false) as running_now,
       case when l.running then (
         select min(p.order_date) from past p
         where p.field_id = f.field_id and p.is_on
           and p.order_date > coalesce(lf.d, '-infinity'::date)
       ) end as running_since,
       case when l.running then (now() at time zone 'America/Los_Angeles')::date else (
         select least(coalesce(p.next_date - 1, (now() at time zone 'America/Los_Angeles')::date), (now() at time zone 'America/Los_Angeles')::date) from past p
         where p.field_id = f.field_id and p.order_date = lo.d
       ) end as last_watered
from public.fields f
left join latest   l  on l.field_id  = f.field_id
left join last_off lf on lf.field_id = f.field_id
left join last_on  lo on lo.field_id = f.field_id;
