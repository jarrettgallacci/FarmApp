-- Bees: a field can go on the bee plan before its bloom date is known
-- (add fields in winter, set dates in late spring). Safe to re-run.
alter table public.bee_plans alter column target_flight_on drop not null;
