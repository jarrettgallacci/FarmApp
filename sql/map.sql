-- Farm map: field outlines and crop colours.
alter table public.fields add column if not exists boundary jsonb;   -- GeoJSON Feature (outline)
alter table public.crops  add column if not exists color text;       -- map colour, e.g. '#2563a8'
