-- Label links and versions (the PDF upload stays available).
alter table public.chemicals add column if not exists label_url text;          -- custom link (manufacturer, 24c, PICOL...)
alter table public.chemicals add column if not exists label_version text;      -- EPA accepted date or revision code the data came from
alter table public.chemicals add column if not exists label_checked_on date;   -- when someone last checked the data against the label
update public.chemicals set label_checked_on = current_date where label_checked and label_checked_on is null;
