-- Pivot lap time at 100% speed, used by Tools → Chemigator load to work out
-- application time and the fastest speed that still uses the minimum mix. Safe to re-run.
alter table public.equipment add column if not exists full_lap_hr numeric(6,2);   -- hours for one full lap at 100% speed
