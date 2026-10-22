-- Equipment photos (private storage) and a "last checked" date for walk-arounds. Safe to re-run.
alter table public.equipment add column if not exists verified_on date;   -- last time someone confirmed it's here

create table if not exists public.equipment_photos (
  photo_id      bigint generated always as identity primary key,
  equipment_id  bigint not null references public.equipment on delete cascade,
  path          text not null,              -- file in the 'equipment' storage bucket
  caption       text,
  taken_at      timestamptz not null default now()
);
create index if not exists equipment_photos_eq_idx on public.equipment_photos (equipment_id);
alter table public.equipment_photos enable row level security;
drop policy if exists "authenticated full access" on public.equipment_photos;
create policy "authenticated full access" on public.equipment_photos
  for all to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public) values ('equipment', 'equipment', false)
on conflict (id) do nothing;
drop policy if exists "equipment: signed-in read" on storage.objects;
drop policy if exists "equipment: signed-in write" on storage.objects;
drop policy if exists "equipment: signed-in delete" on storage.objects;
create policy "equipment: signed-in read"   on storage.objects for select to authenticated using (bucket_id = 'equipment');
create policy "equipment: signed-in write"  on storage.objects for insert to authenticated with check (bucket_id = 'equipment');
create policy "equipment: signed-in delete" on storage.objects for delete to authenticated using (bucket_id = 'equipment');
