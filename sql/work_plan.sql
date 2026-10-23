-- Planned (future) work records. Existing records are 'done'. Safe to re-run.
alter table public.work_events add column if not exists status text not null default 'done';
alter table public.work_events drop constraint if exists work_events_status_check;
alter table public.work_events add constraint work_events_status_check check (status in ('planned', 'done'));
create index if not exists work_events_status_idx on public.work_events (status, performed_on);
