-- Monosem: use the manual's names for the transmission sprockets. Safe to re-run.
--   Driver A = upper sprocket (driver), Driver B = lower sprocket (driven).
-- 1. Planter setting list: "Sprocket 1/2" become pick lists of the manual's tooth counts.
update public.equipment
   set planting_settings = regexp_replace(regexp_replace(planting_settings,
         '^Sprocket 1\s*$', 'Driver A (upper): 14 | 17 | 18 | 19 | 23 | 24 | 26', 'gn'),
         '^Sprocket 2\s*$', 'Driver B (lower): 17 | 19 | 23 | 24 | 26 | 28', 'gn')
 where (name ilike '%monosem%' or make ilike '%monosem%') and planting_settings ~ '(^|\n)Sprocket [12]';

-- 2. Planting records already saved: rename the keys, keep the values.
update public.planting_details
   set settings = (settings - 'Sprocket 1' - 'Sprocket 2')
       || jsonb_strip_nulls(jsonb_build_object('Driver A (upper)', settings -> 'Sprocket 1', 'Driver B (lower)', settings -> 'Sprocket 2'))
 where settings ?| array['Sprocket 1', 'Sprocket 2'];

select name, replace(planting_settings, E'\n', ' | ') as settings from public.equipment where name ilike '%monosem%' or make ilike '%monosem%';
