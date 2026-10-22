-- Per-planter setting lists, and pattern/heading on planting records. Safe to re-run.
alter table public.equipment add column if not exists planting_settings text;   -- one setting name per line
alter table public.planting_details add column if not exists settings jsonb;     -- {"Seed plate": "24-cell", ...}
alter table public.planting_details add column if not exists pattern text;       -- 'straight' or 'circle'
alter table public.planting_details add column if not exists heading_deg numeric(5,1);

-- Starting lists (only where none is set yet). Edit them in Setup -> Equipment.
update public.equipment set planting_settings = E'Seed plate\nSprocket 1\nSprocket 2\nDepth (in)\nSpeed (mph)\nSeeds per 3 ft'
  where planting_settings is null and (name ilike '%monosem%' or make ilike '%monosem%');
update public.equipment set planting_settings = E'Sponge set\nSprocket 1\nSprocket 2\nDepth (in)\nSpeed (mph)\nSeeds per 3 ft'
  where planting_settings is null and (name ilike '%seed spider%' or make ilike '%seed spider%');
update public.equipment set planting_settings = E'Rate / meter setting\nDepth (in)\nSpeed (mph)'
  where planting_settings is null and (name ilike '%great plains%' or make ilike '%great plains%');

select name, replace(planting_settings, E'\n', ' | ') as settings from public.equipment where planting_settings is not null order by name;
