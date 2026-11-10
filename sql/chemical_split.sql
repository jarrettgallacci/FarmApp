-- Split one tank mix into separate chemical records (e.g. KWS beets, billed per chemical).
-- The extra records point at the first one; only the first carries the application cost. Safe to re-run.
alter table public.chemical_events add column if not exists split_of bigint references public.chemical_events on delete set null;
create index if not exists chemical_events_split_idx on public.chemical_events (split_of);
