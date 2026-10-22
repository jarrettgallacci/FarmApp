-- Work types (tillage, planting, cultivation, harvest, other...) and which equipment can do each.
-- Safe to re-run.
alter table public.operation_types add column if not exists sort_order integer;
insert into public.operation_types (operation) values ('tillage'), ('planting'), ('cultivating'), ('harvest'), ('other')
on conflict (operation) do nothing;
update public.operation_types set sort_order = case operation
  when 'tillage' then 10 when 'planting' then 20 when 'cultivating' then 30 when 'harvest' then 40 when 'other' then 90 else coalesce(sort_order, 50) end
where sort_order is null;
alter table public.operation_types enable row level security;
drop policy if exists "authenticated full access" on public.operation_types;
create policy "authenticated full access" on public.operation_types
  for all to authenticated using (true) with check (true);

create table if not exists public.equipment_work_types (
  equipment_id  bigint not null references public.equipment on delete cascade,
  operation     text not null references public.operation_types on update cascade on delete cascade,
  primary key (equipment_id, operation)
);
alter table public.equipment_work_types enable row level security;
drop policy if exists "authenticated full access" on public.equipment_work_types;
create policy "authenticated full access" on public.equipment_work_types
  for all to authenticated using (true) with check (true);

-- Starting tags by equipment type (only for equipment that has no tags yet). Adjust in the app.
insert into public.equipment_work_types (equipment_id, operation)
select e.equipment_id, t.op
from public.equipment e
join (values
  ('tractor', 'tillage'), ('tractor', 'planting'), ('tractor', 'cultivating'),
  ('combine', 'harvest'), ('swather / windrower', 'harvest'), ('bean cutter', 'harvest'),
  ('planter', 'planting'), ('drill', 'planting'),
  ('disk', 'tillage'), ('disk ripper', 'tillage'), ('plough', 'tillage'), ('packer', 'tillage'), ('shredder', 'tillage'),
  ('rototiller', 'tillage'), ('rototiller', 'cultivating'),
  ('cultivator', 'cultivating'), ('toolbar', 'cultivating'), ('corrugator', 'cultivating'),
  ('dammer-diker', 'cultivating'), ('skewtreader', 'cultivating'),
  ('trailer', 'other')
) t(type, op) on lower(e.type) = t.type
where not exists (select 1 from public.equipment_work_types x where x.equipment_id = e.equipment_id)
on conflict do nothing;

select o.operation, count(x.equipment_id) as equipment
from public.operation_types o left join public.equipment_work_types x using (operation)
group by o.operation, o.sort_order order by o.sort_order;
