-- Marcio Alexandre Jr. / Junior — fighter merge, 2026-09-14 (owner-approved).
--
-- One man, two ufc_fighters rows: the ESPN ingest created one from his Contender
-- Series bout (ESPN athlete 3108776 only), the UFC Stats backfill another from
-- his three UFC bouts (UFC Stats d53482bef23235ba only). Identity was proven on
-- SOURCE IDS, never on names (scripts/tuf/resolve_identity.mjs PROVEN_DUPLICATES,
-- retrieved 2026-09-12):
--
--   ESPN athlete 3108776's event log contains the UFC Stats row's bouts on
--   2014-05-31 (Warlley Alves), 2014-12-20 (Tim Means) and 2015-12-12 (UFC 194),
--   and the UFC 194 opponent is ESPN athlete 2504639 — Court McGee, whose stored
--   row carries that ESPN id. Nickname (Lyoto), stance (southpaw), reach (75)
--   and weight (185) agree; DOB differs by two days (ESPN 1989-05-03 kept, UFC
--   Stats 1989-05-05 recorded in evidence).
--
-- No other fighter is merged. The transaction deletes exactly one ufc_fighters
-- row and asserts it.
--
-- Canonical = the ESPN row f5785bba (keeps ESPN 3108776 and its slug). The UFC
-- Stats row ded1a158 is the duplicate: bouts, round rows, aliases and opponents'
-- feature rows move to the canonical id; its UFC Stats id and the UFC Stats
-- career profile fields the canonical row lacks move with it; it is deleted.
-- The combat mirror follows scripts/reconcile/20260913_dwcs_split_identities.sql:
-- the duplicate combat record becomes identity_state='merged' pointing at the
-- canonical one, its UFC Stats identity row moves across, and its name alias
-- moves where it does not collide. The duplicate's own derived rows (DNA
-- snapshots, stance splits, bout features) are dropped for a Fight DNA rebuild
-- of the canonical id. The open alias-review item that asked whether UFC Stats
-- d53482bef23235ba is this fighter is resolved to the canonical id.
--
-- FAIL CLOSED. Exact pre-state counts asserted; every statement's row count is
-- asserted against the plan; a fingerprint of every UNRELATED row in the touched
-- tables must be identical after. The Court McGee bout is asserted by id after
-- the merge. Before-images and per-table counts go to ufc_identity_reconciliations.
--
-- Run: proof (BEGIN ... ROLLBACK) first, then the same body as apply:
--   pwsh scripts/db/apply_supabase_migration.ps1 -Mode proof -Paths scripts/reconcile/20260914_marcio_alexandre_merge.sql

begin;

/* The two full fingerprints scan ~60k rows each; the default API statement timeout is too short for both. */
set local statement_timeout = '15min';

do $merge$
declare
  PLAN constant text := 'marcio-alexandre-merge-2026-09-14';
  x   constant uuid := 'f5785bba-c6f8-45de-8682-d044d586c8ac';  -- canonical, ESPN 3108776
  xp  constant uuid := 'ded1a158-8eed-43bb-8c6e-f950bb97432d';  -- duplicate, UFC Stats d53482bef23235ba
  cx  constant uuid := 'eb319574-e1a1-4419-ba04-1258a75a432d';
  cxp constant uuid := '836b3252-2cd2-4433-96bb-911bf74b570e';
  ESPN constant text := '3108776';
  UFCSTATS constant text := 'd53482bef23235ba';
  MCGEE constant uuid := '5f12cacb-78d0-488a-9f22-7c1c347031c9';
  MCGEE_BOUT constant uuid := 'a0713bd3-52d9-47e6-87c9-5a17014bb567';
  REVIEW_ITEM constant uuid := '2b050b26-b861-41f8-89d5-6f7512b97836';
  touched uuid[] := array[x, xp];
  touched_combat uuid[] := array[cx, cxp];
  n bigint; nn bigint; fighters_before bigint;
  counts jsonb := '{}'::jsonb; fp_before jsonb; fp_after jsonb; k text;
