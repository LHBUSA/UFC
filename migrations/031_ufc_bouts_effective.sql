-- 031_ufc_bouts_effective.sql
--
-- public.ufc_bouts_effective: the EFFECTIVE truth of every bout, as a view.
--
-- WHY. ufc_bouts.status is not the whole truth, by design. When ESPN drops a
-- competition from a card the ingest does NOT rewrite the bout (migration 029,
-- defect D1): the row stays 'announced' and the fact lives in the append-only
-- ledger ufc_event_card_observations. Sourced withdrawals live in
-- ufc_fighter_status_events. PBE Algo (workers/ufc-algo/src/cardTruth.js) and the
-- web (web/lib/cardTruth.ts) each combine those in application code. Every OTHER
-- consumer filters `status=neq.cancelled` in SQL and so still believes a bout
-- that left the card three days ago is booked. This view is the one durable place
-- that combination lives, so a consumer can filter on it in SQL.
--
-- WHAT IT NEVER DOES. It does not replace, rename or write ufc_bouts. It creates
-- no table and stores nothing: the canonical row and both evidence ledgers stay
-- exactly as they are, and dropping this view loses no data.
--
-- THE RULES (identical to web/lib/cardTruth.ts; parity is tested):
--   * A bout is REMOVED (is_active = false) only on CONFIRMED evidence:
--       'status'            the stored status is cancelled / replaced, or
--       'card_observation'  the NEWEST official (ESPN) card observation is COMPLETE
--                           and lists the bout's competition neither as a competition
--                           nor as a placeholder  (official_card_state = 'missing').
--   * A sourced withdrawal CONTRIBUTES evidence (it joins removal_basis, dates the
--     change, and may license a reason) but never removes a bout on its own: a
--     reported withdrawal while the official card still lists the bout leaves
--     is_active = true and sets withdrawal_reported = true. That is a warning.
--   * An ambiguous official read removes nobody: no observation, an incomplete
--     observation, a placeholder, or a bout without a source id all leave the bout
--     active (official_card_present is NULL, not false).
--   * A settled bout (stored status 'complete', or a stored result) is history. No
--     later observation or status event can remove it, and it carries no evidence
--     columns.
--   * reason is never inferred. It is the status_type of a cause event (injury,
--     illness, visa_travel, suspension, weight_miss) for the ONE fighter every
--     withdrawal names, on THIS card, and only when the sources agree on one kind.
--     Otherwise NULL. It is a category key, never a diagnosis or a body part.
--
-- There is deliberately NO bare `status` column: a consumer must choose
-- stored_status (what the canonical row says) or effective_status (what is true).

begin;

create or replace view public.ufc_bouts_effective
  with (security_invoker = true) as
