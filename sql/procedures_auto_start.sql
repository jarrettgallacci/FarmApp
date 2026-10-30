-- Seasonal tasks: a procedure can start a round on its own each year (e.g. mid-season pump greasing around June 15).
-- The app creates the round the first time someone opens Home or Seasonal tasks on or after the start date.
-- Safe to run more than once.
alter table public.procedures add column if not exists auto_month          smallint check (auto_month between 1 and 12);
alter table public.procedures add column if not exists auto_day            smallint check (auto_day between 1 and 31);
alter table public.procedures add column if not exists auto_nearest_monday boolean not null default false;  -- use the Monday closest to that date
alter table public.procedures add column if not exists auto_due_days       smallint check (auto_due_days >= 0); -- due this many days after it starts
alter table public.procedures add column if not exists auto_last_season    smallint;  -- last year a round was started automatically
