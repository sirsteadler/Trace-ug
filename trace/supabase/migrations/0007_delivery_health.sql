-- TRACE — delivery health. SRS §5.1, concept note §5.4.
--
-- deliveries.health is a stored column that nothing ever writes, so every
-- delivery has read 'green' since the schema was created. The wallboard exists
-- to say where attention is required; against a column fixed at green it says
-- nothing at all.
--
-- Computed in a view rather than maintained by a job, so the dashboard, the
-- wallboard and any later report cannot disagree. There is one definition of
-- late and it lives here. Recomputing on read costs nothing at pilot volume and
-- removes a whole class of staleness bug.
--
-- Thresholds are per-organisation, read from organisations.settings, defaulting
-- to the rule agreed on 19 August: amber past 5 minutes, red past 15.

create or replace view deliveries_with_health as
select
  d.*,
  case
    -- Terminal states are not late; they are finished.
    when d.status in ('CONFIRMED','FAILED','RETURNED') then 'green'::delivery_health
    when d.eta_at is null                              then 'green'::delivery_health
    when now() > d.eta_at + make_interval(mins => coalesce(
           (o.settings->>'health_red_minutes')::int, 15))
      then 'red'::delivery_health
    when now() > d.eta_at + make_interval(mins => coalesce(
           (o.settings->>'health_amber_minutes')::int, 5))
      then 'amber'::delivery_health
    else 'green'::delivery_health
  end as computed_health,
  -- Signed, so the dashboard can say "12 minutes early" as readily as late.
  case when d.eta_at is null then null
       else round(extract(epoch from (now() - d.eta_at)) / 60)::int
  end as minutes_late
from deliveries d
join organisations o on o.id = d.org_id;

-- security_invoker: the view runs with the caller's rights, so the RLS policies
-- on deliveries apply through it. Without this a view owned by postgres would
-- hand every reader every row — the classic way an RLS matrix is silently
-- bypassed by the convenience layer built on top of it.
alter view deliveries_with_health set (security_invoker = on);

grant select on deliveries_with_health to authenticated;

-- Wallboard counters. -----------------------------------------------------------
-- One round trip for the numbers a dispatcher reads from three metres, rather
-- than fetching every row to count it in the browser.
create or replace function delivery_health_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'active',    count(*) filter (where status not in ('CONFIRMED','FAILED','RETURNED')),
    'amber',     count(*) filter (where computed_health = 'amber'),
    'red',       count(*) filter (where computed_health = 'red'),
    'completed_today', count(*) filter (
      where status = 'CONFIRMED' and completed_at >= date_trunc('day', now())
    )
  )
  from deliveries_with_health;
$$;

grant execute on function delivery_health_summary() to authenticated;
