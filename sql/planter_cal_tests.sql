-- Planter / drill calibration tests from the Tools tab. Safe to re-run.
-- One row per catch test. Settings are caliper measurements of the exposed seed cup:
-- 0 mm exposed = closed, full_mm = fully open (100%).
create table if not exists public.planter_cal_tests (
  test_id        bigint generated always as identity primary key,
  tested_on      date not null default current_date,
  equipment_id   bigint references public.equipment on delete set null,
  seed_box       text,                 -- 'Large' or 'Small'
  spacing_in     numeric(5,2),
  units          smallint,             -- row units running
  crop_id        bigint references public.crops on delete set null,
  variety        text,
  seed_lot       text,
  target_lb_ac   numeric(10,2),
  full_mm        numeric(7,2),         -- caliper reading fully open
  exposed_mm     numeric(7,2),         -- caliper reading for this test
  exposed_pct    numeric(6,2),
  acre           numeric(6,4),         -- area the test represents
  turns          numeric(7,2),         -- drive tire turns for that area
  grams          numeric(10,2)[],      -- each tube caught
  grams_avg      numeric(10,2),
  actual_lb_ac   numeric(10,2),
  notes          text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);
alter table public.planter_cal_tests enable row level security;
drop policy if exists "authenticated full access" on public.planter_cal_tests;
create policy "authenticated full access" on public.planter_cal_tests
  for all to authenticated using (true) with check (true);
create index if not exists planter_cal_tests_seed_idx on public.planter_cal_tests (crop_id, variety, seed_lot);