begin
  /* ---- fingerprint of everything this merge must NOT change ---- */
  select jsonb_build_object(
    'ufc_events',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_events t),
    'ufc_rankings',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_rankings t),
    'ufc_fighters',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_fighters t where t.id <> all(touched)),
    'ufc_bouts',                (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_bouts t where t.fighter_a_id <> all(touched) and t.fighter_b_id <> all(touched)),
    'ufc_bout_results',         (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.bout_id), ''))) from public.ufc_bout_results t),
    'ufc_bout_round_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.bout_id, t.fighter_id, t.round), ''))) from public.ufc_bout_round_stats t where t.fighter_id <> all(touched)),
    'ufc_bout_fight_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.bout_id, t.fighter_id), ''))) from public.ufc_bout_fight_stats t),
    'ufc_fighter_bout_features',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t::text), ''))) from public.ufc_fighter_bout_features t where t.fighter_id <> all(touched) and (t.opponent_id is null or t.opponent_id <> all(touched))),
    'ufc_fighter_dna_snapshots',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by md5(t::text)), ''))) from public.ufc_fighter_dna_snapshots t where t.fighter_id <> xp),
    'ufc_fighter_stance_splits',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t::text), ''))) from public.ufc_fighter_stance_splits t where t.fighter_id <> xp),
    'ufc_fighter_aliases',      (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_fighter_aliases t where t.fighter_id <> all(touched)),
    'ufc_alias_review_queue',   (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_alias_review_queue t where t.id <> REVIEW_ITEM),
    'ufc_images',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_images t),
    'ufc_dwcs_outcome_claims',  (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_dwcs_outcome_claims t),
    'ufc_identity_reconciliations', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_identity_reconciliations t),
    'combat_fighters',          (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.combat_fighters t where t.id <> all(touched_combat)),
    'combat_fighter_identities',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.combat_fighter_identities t where t.combat_fighter_id <> all(touched_combat)),
    'combat_fighter_aliases',   (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.combat_fighter_aliases t where t.combat_fighter_id <> all(touched_combat))
  ) into fp_before;
  select count(*) into fighters_before from public.ufc_fighters;

  /* ---- drift guards: the database must still match the proven plan ---- */
  if (select espn_athlete_id from public.ufc_fighters where id = x) is distinct from ESPN
    or (select ufcstats_id from public.ufc_fighters where id = x) is not null then
    raise exception 'plan drift: canonical is not the ESPN-only row'; end if;
  if (select ufcstats_id from public.ufc_fighters where id = xp) is distinct from UFCSTATS
    or (select espn_athlete_id from public.ufc_fighters where id = xp) is not null then
    raise exception 'plan drift: duplicate is not the UFC Stats-only row'; end if;
  if exists (select 1 from public.ufc_fighters where id not in (x, xp) and (espn_athlete_id = ESPN or ufcstats_id = UFCSTATS)) then
    raise exception 'plan drift: a third row carries ESPN % or UFC Stats %', ESPN, UFCSTATS; end if;
  if (select ufc_fighter_id from public.combat_fighters where id = cx) is distinct from x
    or (select ufc_fighter_id from public.combat_fighters where id = cxp) is distinct from xp
    or (select identity_state from public.combat_fighters where id = cxp) <> 'verified' then
    raise exception 'plan drift: combat mirror'; end if;
  if exists (select 1 from public.ufc_bouts where (fighter_a_id = x and fighter_b_id = xp) or (fighter_a_id = xp and fighter_b_id = x)) then
    raise exception 'plan drift: canonical and duplicate share a bout'; end if;
  select count(*) into n from public.ufc_bouts where x in (fighter_a_id, fighter_b_id);
  if n <> 1 then raise exception 'plan drift: canonical bouts % <> 1', n; end if;
  select count(*) into n from public.ufc_bouts where xp in (fighter_a_id, fighter_b_id);
  if n <> 3 then raise exception 'plan drift: duplicate bouts % <> 3', n; end if;
  /* the three UFC dates in ESPN 3108776's event log never collide with the DWCS date */
  if exists (select 1 from public.ufc_bouts b join public.ufc_events e on e.id = b.event_id
             where xp in (b.fighter_a_id, b.fighter_b_id) and e.event_date not in ('2014-05-31', '2014-12-20', '2015-12-12')) then
    raise exception 'plan drift: duplicate bout dates'; end if;
  if (select fighter_a_id from public.ufc_bouts where id = MCGEE_BOUT) is distinct from MCGEE
    or (select fighter_b_id from public.ufc_bouts where id = MCGEE_BOUT) is distinct from xp
    or (select espn_athlete_id from public.ufc_fighters where id = MCGEE) is distinct from '2504639' then
    raise exception 'plan drift: Court McGee bout'; end if;
  select count(*) into n from public.ufc_bout_round_stats where fighter_id = xp;
  if n <> 9 then raise exception 'plan drift: duplicate round rows % <> 9', n; end if;
  select count(*) into n from public.ufc_bout_results where winner_id = xp;
  if n <> 0 then raise exception 'plan drift: duplicate results won % <> 0', n; end if;
  select count(*) into n from public.ufc_fighter_bout_features where fighter_id = xp;
  if n <> 3 then raise exception 'plan drift: duplicate own features % <> 3', n; end if;
  select count(*) into n from public.ufc_fighter_bout_features where opponent_id = xp;
  if n <> 3 then raise exception 'plan drift: opponent features % <> 3', n; end if;
  select count(*) into n from public.ufc_fighter_dna_snapshots where fighter_id = xp;
  if n <> 7 then raise exception 'plan drift: duplicate dna % <> 7', n; end if;
  select count(*) into n from public.ufc_fighter_stance_splits where fighter_id = xp;
  if n <> 7 then raise exception 'plan drift: duplicate stance % <> 7', n; end if;
  select count(*) into n from public.ufc_fighter_aliases where fighter_id = xp;
  if n <> 2 then raise exception 'plan drift: duplicate aliases % <> 2', n; end if;
  if (select status from public.ufc_alias_review_queue where id = REVIEW_ITEM) is distinct from 'pending'
    or (select candidate_fighter_ids from public.ufc_alias_review_queue where id = REVIEW_ITEM) is distinct from array[x]
    or (select context->>'ufcstats_id' from public.ufc_alias_review_queue where id = REVIEW_ITEM) is distinct from UFCSTATS then
    raise exception 'plan drift: alias review item'; end if;
  select count(*) into n from public.combat_fighter_identities where combat_fighter_id = cxp;
  if n <> 1 then raise exception 'plan drift: duplicate combat identities % <> 1', n; end if;
  select count(*) into n from public.combat_fighter_aliases where combat_fighter_id = cxp;
  if n <> 2 then raise exception 'plan drift: duplicate combat aliases % <> 2', n; end if;

  /* Everything this merge does not repoint must be empty for the duplicate. */
  select
    (select count(*) from public.ufc_images where fighter_id = xp)
  + (select count(*) from public.ufc_image_candidates where fighter_id = xp)
  + (select count(*) from public.ufc_rankings where fighter_id = xp)
  + (select count(*) from public.ufc_bout_fight_stats where fighter_id = xp)
  + (select count(*) from public.ufc_bout_position_stats where fighter_id = xp)
  + (select count(*) from public.ufc_weigh_in_results where fighter_id = xp)
  + (select count(*) from public.ufc_fighter_status_events where xp in (fighter_id, replaced_fighter_id, replacement_fighter_id))
  + (select count(*) from public.ufc_market_observations where xp in (fighter_a_id, fighter_b_id, outcome_fighter_id))
  + (select count(*) from public.ufc_market_run_quotes where xp in (fighter_a_id, fighter_b_id, outcome_fighter_id))
  + (select count(*) from public.ufc_model_predictions where xp in (fighter_a_id, fighter_b_id, pick_fighter_id))
  + (select count(*) from public.ufc_model_backtest_predictions where xp in (fighter_1_id, fighter_2_id, pick_fighter_id, actual_winner_id))
  + (select count(*) from public.ufc_model_prediction_grades where winner_id = xp)
  + (select count(*) from public.ufc_action_events where xp in (fighter_id, opponent_id))
  + (select count(*) from public.ufc_dna_build_runs where fighter_id = xp)
  + (select count(*) from public.ufc_dwcs_outcome_claims where fighter_id = xp)
  + (select count(*) from public.ufc_dwcs_outcome_resolutions where fighter_id = xp)
  + (select count(*) from public.ufc_tournament_entries where fighter_id = xp)
  + (select count(*) from public.ufc_tournaments where winner_fighter_id = xp)
  + (select count(*) from public.ufc_articles where primary_fighter_id = xp or xp = any(fighter_ids))
  + (select count(*) from public.ufc_news_items where primary_fighter_id = xp or xp = any(fighter_ids) or xp = any(secondary_fighter_ids) or xp = any(mentioned_fighter_ids))
  + (select count(*) from public.ufc_videos where xp = any(fighter_ids))
  + (select count(*) from public.ufc_alias_review_queue where resolved_fighter_id = xp or xp = any(candidate_fighter_ids))
  + (select count(*) from public.ufc_fight_state_ledger where fighters::text like '%' || xp::text || '%')
  + (select count(*) from public.ufc_identity_reconciliations where xp in (canonical_id, duplicate_id))
  + (select count(*) from public.combat_bouts where cxp in (fighter_a_id, fighter_b_id))
  + (select count(*) from public.combat_round_stats where fighter_id = cxp)
  + (select count(*) from public.combat_bout_results where winner_id = cxp)
  + (select count(*) from public.combat_weigh_ins where fighter_id = cxp)
  + (select count(*) from public.combat_rankings where fighter_id = cxp)
  + (select count(*) from public.combat_identity_review_queue where resolved_fighter_id = cxp or cxp = any(candidate_fighter_ids))
  + (select count(*) from public.combat_status_events where fighter_id = cxp)
  + (select count(*) from public.combat_awards where fighter_id = cxp)
  + (select count(*) from public.combat_fighters where merged_into_id = cxp)
  into n;
  if n <> 0 then raise exception 'plan drift: % unhandled references on the duplicate', n; end if;

  /* ---- audit first: before-images captured by the database ---- */
  insert into public.ufc_identity_reconciliations (plan_sha256, kind, canonical_id, duplicate_id, evidence, before_images, operator)
  select PLAN, 'fighter_merge', x, xp,
    jsonb_build_object('name', 'Marcio Alexandre Jr.', 'espn_athlete_id', ESPN, 'ufcstats_id', UFCSTATS,
      'proof', 'ESPN athlete 3108776 event log contains the UFC Stats row''s UFC bouts on 2014-05-31, 2014-12-20 and 2015-12-12; the UFC 194 opponent is ESPN athlete 2504639 (Court McGee), matching the stored opponent row. Nickname, stance, reach and weight agree.',
      'approved', 'owner, 2026-09-14',
      'dob', jsonb_build_object('kept_espn', (select dob from public.ufc_fighters where id = x), 'ufcstats_printed', (select dob from public.ufc_fighters where id = xp)),
      'profile_conflicts_kept_espn', jsonb_build_object(
        'record', jsonb_build_object('espn', (select concat(record_w,'-',record_l,'-',record_d) from public.ufc_fighters where id = x), 'ufcstats', (select concat(record_w,'-',record_l,'-',record_d) from public.ufc_fighters where id = xp)),
        'height_in', jsonb_build_object('espn', (select height_in from public.ufc_fighters where id = x), 'ufcstats', (select height_in from public.ufc_fighters where id = xp)),
        'name', jsonb_build_object('espn', (select name from public.ufc_fighters where id = x), 'ufcstats', (select name from public.ufc_fighters where id = xp))),
      'combat', jsonb_build_object('canonical_combat_fighter_id', cx, 'merged_combat_fighter_id', cxp),
      'court_mcgee_bout', MCGEE_BOUT),
    jsonb_build_object(
      'ufc_fighters', (select jsonb_agg(to_jsonb(t)) from public.ufc_fighters t where t.id in (x, xp)),
      'ufc_fighter_aliases', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_aliases t where t.fighter_id in (x, xp)), '[]'),
      'ufc_bouts', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_bouts t where xp in (t.fighter_a_id, t.fighter_b_id)), '[]'),
      'ufc_bout_round_stats', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_bout_round_stats t where t.fighter_id = xp), '[]'),
      'ufc_fighter_dna_snapshots', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_dna_snapshots t where t.fighter_id = xp), '[]'),
      'ufc_fighter_stance_splits', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_stance_splits t where t.fighter_id = xp), '[]'),
      'ufc_fighter_bout_features', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_bout_features t where xp in (t.fighter_id, t.opponent_id)), '[]'),
      'ufc_alias_review_queue', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_alias_review_queue t where t.id = REVIEW_ITEM), '[]'),
      'combat_fighters', (select jsonb_agg(to_jsonb(t)) from public.combat_fighters t where t.id in (cx, cxp)),
      'combat_fighter_identities', coalesce((select jsonb_agg(to_jsonb(t)) from public.combat_fighter_identities t where t.combat_fighter_id in (cx, cxp)), '[]'),
      'combat_fighter_aliases', coalesce((select jsonb_agg(to_jsonb(t)) from public.combat_fighter_aliases t where t.combat_fighter_id in (cx, cxp)), '[]')),
    'scripts/reconcile/20260914_marcio_alexandre_merge.sql';

  /* ---- repoint the UFC career onto the canonical fighter ---- */
  update public.ufc_bouts set fighter_a_id = x, updated_at = now() where fighter_a_id = xp;
  get diagnostics n = row_count;
  update public.ufc_bouts set fighter_b_id = x, updated_at = now() where fighter_b_id = xp;
  get diagnostics nn = row_count;
  if n + nn <> 3 then raise exception 'bouts repointed % <> 3', n + nn; end if;
  counts := counts || jsonb_build_object('ufc_bouts_updated', n + nn);

  update public.ufc_bout_round_stats set fighter_id = x where fighter_id = xp;
  get diagnostics n = row_count;
  if n <> 9 then raise exception 'round rows % <> 9', n; end if;
  counts := counts || jsonb_build_object('ufc_bout_round_stats_updated', n);

  update public.ufc_fighter_bout_features set opponent_id = x where opponent_id = xp;
  get diagnostics n = row_count;
  if n <> 3 then raise exception 'opponent features % <> 3', n; end if;
  counts := counts || jsonb_build_object('ufc_fighter_bout_features_opponent_updated', n);

  delete from public.ufc_fighter_bout_features where fighter_id = xp;
  get diagnostics n = row_count;
  if n <> 3 then raise exception 'own features % <> 3', n; end if;
  counts := counts || jsonb_build_object('ufc_fighter_bout_features_deleted', n);

  delete from public.ufc_fighter_dna_snapshots where fighter_id = xp;
  get diagnostics n = row_count;
  if n <> 7 then raise exception 'dna snapshots % <> 7', n; end if;
  counts := counts || jsonb_build_object('ufc_fighter_dna_snapshots_deleted', n);

  delete from public.ufc_fighter_stance_splits where fighter_id = xp;
  get diagnostics n = row_count;
  if n <> 7 then raise exception 'stance splits % <> 7', n; end if;
  counts := counts || jsonb_build_object('ufc_fighter_stance_splits_deleted', n);

  /* sources differ (ufcstats / ufcstats_nickname vs espn / espn_nickname): no collision */
  update public.ufc_fighter_aliases set fighter_id = x where fighter_id = xp;
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'aliases % <> 2', n; end if;
  counts := counts || jsonb_build_object('ufc_fighter_aliases_updated', n);

  update public.ufc_alias_review_queue set status = 'resolved', resolved_fighter_id = x, resolved_at = now()
    where id = REVIEW_ITEM and resolved_at is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'review item % <> 1', n; end if;
  counts := counts || jsonb_build_object('ufc_alias_review_queue_resolved', n);

  /* ---- combat mirror: the duplicate becomes a merged record ---- */
  update public.combat_fighter_identities
    set combat_fighter_id = cx,
        evidence = jsonb_set(evidence, '{ufc_fighter_id}', to_jsonb(x::text)) || jsonb_build_object('merged_from_combat_fighter_id', cxp::text, 'reconciliation', PLAN)
    where combat_fighter_id = cxp;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'combat identities % <> 1', n; end if;
  counts := counts || jsonb_build_object('combat_fighter_identities_updated', n);

  /* the spelling variant moves; the nickname already exists on the canonical record and stays on the merged one */
  update public.combat_fighter_aliases a
    set combat_fighter_id = cx,
        evidence = a.evidence || jsonb_build_object('merged_from_combat_fighter_id', cxp::text, 'reconciliation', PLAN)
    where a.combat_fighter_id = cxp
      and not exists (select 1 from public.combat_fighter_aliases b where b.combat_fighter_id = cx and b.source_id = a.source_id and b.normalized = a.normalized);
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'combat aliases moved % <> 1', n; end if;
  counts := counts || jsonb_build_object('combat_fighter_aliases_updated', n);

  update public.combat_fighters set ufc_fighter_id = null, identity_state = 'merged', merged_into_id = cx, updated_at = now() where id = cxp;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'combat fighter % <> 1', n; end if;
  counts := counts || jsonb_build_object('combat_fighters_updated', n);

  /* ---- retire the duplicate, carry its source id and the profile fields the canonical row lacks ---- */
  create temporary table _marcio_dup on commit drop as select * from public.ufc_fighters where id = xp;
  delete from public.ufc_fighters where id = xp;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'duplicate delete % <> 1', n; end if;
  counts := counts || jsonb_build_object('ufc_fighters_deleted', n);
  update public.ufc_fighters f set
      ufcstats_id = UFCSTATS,
      career_slpm = coalesce(f.career_slpm, d.career_slpm),
      career_sapm = coalesce(f.career_sapm, d.career_sapm),
      career_str_acc = coalesce(f.career_str_acc, d.career_str_acc),
      career_str_def = coalesce(f.career_str_def, d.career_str_def),
      career_td_avg = coalesce(f.career_td_avg, d.career_td_avg),
      career_td_acc = coalesce(f.career_td_acc, d.career_td_acc),
      career_td_def = coalesce(f.career_td_def, d.career_td_def),
      career_sub_avg = coalesce(f.career_sub_avg, d.career_sub_avg),
      fight_history_count = coalesce(f.fight_history_count, d.fight_history_count),
      updated_at = now()
    from _marcio_dup d where f.id = x;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'canonical update % <> 1', n; end if;
  counts := counts || jsonb_build_object('ufc_fighters_updated', n);

  /* ---- post-conditions ---- */
  if (select count(*) from public.ufc_fighters) <> fighters_before - 1 then raise exception 'post: fighter count'; end if;
  if exists (select 1 from public.ufc_fighters where id = xp) then raise exception 'post: duplicate still present'; end if;
  if exists (select 1 from public.ufc_bouts where xp in (fighter_a_id, fighter_b_id)) then raise exception 'post: bouts still reference duplicate'; end if;
  if (select ufcstats_id from public.ufc_fighters where id = x) is distinct from UFCSTATS
    or (select espn_athlete_id from public.ufc_fighters where id = x) is distinct from ESPN then raise exception 'post: canonical ids'; end if;
  if (select count(*) from public.ufc_bouts where x in (fighter_a_id, fighter_b_id)) <> 4 then raise exception 'post: canonical bout count'; end if;
  if (select count(*) from public.ufc_bout_round_stats where fighter_id = x) <> 9 then raise exception 'post: canonical round rows'; end if;
  if (select count(*) from public.ufc_fighter_aliases where fighter_id = x) <> 4 then raise exception 'post: canonical aliases'; end if;
  if (select fighter_a_id from public.ufc_bouts where id = MCGEE_BOUT) is distinct from MCGEE
    or (select fighter_b_id from public.ufc_bouts where id = MCGEE_BOUT) is distinct from x
    or (select winner_id from public.ufc_bout_results where bout_id = MCGEE_BOUT) is distinct from MCGEE
    or (select e.event_date from public.ufc_events e join public.ufc_bouts b on b.event_id = e.id where b.id = MCGEE_BOUT) is distinct from '2015-12-12'::date then
    raise exception 'post: Court McGee bout identity'; end if;
  if (select count(*) from public.combat_fighters where ufc_fighter_id = x) <> 1 then raise exception 'post: combat mirror not single'; end if;
  if (select merged_into_id from public.combat_fighters where id = cxp) is distinct from cx then raise exception 'post: combat merge not recorded'; end if;
  if (select count(*) from public.combat_fighter_identities where combat_fighter_id = cx) <> 2 then raise exception 'post: combat identities'; end if;

  update public.ufc_identity_reconciliations set evidence = evidence || jsonb_build_object('row_counts', counts)
    where plan_sha256 = PLAN and duplicate_id = xp;
  if (select count(*) from public.ufc_identity_reconciliations where plan_sha256 = PLAN) <> 1 then raise exception 'post: audit rows'; end if;

  select jsonb_build_object(
    'ufc_events',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_events t),
    'ufc_rankings',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_rankings t),
    'ufc_fighters',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_fighters t where t.id <> all(touched)),
    'ufc_bouts',                (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_bouts t where t.fighter_a_id <> all(touched) and t.fighter_b_id <> all(touched)),
    'ufc_bout_results',         (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.bout_id), ''))) from public.ufc_bout_results t),
    'ufc_bout_round_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.bout_id, t.fighter_id, t.round), ''))) from public.ufc_bout_round_stats t where t.fighter_id <> all(touched)),
    'ufc_bout_fight_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.bout_id, t.fighter_id), ''))) from public.ufc_bout_fight_stats t),
    'ufc_fighter_bout_features',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t::text), ''))) from public.ufc_fighter_bout_features t where t.fighter_id <> all(touched) and (t.opponent_id is null or t.opponent_id <> all(touched))),
    'ufc_fighter_dna_snapshots',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by md5(t::text)), ''))) from public.ufc_fighter_dna_snapshots t where t.fighter_id <> xp),
    'ufc_fighter_stance_splits',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t::text), ''))) from public.ufc_fighter_stance_splits t where t.fighter_id <> xp),
    'ufc_fighter_aliases',      (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_fighter_aliases t where t.fighter_id <> all(touched)),
    'ufc_alias_review_queue',   (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_alias_review_queue t where t.id <> REVIEW_ITEM),
    'ufc_images',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_images t),
    'ufc_dwcs_outcome_claims',  (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_dwcs_outcome_claims t),
    'ufc_identity_reconciliations', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.ufc_identity_reconciliations t where t.plan_sha256 <> PLAN),
    'combat_fighters',          (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.combat_fighters t where t.id <> all(touched_combat)),
    'combat_fighter_identities',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.combat_fighter_identities t where t.combat_fighter_id <> all(touched_combat)),
    'combat_fighter_aliases',   (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))) from public.combat_fighter_aliases t where t.combat_fighter_id <> all(touched_combat))
  ) into fp_after;
  for k in select jsonb_object_keys(fp_before) loop
    if fp_before->k is distinct from fp_after->k then
      raise exception 'post: unrelated rows changed in % (before % after %)', k, fp_before->k, fp_after->k;
    end if;
  end loop;
  update public.ufc_identity_reconciliations
    set evidence = evidence || jsonb_build_object('unrelated_fingerprint', fp_after, 'unrelated_unchanged', true)
    where plan_sha256 = PLAN;
  raise notice 'marcio merge ok: %', counts;
end
$merge$;

commit;
