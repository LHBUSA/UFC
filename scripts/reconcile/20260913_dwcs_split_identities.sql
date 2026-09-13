-- DWCS split fighter identities — fighter merges, 2026-09-13.
--
-- Two Contender Series fighters each had a second ufc_fighters row carrying
-- their UFC career: the ESPN ingest created one from the DWCS bout (ESPN
-- athlete id only), the UFC Stats backfill another from the UFC bouts (UFC
-- Stats id only). Identity was proven on SOURCE IDS, never on names:
--
--   Yorgan De Castro  ESPN athlete 4423213's event log contains all four UFC
--                     bouts of UFC Stats fighter 1eff7bc0f815b270, and each ESPN
--                     competition reproduces opponent, result, method and round
--                     (Tafa W KO R1 / Hardy L DEC / Felipe L DEC / Danho L KO R1);
--                     opponent ESPN ids agree where stored (Hardy 2220951, Tafa
--                     4566145). DOB differs by exactly one year: ESPN 1987-12-19
--                     is kept, UFC Stats' 1986-12-19 is recorded in evidence.
--   Luis Pajuelo      ESPN athlete 5144312's event log contains UFC Fight Night:
--                     Ribas vs. Namajunas; ESPN competition 401637045 and UFC
--                     Stats fighter e530df53922f413e both record the R1
--                     submission loss to Fernando Padilla. DOB 1994-12-12 (kept)
--                     vs 1994-12-18; height, reach, weight, stance, record and
--                     nickname agree.
--
-- NOT MERGED, AND NOT TOUCHED: Joey Gomez. ESPN athlete 4357555 (DWCS 2018,
-- lightweight, born 1989-08-28) has no UFC event in ESPN's log; UFC Stats
-- 0778f94eb5d588a5 is a different man (2016 UFC bantamweight, born 1986-07-21).
-- This transaction asserts both Gomez rows are byte-identical before and after.
--
-- Canonical = the ESPN row (the ingest's identity key). The UFC Stats row is the
-- duplicate: every reference moves to the canonical id, its UFC Stats id moves
-- onto the canonical row, and it is deleted. Order and audit contract follow
-- scripts/reconcile/render_merge_sql.py, plus the combat mirror that renderer
-- predates (combat_fighters.ufc_fighter_id is ON DELETE RESTRICT): the
-- duplicate's combat record becomes identity_state='merged' pointing at the
-- canonical combat record, and its UFC Stats identity row moves with it.
-- Derived per-fighter rows of the duplicate (DNA snapshots, stance splits, own
-- bout features) are dropped for a manual Fight DNA rebuild of the canonical id.
--
-- FAIL CLOSED. Exact pre-state counts are asserted; each statement's row count
-- is asserted against the plan; a fingerprint of every UNRELATED row in the
-- touched tables (fighters, bouts, events, results incl. scorecards, rankings,
-- round stats, fight totals, features, DNA, aliases, combat, claims) must be
-- identical after the merge. Any difference raises and the whole transaction
-- rolls back. Before-images and per-table row counts are written to
-- ufc_identity_reconciliations.
--
-- Run: proof (BEGIN ... ROLLBACK) first, then the same body as apply:
--   pwsh scripts/db/apply_supabase_migration.ps1 -Mode apply -Paths scripts/reconcile/20260913_dwcs_split_identities.sql

begin;

do $merge$
declare
  PLAN constant text := 'dwcs-split-identities-2026-09-13';
  pairs constant jsonb := '[
    {"name":"Yorgan De Castro","x":"bae9a77f-a47a-428d-859b-3e4cb3175210","xp":"2c1fcb9e-8252-4d39-ae99-e77749c400ef","espn":"4423213","ufcstats":"1eff7bc0f815b270","cx":"d79ff2c7-c609-4b81-b4d8-e480aa519df8","cxp":"a4d9347e-7554-4f18-9868-9becac9d2619",
     "expect":{"x_bouts":1,"xp_bouts":4,"xp_results_won":1,"xp_round_stats":8,"xp_features_own":4,"xp_features_as_opponent":4,"xp_dna":6,"xp_stance":11,"xp_aliases":2,"xp_alias_dupes":0,"xp_review_open":0,"cxp_identities":1}},
    {"name":"Luis Pajuelo","x":"a56ac7e3-51e9-49b6-a7d6-64d27f1c4bb9","xp":"3e686ea6-baee-4c63-a29f-3820c51e82eb","espn":"5144312","ufcstats":"e530df53922f413e","cx":"ac6b2163-d502-40ef-b3b2-1538b1cac079","cxp":"22e68c3a-0a6d-4798-bd36-0eaa466fc183",
     "expect":{"x_bouts":1,"xp_bouts":1,"xp_results_won":0,"xp_round_stats":1,"xp_features_own":1,"xp_features_as_opponent":1,"xp_dna":3,"xp_stance":3,"xp_aliases":2,"xp_alias_dupes":0,"xp_review_open":0,"cxp_identities":1}}
  ]'::jsonb;
  /* Every fighter id this transaction may touch, plus the two Gomez rows it must not. */
  touched uuid[] := array['bae9a77f-a47a-428d-859b-3e4cb3175210','2c1fcb9e-8252-4d39-ae99-e77749c400ef','a56ac7e3-51e9-49b6-a7d6-64d27f1c4bb9','3e686ea6-baee-4c63-a29f-3820c51e82eb']::uuid[];
  touched_combat uuid[] := array['d79ff2c7-c609-4b81-b4d8-e480aa519df8','a4d9347e-7554-4f18-9868-9becac9d2619','ac6b2163-d502-40ef-b3b2-1538b1cac079','22e68c3a-0a6d-4798-bd36-0eaa466fc183']::uuid[];
  gomez uuid[] := array['ec1adf5b-e56d-4677-a3a8-edaa042929f2','227b1c3f-36d4-4d5f-9a13-d78b65a81a5f']::uuid[];
  p jsonb; e jsonb; x uuid; xp uuid; cx uuid; cxp uuid; n bigint; nn bigint;
  counts jsonb; fp_before jsonb; fp_after jsonb; gomez_before text; gomez_after text; k text;
