-- Chemical labels: label facts, PDF storage and rotation (plant-back) rules.

alter table public.chemicals add column if not exists signal_word text;
alter table public.chemicals add column if not exists restricted_use boolean not null default false;
alter table public.chemicals add column if not exists rei_hours numeric(6,1);
alter table public.chemicals add column if not exists chemigation text;          -- what the label says about chemigation
alter table public.chemicals add column if not exists label_path text;           -- file in the 'labels' storage bucket
alter table public.chemicals add column if not exists label_source text;         -- which label the data came from
alter table public.chemicals add column if not exists label_checked boolean not null default false;
alter table public.chemicals add column if not exists label_notes text;

-- One rule per product per crop. crop_id blank = "all other crops" on that label.
create table if not exists public.chemical_rotation_rules (
  rule_id        bigint generated always as identity primary key,
  chemical_id    bigint not null references public.chemicals on delete cascade,
  crop_id        bigint references public.crops on delete cascade,
  months         numeric(5,1),      -- wait this many months after application
  seasons_after  smallint,          -- or: not until this many seasons later (1 = next year, 2 = the year after next)
  conditions     text,              -- rate, rainfall/irrigation, pH, tillage, bioassay...
  label_page     text,
  created_at     timestamptz not null default now()
);
create index if not exists rotation_rules_chem_idx on public.chemical_rotation_rules (chemical_id);
alter table public.chemical_rotation_rules enable row level security;
drop policy if exists "authenticated full access" on public.chemical_rotation_rules;
create policy "authenticated full access" on public.chemical_rotation_rules
  for all to authenticated using (true) with check (true);

-- Private storage for label PDFs (only signed-in users can read or upload)
insert into storage.buckets (id, name, public) values ('labels', 'labels', false)
on conflict (id) do nothing;
drop policy if exists "labels: signed-in read" on storage.objects;
drop policy if exists "labels: signed-in write" on storage.objects;
drop policy if exists "labels: signed-in update" on storage.objects;
drop policy if exists "labels: signed-in delete" on storage.objects;
create policy "labels: signed-in read"   on storage.objects for select to authenticated using (bucket_id = 'labels');
create policy "labels: signed-in write"  on storage.objects for insert to authenticated with check (bucket_id = 'labels');
create policy "labels: signed-in update" on storage.objects for update to authenticated using (bucket_id = 'labels');
create policy "labels: signed-in delete" on storage.objects for delete to authenticated using (bucket_id = 'labels');
