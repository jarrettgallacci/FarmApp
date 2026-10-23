-- Pump details on equipment, and who reported a problem (the signed-in person). Safe to re-run.
alter table public.equipment add column if not exists hp numeric(7,1);
alter table public.equipment add column if not exists frame_size text;
alter table public.equipment add column if not exists meter_no text;
alter table public.equipment add column if not exists vfd boolean;
alter table public.maint_jobs add column if not exists reported_by_email text;   -- sign-in email of whoever made the record
