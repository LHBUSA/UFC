-- PBE Picks market context refresh (owner decision 2026-09-15, "A+").
--
-- Defect: a fight-week provider snapshot lands, but the PBE Picks card keeps
-- showing the market stored by the previous hourly model cycle until the next
-- :41 run, so the previous snapshot can expire on the card while a fresh one is
-- already stored (observed 2026-09-15: capture 18:57Z, card LAST OBSERVED
-- 19:16-19:41Z; in the final 24h the gap would recur every hour).
--
-- ufc-live-odds now notifies ufc-algo after a successful pre-fight snapshot;
-- ufc-algo recomputes the market object with its canonical marketComparison()
-- from the prediction's stored pick and probability, and writes it through this
-- function. It is presentation context only:
--   * it replaces ONLY sample_context.market;
--   * never the official comparison columns (market_snapshot_at,
--     market_implied_prob_pick, market_books, model_edge_pts), never the pick,
--     probabilities, features, versions, generated_at or lock state;
--   * never a locked row (checked under the row lock that
--     ufc_model_publish_prediction also takes, and refused again by the write
--     gate trigger);
--   * only the current live champion's rows;
--   * only the regeneration the caller read (expected generated_at), so a
--     refresh cannot overwrite context belonging to a newer model cycle;
--   * only forward in time: the new market's observed_at must be later than the
--     stored one, so a slow refresh can never replace a newer market.
-- It creates no evaluation row, so regeneration-drift history is untouched.

begin;

create or replace function public.ufc_model_refresh_prediction_market(
  p_prediction_id uuid,
  p_expected_generated_at timestamptz,
  p_market jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r public.ufc_model_predictions;
  champions int;
  champion text;
  new_obs timestamptz;
  old_obs timestamptz;
begin
  if p_market is null or jsonb_typeof(p_market) <> 'object' or coalesce(p_market->>'status', '') not in ('FRESH', 'STALE') then
    raise exception 'market must be a FRESH or STALE market comparison object'
      using errcode = 'check_violation';
  end if;
  new_obs := nullif(p_market->>'observed_at', '')::timestamptz;
  if new_obs is null then
    raise exception 'market has no observed_at'
      using errcode = 'check_violation';
  end if;

  select count(*), min(model_version) into champions, champion from public.ufc_model_versions where status = 'live';
  if champions <> 1 then
    return jsonb_build_object('refreshed', false, 'reason', 'no_single_live_champion');
  end if;

  -- The same row lock ufc_model_publish_prediction takes: a refresh and a lock
  -- serialise. Lock first -> this sees locked_at and refuses. Refresh first ->
  -- the lock freezes the refreshed context.
  select * into r from public.ufc_model_predictions where id = p_prediction_id for update;
  if not found then
    return jsonb_build_object('refreshed', false, 'reason', 'not_found');
  end if;
  if r.locked_at is not null then
    return jsonb_build_object('refreshed', false, 'reason', 'locked');
  end if;
  if r.model_version is distinct from champion then
    return jsonb_build_object('refreshed', false, 'reason', 'not_champion');
  end if;
  if r.generated_at is distinct from p_expected_generated_at then
    return jsonb_build_object('refreshed', false, 'reason', 'regenerated');
  end if;
  old_obs := nullif(r.sample_context->'market'->>'observed_at', '')::timestamptz;
  if old_obs is not null and new_obs <= old_obs then
    return jsonb_build_object('refreshed', false, 'reason', 'not_newer');
  end if;

  update public.ufc_model_predictions
     set sample_context = jsonb_set(coalesce(sample_context, '{}'::jsonb), '{market}', p_market, true)
   where id = p_prediction_id
     and locked_at is null;

  return jsonb_build_object('refreshed', true, 'reason', null, 'observed_at', new_obs, 'previous_observed_at', old_obs);
end;
$$;

revoke all on function public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb) from public;
revoke all on function public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb) from anon, authenticated;
grant execute on function public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb) to service_role;

comment on function public.ufc_model_refresh_prediction_market(uuid, timestamptz, jsonb) is
  'PBE Picks presentation refresh: replaces only sample_context.market on an unlocked live-champion prediction at the expected regeneration, forward in time only. Never touches official market columns, the pick, probabilities, features or lock state. Service role only.';

commit;
