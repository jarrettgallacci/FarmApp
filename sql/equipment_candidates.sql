-- Machines from the old Access database waiting to be reviewed in the app
-- (Setup → Equipment → Review and import). Data is loaded separately.
create table if not exists public.equipment_candidates (
  cand_id     bigint generated always as identity primary key,
  old_id      integer unique,          -- Access MachineryID
  grp         text not null,           -- 'self' | 'implement' | 'pivot'
  sort_order  integer,
  name        text not null,
  type        text,
  make        text,
  model       text,
  serial_no   text,
  notes       text,
  status      text check (status in ('imported', 'dismissed'))
);
alter table public.equipment_candidates enable row level security;
drop policy if exists "authenticated full access" on public.equipment_candidates;
create policy "authenticated full access" on public.equipment_candidates
  for all to authenticated using (true) with check (true);
