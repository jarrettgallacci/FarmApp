-- Pattern (straight lines / circle) and GPS heading on every work record, not just planting. Safe to re-run.
alter table public.work_events add column if not exists pattern text;        -- 'straight' or 'circle'
alter table public.work_events add column if not exists heading_deg numeric(5,1);
alter table public.work_events drop constraint if exists work_events_pattern_check;
alter table public.work_events add constraint work_events_pattern_check check (pattern in ('straight', 'circle'));

-- Copy what planting records already have.
update public.work_events w
   set pattern = p.pattern, heading_deg = p.heading_deg
  from public.planting_details p
 where p.event_id = w.event_id and w.pattern is null and w.heading_deg is null
   and (p.pattern is not null or p.heading_deg is not null);
