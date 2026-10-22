-- Equipment details: make, model, year, serial (PIN) and more. Safe to re-run.
alter table public.equipment add column if not exists make text;
alter table public.equipment add column if not exists model text;
alter table public.equipment add column if not exists model_year smallint;
alter table public.equipment add column if not exists serial_no text;        -- PIN / VIN
alter table public.equipment add column if not exists unit_no text;          -- your own unit number or nickname
alter table public.equipment add column if not exists engine_serial text;
alter table public.equipment add column if not exists hours numeric(9,1);    -- last known engine/separator hours
alter table public.equipment add column if not exists hours_date date;
alter table public.equipment add column if not exists purchase_date date;
alter table public.equipment add column if not exists purchase_price numeric(12,2);
alter table public.equipment add column if not exists license_plate text;    -- apparatus / road plate
create unique index if not exists equipment_serial_uniq on public.equipment (upper(serial_no)) where serial_no is not null;