begin
  /* ---- fingerprint of everything this merge must NOT change ---- */
  select jsonb_build_object(
    'ufc_events',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_events t),
    'ufc_rankings',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_rankings t),
    'ufc_fighters',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id <> all(touched)),
    'ufc_bouts',                (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_bouts t where t.fighter_a_id <> all(touched) and t.fighter_b_id <> all(touched)),
    'ufc_bout_results',         (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id), ''))) from public.ufc_bout_results t where t.winner_id is null or t.winner_id <> all(touched)),
    'ufc_bout_round_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id, t.fighter_id, t.round), ''))) from public.ufc_bout_round_stats t where t.fighter_id <> all(touched)),
    'ufc_bout_fight_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id, t.fighter_id), ''))) from public.ufc_bout_fight_stats t where t.fighter_id <> all(touched)),
    'ufc_fighter_bout_features',(select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t::text), ''))) from public.ufc_fighter_bout_features t where t.fighter_id <> all(touched) and (t.opponent_id is null or t.opponent_id <> all(touched))),
    'ufc_fighter_dna_snapshots',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by md5(t::text)), ''))) from public.ufc_fighter_dna_snapshots t where t.fighter_id <> all(touched)),
    'ufc_fighter_stance_splits',(select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t::text), ''))) from public.ufc_fighter_stance_splits t where t.fighter_id <> all(touched)),
    'ufc_fighter_aliases',      (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighter_aliases t where t.fighter_id <> all(touched)),
    'ufc_images',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_images t),
    'ufc_dwcs_outcome_claims',  (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_dwcs_outcome_claims t),
    'combat_fighters',          (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighters t where t.id <> all(touched_combat)),
    'combat_fighter_identities',(select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighter_identities t where t.combat_fighter_id <> all(touched_combat))
  ) into fp_before;
  select md5(string_agg(t::text, '|' order by t.id)) into gomez_before from public.ufc_fighters t where t.id = any(gomez);

  for p in select * from jsonb_array_elements(pairs) loop
    x := (p->>'x')::uuid; xp := (p->>'xp')::uuid; cx := (p->>'cx')::uuid; cxp := (p->>'cxp')::uuid; e := p->'expect';
    counts := '{}'::jsonb;

    /* ---- drift guards: the database must still match the proven plan ---- */
    if (select espn_athlete_id from public.ufc_fighters where id = x) is distinct from p->>'espn'
      or (select ufcstats_id from public.ufc_fighters where id = x) is not null then
      raise exception 'plan drift: canonical % is not the ESPN-only row', p->>'name'; end if;
    if (select ufcstats_id from public.ufc_fighters where id = xp) is distinct from p->>'ufcstats'
      or (select espn_athlete_id from public.ufc_fighters where id = xp) is not null then
      raise exception 'plan drift: duplicate % is not the UFC Stats-only row', p->>'name'; end if;
    if (select ufc_fighter_id from public.combat_fighters where id = cx) is distinct from x
      or (select ufc_fighter_id from public.combat_fighters where id = cxp) is distinct from xp
      or (select identity_state from public.combat_fighters where id = cxp) <> 'verified' then
      raise exception 'plan drift: combat mirror for %', p->>'name'; end if;
    if exists (select 1 from public.ufc_bouts where (fighter_a_id = x and fighter_b_id = xp) or (fighter_a_id = xp and fighter_b_id = x)) then
      raise exception 'plan drift: % canonical and duplicate share a bout', p->>'name'; end if;
    select count(*) into n from public.ufc_bouts where x in (fighter_a_id, fighter_b_id);
    if n <> (e->>'x_bouts')::int then raise exception 'plan drift: % canonical bouts % <> %', p->>'name', n, e->>'x_bouts'; end if;
    select count(*) into n from public.ufc_bouts where xp in (fighter_a_id, fighter_b_id);
    if n <> (e->>'xp_bouts')::int then raise exception 'plan drift: % duplicate bouts % <> %', p->>'name', n, e->>'xp_bouts'; end if;
    select count(*) into n from public.ufc_bout_round_stats where fighter_id = xp;
    if n <> (e->>'xp_round_stats')::int then raise exception 'plan drift: % duplicate round rows % <> %', p->>'name', n, e->>'xp_round_stats'; end if;
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
    + (select count(*) from public.ufc_model_predictions where xp in (fighter_a_id, fighter_b_id, pick_fighter_id))
    + (select count(*) from public.ufc_model_backtest_predictions where xp in (fighter_1_id, fighter_2_id, pick_fighter_id, actual_winner_id))
    + (select count(*) from public.ufc_model_prediction_grades where winner_id = xp)
    + (select count(*) from public.ufc_action_events where xp in (fighter_id, opponent_id))
    + (select count(*) from public.ufc_dna_build_runs where fighter_id = xp)
    + (select count(*) from public.ufc_dwcs_outcome_claims where fighter_id = xp)
    + (select count(*) from public.ufc_articles where primary_fighter_id = xp or xp = any(fighter_ids))
    + (select count(*) from public.ufc_news_items where primary_fighter_id = xp or xp = any(fighter_ids) or xp = any(secondary_fighter_ids) or xp = any(mentioned_fighter_ids))
    + (select count(*) from public.ufc_videos where xp = any(fighter_ids))
    + (select count(*) from public.ufc_alias_review_queue where resolved_fighter_id = xp)
    + (select count(*) from public.ufc_fight_state_ledger where fighters::text like '%' || xp::text || '%')
    + (select count(*) from public.combat_bouts where cxp in (fighter_a_id, fighter_b_id))
    + (select count(*) from public.combat_round_stats where fighter_id = cxp)
    + (select count(*) from public.combat_bout_results where winner_id = cxp)
    + (select count(*) from public.combat_weigh_ins where fighter_id = cxp)
    + (select count(*) from public.combat_rankings where fighter_id = cxp)
    + (select count(*) from public.combat_identity_review_queue where resolved_fighter_id = cxp)
    + (select count(*) from public.combat_status_events where fighter_id = cxp)
    + (select count(*) from public.combat_awards where fighter_id = cxp)
    into n;
    if n <> 0 then raise exception 'plan drift: % unhandled references on duplicate %', n, p->>'name'; end if;

    /* ---- audit first: before-images captured by the database ---- */
    insert into public.ufc_identity_reconciliations (plan_sha256, kind, canonical_id, duplicate_id, evidence, before_images, operator)
    select PLAN, 'fighter_merge', x, xp,
      jsonb_build_object('name', p->>'name', 'espn_athlete_id', p->>'espn', 'ufcstats_id', p->>'ufcstats',
        'proof', 'ESPN athlete eventlog contains every UFC bout of the UFC Stats row with matching opponent, result, method and round',
        'dob', jsonb_build_object('kept_espn', (select dob from public.ufc_fighters where id = x), 'ufcstats_printed', (select dob from public.ufc_fighters where id = xp)),
        'combat', jsonb_build_object('canonical_combat_fighter_id', cx, 'merged_combat_fighter_id', cxp)),
      jsonb_build_object(
        'ufc_fighters', (select jsonb_agg(to_jsonb(t)) from public.ufc_fighters t where t.id in (x, xp)),
        'ufc_fighter_aliases', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_aliases t where t.fighter_id in (x, xp)), '[]'),
        'ufc_bouts', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_bouts t where xp in (t.fighter_a_id, t.fighter_b_id)), '[]'),
        'ufc_bout_results_won', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_bout_results t where t.winner_id = xp), '[]'),
        'ufc_bout_round_stats', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_bout_round_stats t where t.fighter_id = xp), '[]'),
        'ufc_fighter_dna_snapshots', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_dna_snapshots t where t.fighter_id = xp), '[]'),
        'ufc_fighter_stance_splits', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_stance_splits t where t.fighter_id = xp), '[]'),
        'ufc_fighter_bout_features', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_fighter_bout_features t where xp in (t.fighter_id, t.opponent_id)), '[]'),
        'ufc_alias_review_queue', coalesce((select jsonb_agg(to_jsonb(t)) from public.ufc_alias_review_queue t where t.resolved_at is null and xp = any(t.candidate_fighter_ids)), '[]'),
        'combat_fighters', (select jsonb_agg(to_jsonb(t)) from public.combat_fighters t where t.id in (cx, cxp)),
        'combat_fighter_identities', coalesce((select jsonb_agg(to_jsonb(t)) from public.combat_fighter_identities t where t.combat_fighter_id in (cx, cxp)), '[]')),
      'scripts/reconcile/20260913_dwcs_split_identities.sql';

    /* ---- repoint the UFC career onto the canonical fighter ---- */
    update public.ufc_bouts set fighter_a_id = x, updated_at = now() where fighter_a_id = xp;
    get diagnostics n = row_count;
    update public.ufc_bouts set fighter_b_id = x, updated_at = now() where fighter_b_id = xp;
    get diagnostics nn = row_count;
    if n + nn <> (e->>'xp_bouts')::int then raise exception '% bouts repointed % <> plan %', p->>'name', n + nn, e->>'xp_bouts'; end if;
    counts := counts || jsonb_build_object('ufc_bouts_updated', n + nn);

    update public.ufc_bout_round_stats set fighter_id = x where fighter_id = xp;
    get diagnostics n = row_count;
    if n <> (e->>'xp_round_stats')::int then raise exception '% round rows % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_bout_round_stats_updated', n);

    update public.ufc_bout_results set winner_id = x where winner_id = xp;
    get diagnostics n = row_count;
    if n <> (e->>'xp_results_won')::int then raise exception '% results % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_bout_results_updated', n);

    /* An opponent's feature row stays valid with the canonical id; the
       duplicate's own derived rows are rebuilt from the merged career. */
    update public.ufc_fighter_bout_features set opponent_id = x where opponent_id = xp;
    get diagnostics n = row_count;
    if n <> (e->>'xp_features_as_opponent')::int then raise exception '% opponent features % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighter_bout_features_opponent_updated', n);

    delete from public.ufc_fighter_bout_features where fighter_id = xp;
    get diagnostics n = row_count;
    if n <> (e->>'xp_features_own')::int then raise exception '% own features % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighter_bout_features_deleted', n);

    delete from public.ufc_fighter_dna_snapshots where fighter_id = xp;
    get diagnostics n = row_count;
    if n <> (e->>'xp_dna')::int then raise exception '% dna snapshots % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighter_dna_snapshots_deleted', n);

    delete from public.ufc_fighter_stance_splits where fighter_id = xp;
    get diagnostics n = row_count;
    if n <> (e->>'xp_stance')::int then raise exception '% stance splits % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighter_stance_splits_deleted', n);

    delete from public.ufc_fighter_aliases a where a.fighter_id = xp
      and exists (select 1 from public.ufc_fighter_aliases b where b.fighter_id = x and b.source = a.source and b.normalized = a.normalized);
    get diagnostics n = row_count;
    if n <> (e->>'xp_alias_dupes')::int then raise exception '% alias dupes % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighter_aliases_deleted', n);
    update public.ufc_fighter_aliases set fighter_id = x where fighter_id = xp;
    get diagnostics n = row_count;
    if n <> (e->>'xp_aliases')::int - (e->>'xp_alias_dupes')::int then raise exception '% aliases % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighter_aliases_updated', n);

    update public.ufc_alias_review_queue set status = 'resolved', resolved_fighter_id = x, resolved_at = now()
      where resolved_at is null and xp = any(candidate_fighter_ids);
    get diagnostics n = row_count;
    if n <> (e->>'xp_review_open')::int then raise exception '% review items % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_alias_review_queue_updated', n);

    /* ---- combat mirror: the duplicate becomes a merged record ---- */
    update public.combat_fighter_identities
      set combat_fighter_id = cx,
          evidence = jsonb_set(evidence, '{ufc_fighter_id}', to_jsonb(x::text)) || jsonb_build_object('merged_from_combat_fighter_id', cxp::text, 'reconciliation', PLAN)
      where combat_fighter_id = cxp;
    get diagnostics n = row_count;
    if n <> (e->>'cxp_identities')::int then raise exception '% combat identities % <> plan', p->>'name', n; end if;
    counts := counts || jsonb_build_object('combat_fighter_identities_updated', n);
    update public.combat_fighters set ufc_fighter_id = null, identity_state = 'merged', merged_into_id = cx, updated_at = now() where id = cxp;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '% combat fighter % <> 1', p->>'name', n; end if;
    counts := counts || jsonb_build_object('combat_fighters_updated', n);

    /* ---- retire the duplicate, carry its source id ---- */
    delete from public.ufc_fighters where id = xp;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '% duplicate delete % <> 1', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighters_deleted', n);
    update public.ufc_fighters set ufcstats_id = p->>'ufcstats', updated_at = now() where id = x;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '% canonical update % <> 1', p->>'name', n; end if;
    counts := counts || jsonb_build_object('ufc_fighters_updated', n);

    /* ---- post-conditions for the pair ---- */
    if exists (select 1 from public.ufc_fighters where id = xp) then raise exception 'post: duplicate % still present', p->>'name'; end if;
    if exists (select 1 from public.ufc_bouts where xp in (fighter_a_id, fighter_b_id)) then raise exception 'post: bouts still reference duplicate %', p->>'name'; end if;
    if (select ufcstats_id from public.ufc_fighters where id = x) is distinct from p->>'ufcstats'
      or (select espn_athlete_id from public.ufc_fighters where id = x) is distinct from p->>'espn' then raise exception 'post: canonical % ids', p->>'name'; end if;
    if (select count(*) from public.ufc_bouts where x in (fighter_a_id, fighter_b_id)) <> (e->>'x_bouts')::int + (e->>'xp_bouts')::int then raise exception 'post: canonical % bout count', p->>'name'; end if;
    if (select count(*) from public.combat_fighters where ufc_fighter_id = x) <> 1 then raise exception 'post: combat mirror % not single', p->>'name'; end if;
    if (select merged_into_id from public.combat_fighters where id = cxp) is distinct from cx then raise exception 'post: combat merge % not recorded', p->>'name'; end if;

    update public.ufc_identity_reconciliations set evidence = evidence || jsonb_build_object('row_counts', counts)
      where plan_sha256 = PLAN and duplicate_id = xp;
  end loop;

  /* ---- global invariants ---- */
  if (select count(*) from public.ufc_identity_reconciliations where plan_sha256 = PLAN) <> 2 then raise exception 'post: audit rows'; end if;
  select md5(string_agg(t::text, '|' order by t.id)) into gomez_after from public.ufc_fighters t where t.id = any(gomez);
  if gomez_after is distinct from gomez_before then raise exception 'post: Joey Gomez rows changed'; end if;
  /* The fingerprint excluded the two canonical ids before and after; the
     duplicates are gone, so the unrelated set is the same set of rows. */
  touched := array['bae9a77f-a47a-428d-859b-3e4cb3175210','a56ac7e3-51e9-49b6-a7d6-64d27f1c4bb9','2c1fcb9e-8252-4d39-ae99-e77749c400ef','3e686ea6-baee-4c63-a29f-3820c51e82eb']::uuid[];
  select jsonb_build_object(
    'ufc_events',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_events t),
    'ufc_rankings',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_rankings t),
    'ufc_fighters',             (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id <> all(touched)),
    'ufc_bouts',                (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_bouts t where t.fighter_a_id <> all(touched) and t.fighter_b_id <> all(touched)),
    'ufc_bout_results',         (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id), ''))) from public.ufc_bout_results t where t.winner_id is null or t.winner_id <> all(touched)),
    'ufc_bout_round_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id, t.fighter_id, t.round), ''))) from public.ufc_bout_round_stats t where t.fighter_id <> all(touched)),
    'ufc_bout_fight_stats',     (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id, t.fighter_id), ''))) from public.ufc_bout_fight_stats t where t.fighter_id <> all(touched)),
    'ufc_fighter_bout_features',(select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t::text), ''))) from public.ufc_fighter_bout_features t where t.fighter_id <> all(touched) and (t.opponent_id is null or t.opponent_id <> all(touched))),
    'ufc_fighter_dna_snapshots',(select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(t::text), '|' order by md5(t::text)), ''))) from public.ufc_fighter_dna_snapshots t where t.fighter_id <> all(touched)),
    'ufc_fighter_stance_splits',(select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t::text), ''))) from public.ufc_fighter_stance_splits t where t.fighter_id <> all(touched)),
    'ufc_fighter_aliases',      (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighter_aliases t where t.fighter_id <> all(touched)),
    'ufc_images',               (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_images t),
    'ufc_dwcs_outcome_claims',  (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_dwcs_outcome_claims t),
    'combat_fighters',          (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighters t where t.id <> all(touched_combat)),
    'combat_fighter_identities',(select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighter_identities t where t.combat_fighter_id <> all(touched_combat))
  ) into fp_after;
  for k in select jsonb_object_keys(fp_before) loop
    if fp_before->k is distinct from fp_after->k then
      raise exception 'post: unrelated rows changed in % (before % after %)', k, fp_before->k, fp_after->k;
    end if;
  end loop;
  update public.ufc_identity_reconciliations
    set evidence = evidence || jsonb_build_object('unrelated_fingerprint', fp_after, 'unrelated_unchanged', true, 'joey_gomez_untouched', true)
    where plan_sha256 = PLAN;
end
$merge$;

commit;
