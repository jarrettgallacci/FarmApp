-- Seasonal procedures, v4: several photos per step per system. Safe to re-run. Run after procedures_v3.sql.
create table if not exists public.procedure_step_photos (
  photo_id      bigint generated always as identity primary key,
  step_id       bigint not null references public.procedure_steps on delete cascade,
  equipment_id  bigint references public.equipment on delete cascade,   -- the system it was taken for
  path          text not null,                                          -- 'maintenance' storage bucket
  taken_at      timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
create index if not exists procedure_step_photos_idx on public.procedure_step_photos (step_id, equipment_id);
alter table public.procedure_step_photos enable row level security;
drop policy if exists "authenticated full access" on public.procedure_step_photos;
create policy "authenticated full access" on public.procedure_step_photos
  for all to authenticated using (true) with check (true);

-- Move the one-photo-per-step-per-system photos already taken into the new table.
insert into public.procedure_step_photos (step_id, equipment_id, path)
select n.step_id, n.equipment_id, n.photo_path from public.procedure_step_notes n
where n.photo_path is not null
  and not exists (select 1 from public.procedure_step_photos p where p.path = n.photo_path);
update public.procedure_step_notes set photo_path = null where photo_path is not null;
delete from public.procedure_step_notes where note is null and photo_path is null and not skip;
