-- Display order for the water order screen — run ONCE in the Supabase SQL Editor.
-- Adds a sort_order to riders, turnouts and fields, and starts them in
-- number order (75A before 107B). Rearrange afterwards with the Arrange button.

alter table public.ditch_riders add column if not exists sort_order integer;
alter table public.turnouts     add column if not exists sort_order integer;
alter table public.fields       add column if not exists sort_order integer;

update public.ditch_riders r set sort_order = x.n * 10
from (select rider_id, row_number() over (order by name) as n from public.ditch_riders) x
where x.rider_id = r.rider_id;

update public.turnouts t set sort_order = x.n * 10
from (select turnout_id,
             row_number() over (order by substring(name from '^\d+')::int nulls last, name) as n
      from public.turnouts) x
where x.turnout_id = t.turnout_id;

update public.fields f set sort_order = x.n * 10
from (select field_id,
             row_number() over (order by substring(name from '^\d+')::int nulls last, name) as n
      from public.fields) x
where x.field_id = f.field_id;
