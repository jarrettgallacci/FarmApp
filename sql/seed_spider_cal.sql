-- Seed Spider calibration tests + Great Plains drive-turn correction. Safe to re-run.
-- Requires planter_cal_tests.sql to have been run first.
alter table public.planter_cal_tests add column if not exists calc_type text not null default 'great_plains'; -- 'great_plains' or 'seed_spider'
alter table public.planter_cal_tests add column if not exists bin smallint;           -- Seed Spider bin 1-4 (each feeds 2 rows)
alter table public.planter_cal_tests add column if not exists sponge_set text;
alter table public.planter_cal_tests add column if not exists rpm numeric(6,2);       -- controller RPM during the catch
alter table public.planter_cal_tests add column if not exists catch_sec numeric(7,1); -- how long seed was caught
alter table public.planter_cal_tests add column if not exists rows_caught smallint;
alter table public.planter_cal_tests add column if not exists speed_mph numeric(5,2); -- planting speed the rate is figured at

-- Great Plains: 0.1 acre is 28.3 drive-tire turns, not 24.33. Tests already saved at 24.33 turns
-- covered less ground, so their area and rate are corrected here. Runs once (only touches 24.33 rows).
update public.planter_cal_tests
   set acre = round(acre * 24.33 / 28.3, 4),
       actual_lb_ac = round(actual_lb_ac * 28.3 / 24.33, 2)
 where calc_type = 'great_plains' and turns = 24.33 and acre = 0.1;
