-- Custom work for other farmers: a customer and a location instead of one of our fields,
-- billed per acre (billing itself happens elsewhere). Safe to re-run.
create table if not exists public.customers (
  customer_id   bigint generated always as identity primary key,
  name          text not null,
  phone         text,
  email         text,
  address       text,
  default_rate  numeric(10,2),          -- usual $/acre charged
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
alter table public.customers enable row level security;
drop policy if exists "authenticated full access" on public.customers;
create policy "authenticated full access" on public.customers
  for all to authenticated using (true) with check (true);

alter table public.work_events alter column field_id drop not null;
alter table public.work_events add column if not exists customer_id bigint references public.customers;
alter table public.work_events add column if not exists location text;            -- the customer's field, in words
alter table public.work_events add column if not exists lat numeric(9,6);
alter table public.work_events add column if not exists lng numeric(9,6);
alter table public.work_events add column if not exists custom_rate numeric(10,2); -- $/acre charged
alter table public.work_events add column if not exists custom_total numeric(12,2);
alter table public.work_events drop constraint if exists work_events_field_or_customer;
alter table public.work_events add constraint work_events_field_or_customer check (field_id is not null or customer_id is not null);
create index if not exists work_events_customer_idx on public.work_events (customer_id);
