-- Permanent delete helpers, used by the app's "Delete everything" button.
-- Normal deletes are blocked when a field, turnout or ditch rider has records attached.
-- These functions remove the item AND its attached records in one step. Safe to re-run.

-- A field: its split halves, water order lines, water events, chemical records,
-- crop years (and harvests/planting details), work records, leases and lineage links.
create or replace function public.delete_field_everywhere(p_field bigint)
returns void language plpgsql security invoker as $$
declare h bigint;
begin
  for h in select field_id from public.fields where parent_field_id = p_field loop
    perform public.delete_field_everywhere(h);
  end loop;
  delete from public.water_order_lines     where field_id = p_field;
  delete from public.water_order_subunits  where subunit_field_id = p_field;
  delete from public.water_events          where field_id = p_field;
  delete from public.chemical_events       where field_id = p_field;          -- product lines go with it
  delete from public.planting_details      where crop_year_id in (select crop_year_id from public.crop_years where field_id = p_field);
  delete from public.crop_years            where field_id = p_field;          -- harvest records go with it
  delete from public.planting_details      where event_id in (select event_id from public.work_events where field_id = p_field);
  delete from public.work_events           where field_id = p_field;
  delete from public.maintenance_records   where field_id = p_field;
  delete from public.equipment_fields      where field_id = p_field;   -- needs irrigation_procedures.sql
  delete from public.leases                where field_id = p_field;
  delete from public.field_lineage         where field_id = p_field or predecessor_id = p_field;
  delete from public.fields                where field_id = p_field;
end $$;

-- A turnout: its water order lines are removed; fields on it are kept but left with no turnout.
create or replace function public.delete_turnout_everywhere(p_turnout bigint)
returns void language plpgsql security invoker as $$
begin
  delete from public.water_order_lines where turnout_id = p_turnout;
  update public.fields set turnout_id = null where turnout_id = p_turnout;
  delete from public.turnouts where turnout_id = p_turnout;
end $$;

-- A ditch rider: their turnouts are removed as above; fields are kept.
create or replace function public.delete_rider_everywhere(p_rider bigint)
returns void language plpgsql security invoker as $$
declare t bigint;
begin
  for t in select turnout_id from public.turnouts where rider_id = p_rider loop
    perform public.delete_turnout_everywhere(t);
  end loop;
  delete from public.ditch_riders where rider_id = p_rider;
end $$;

revoke all on function public.delete_field_everywhere(bigint), public.delete_turnout_everywhere(bigint),
  public.delete_rider_everywhere(bigint) from public, anon;
grant execute on function public.delete_field_everywhere(bigint), public.delete_turnout_everywhere(bigint),
  public.delete_rider_everywhere(bigint) to authenticated;
