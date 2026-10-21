-- Crop plan, isolation and contracts on crop years.

-- Planned = on the crop plan, not in the ground yet. Planted = actually grown.
alter table public.crop_years add column if not exists status text not null default 'planted';
alter table public.crop_years drop constraint if exists crop_years_status_check;
alter table public.crop_years add constraint crop_years_status_check check (status in ('planned', 'planted'));

-- Isolation required around this crop, if any (stored in feet).
alter table public.crop_years add column if not exists isolation_ft numeric(10,1);

-- Contract details (for planted crops).
alter table public.crop_years add column if not exists contract_company  text;
alter table public.crop_years add column if not exists contract_number   text;
alter table public.crop_years add column if not exists contract_price    numeric(12,4);
alter table public.crop_years add column if not exists contract_bonus    numeric(12,4);
alter table public.crop_years add column if not exists contract_unit     text;        -- price per: lb, bu, ton, cwt
alter table public.crop_years add column if not exists contract_minimum  numeric(14,2);
alter table public.crop_years add column if not exists contract_overage  text;

-- Rebuild the summary view so it includes the new columns.
drop view if exists public.crop_year_summary;
create view public.crop_year_summary with (security_invoker = true) as
select c.*,
       max(h.harvested_on) as last_harvest_date,
       sum(h.yield)        as total_yield,
       min(h.unit)         as yield_unit
from public.crop_years c
left join public.harvest_records h on h.crop_year_id = c.crop_year_id
group by c.crop_year_id;
