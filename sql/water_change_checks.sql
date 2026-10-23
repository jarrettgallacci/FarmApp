-- Dashboard: tick off a water change once it's been made in the field. Safe to re-run.
create table if not exists public.water_change_checks (
  order_id    bigint not null references public.water_orders on delete cascade,
  field_id    bigint not null references public.fields on delete cascade,
  checked_at  timestamptz not null default now(),
  checked_by  uuid default auth.uid(),
  primary key (order_id, field_id)
);
alter table public.water_change_checks enable row level security;
drop policy if exists "authenticated full access" on public.water_change_checks;
create policy "authenticated full access" on public.water_change_checks
  for all to authenticated using (true) with check (true);