select
  b.id,
  b.ufcstats_id,
  b.espn_competition_id,
  b.event_id,
  b.fighter_a_id,
  b.fighter_b_id,
  b.weight_class,
  b.weight_class_raw,
  b.is_womens,
  b.is_title,
  b.scheduled_rounds,
  b.card_position,
  b.bout_order,
  b.replaced_bout_id,
  b.short_notice_days,
  b.source_url,
  b.captured_at,
  b.updated_at,
  b.title_kind,
  b.model_scope,

  b.status as stored_status,
  case when k.removed and not k.stored_off then 'cancelled' else b.status end as effective_status,
  not k.removed as is_active,
  s.settled as is_settled,

  -- Every independent reason the bout is off the card, strongest first. NULL while the bout is active.
  case when k.removed then array_remove(array[
    case when k.stored_off then 'status' end,
    case when k.missing then 'card_observation' end,
    case when w.active_withdrawals > 0 then 'withdrawal' end
  ], null) end as removal_basis,

  -- When a withdrawal from this bout was first reported (the source's own time where it gave one).
  w.first_reported_at as removal_reported_at,
  -- A withdrawal is reported AND the bout is still active: a warning, not a removal.
  (not k.removed and w.active_withdrawals > 0) as withdrawal_reported,
  w.withdrawn_fighter_id,

  -- true: listed. false: confirmed not listed. NULL: no unambiguous official read.
  case c.state when 'confirmed' then true when 'missing' then false end as official_card_present,
  c.state as official_card_state,
  o.observed_at as official_card_observed_at,
  -- Start of the unbroken run of newest observations that do not list this competition.
  case when k.missing then (
    select min(o2.observed_at)
    from public.ufc_event_card_observations o2
    where o2.event_id = b.event_id and o2.source = 'espn'
      and o2.observed_at > coalesce((
        select max(o3.observed_at)
        from public.ufc_event_card_observations o3
        where o3.event_id = b.event_id and o3.source = 'espn'
          and not (o3.complete is true
                   and not (b.espn_competition_id = any (coalesce(o3.competition_ids, '{}')))
                   and not (b.espn_competition_id = any (coalesce(o3.placeholder_ids, '{}'))))
      ), '-infinity'::timestamptz)
  ) end as off_card_since,

  w.reason,
  coalesce(w.source_receipt_count, 0) as source_receipt_count

from public.ufc_bouts b

-- settled: fought, or stored as complete. History.
cross join lateral (
  select (b.status = 'complete'
          or exists (select 1 from public.ufc_bout_results r where r.bout_id = b.id)) as settled
) s

-- the newest official card observation for the event, complete or not (the same row Algo and the web read)
left join lateral (
  select x.observed_at, x.complete, x.competition_ids, x.placeholder_ids
  from public.ufc_event_card_observations x
  where x.event_id = b.event_id and x.source = 'espn'
  order by x.observed_at desc
  limit 1
) o on true

-- cardTruth(): workers/ufc-algo/src/cardTruth.js and web/lib/cardTruth.ts, in SQL
cross join lateral (
  select case
    when o.observed_at is null then 'unobserved'
    when o.complete is not true then 'incomplete'
    when b.espn_competition_id is null then 'no_source_id'
    when b.espn_competition_id = any (coalesce(o.competition_ids, '{}')) then 'confirmed'
    when b.espn_competition_id = any (coalesce(o.placeholder_ids, '{}')) then 'placeholder'
    else 'missing'
  end as state
) c

-- sourced evidence about either corner ON THIS CARD; nothing for a settled bout
left join lateral (
  select
    count(*) filter (where e.status_type = 'withdrawal' and e.state = 'active') as active_withdrawals,
    min(coalesce(e.effective_at, e.source_published_at, e.detected_at)) filter (where e.status_type = 'withdrawal') as first_reported_at,
    case when count(distinct e.fighter_id) filter (where e.status_type = 'withdrawal') = 1
         then (array_agg(e.fighter_id) filter (where e.status_type = 'withdrawal'))[1] end as withdrawn_fighter_id,
    count(distinct regexp_replace(e.source_url, '[?#].*$', '')) as source_receipt_count,
    array_agg(distinct e.fighter_id::text || ':' || e.status_type) filter (where e.status_type <> 'withdrawal') as causes
  from public.ufc_fighter_status_events e
  where not s.settled
    and e.fighter_id in (b.fighter_a_id, b.fighter_b_id)
    and e.status_type in ('withdrawal', 'injury', 'illness', 'visa_travel', 'suspension', 'weight_miss')
    and (e.bout_id = b.id or (e.bout_id is null and e.event_id = b.event_id))
) w0 on true
cross join lateral (
  select
    coalesce(w0.active_withdrawals, 0) as active_withdrawals,
    w0.first_reported_at,
    w0.withdrawn_fighter_id,
    w0.source_receipt_count,
    -- one withdrawn fighter, and exactly one kind of cause recorded for THAT fighter; else no reason
    case when w0.withdrawn_fighter_id is not null then (
      select case when count(*) = 1 then min(split_part(cz, ':', 2)) end
      from unnest(coalesce(w0.causes, '{}')) cz
      where split_part(cz, ':', 1) = w0.withdrawn_fighter_id::text
    ) end as reason
) w

cross join lateral (
  select
    b.status in ('cancelled', 'replaced') as stored_off,
    (not s.settled and c.state = 'missing') as missing,
    (b.status in ('cancelled', 'replaced') or (not s.settled and c.state = 'missing')) as removed
) k;

comment on view public.ufc_bouts_effective is
  'Effective bout truth: ufc_bouts + newest official card observation (029) + sourced withdrawals. Read-only combination; ufc_bouts is never rewritten. is_active=false only on confirmed removal; a reported withdrawal alone sets withdrawal_reported. Rules: web/lib/cardTruth.ts.';
comment on column public.ufc_bouts_effective.stored_status is 'ufc_bouts.status, untouched.';
comment on column public.ufc_bouts_effective.effective_status is 'stored_status, except ''cancelled'' when the newest complete official card no longer lists an unsettled bout.';
comment on column public.ufc_bouts_effective.is_active is 'false only on CONFIRMED removal (stored status, or missing from the newest complete official card). A reported withdrawal alone never makes this false.';
comment on column public.ufc_bouts_effective.reason is 'Category key of a sourced cause event for the one withdrawn fighter on this card (injury, illness, visa_travel, suspension, weight_miss), or NULL. Never inferred, never a diagnosis.';

-- Same posture as the ledgers it reads: caller-rights view, service role only.
revoke all on public.ufc_bouts_effective from anon, authenticated;
grant select on public.ufc_bouts_effective to service_role;

notify pgrst, 'reload schema';

commit;
