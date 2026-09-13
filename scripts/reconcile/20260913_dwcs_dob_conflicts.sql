-- DWCS merge follow-up: the DOB disagreement is UNRESOLVED, and says so.
--
-- The 2026-09-13 merges (20260913_dwcs_split_identities.sql) proved identity
-- on source ids and kept the ESPN row as canonical. That selected the ESPN
-- DOB as the row's value. It did NOT resolve the date of birth:
--
--   Yorgan De Castro   ESPN 1987-12-19   UFC Stats 1986-12-19
--   Luis Pajuelo       ESPN 1994-12-12   UFC Stats 1994-12-18
--
-- Per-source evidence already lives in combat_fighter_identities (one row per
-- source namespace, each with its own dob) under the canonical combat fighter.
-- combat_source_claims cannot hold it: its guard admits only approved_ingest /
-- reference_only sources, and ESPN and UFC Stats are identity_only. Source
-- policy is not changed for this.
--
-- So this records the unresolved attribute on the reconciliation audit and
-- changes no fighter value:
--   - both source values and their external ids are written into
--     evidence.attribute_conflicts.dob with status 'unresolved'
--   - the existing evidence.dob {kept_espn, ufcstats_printed} is preserved
--   - ufc_fighters.dob and combat_fighters.dob stay as they are. They are NOT
--     nulled or switched: web/lib/espnPortraitGate.ts and verifiedPortraits.ts
--     show an ESPN headshot only when ufc_fighters.dob equals the ESPN
--     athlete's DOB, and that row value is the ESPN athlete's own DOB.
--
-- Guarded: aborts unless the database still holds exactly these values.

begin;

do $dob$
declare
  PLAN constant text := 'dwcs-split-identities-2026-09-13';
  rows constant jsonb := '[
    {"name":"Yorgan De Castro","canonical":"bae9a77f-a47a-428d-859b-3e4cb3175210","espn":"4423213","espn_dob":"1987-12-19","ufcstats":"1eff7bc0f815b270","ufcstats_dob":"1986-12-19"},
    {"name":"Luis Pajuelo","canonical":"a56ac7e3-51e9-49b6-a7d6-64d27f1c4bb9","espn":"5144312","espn_dob":"1994-12-12","ufcstats":"e530df53922f413e","ufcstats_dob":"1994-12-18"}
  ]'::jsonb;
  r jsonb; x uuid; n int; before_fighters text; after_fighters text;
begin
  select md5(string_agg(t::text, '|' order by t.id)) into before_fighters
    from public.ufc_fighters t where t.id in ('bae9a77f-a47a-428d-859b-3e4cb3175210', 'a56ac7e3-51e9-49b6-a7d6-64d27f1c4bb9');

  for r in select * from jsonb_array_elements(rows) loop
    x := (r->>'canonical')::uuid;
    if (select dob::text from public.ufc_fighters where id = x) is distinct from r->>'espn_dob' then
      raise exception 'drift: % canonical dob is not the ESPN value', r->>'name'; end if;
    select count(*) into n
      from public.combat_fighters c
      join public.combat_fighter_identities ci on ci.combat_fighter_id = c.id
      join public.combat_sources s on s.id = ci.source_id
     where c.ufc_fighter_id = x
       and ((s.source_key = 'espn' and ci.external_id = r->>'espn' and ci.dob::text = r->>'espn_dob')
         or (s.source_key = 'ufcstats' and ci.external_id = r->>'ufcstats' and ci.dob::text = r->>'ufcstats_dob'));
    if n <> 2 then raise exception 'drift: % per-source DOB evidence (% of 2 rows)', r->>'name', n; end if;
    if (select evidence->'dob'->>'kept_espn' from public.ufc_identity_reconciliations where plan_sha256 = PLAN and canonical_id = x) is distinct from r->>'espn_dob'
      or (select evidence->'dob'->>'ufcstats_printed' from public.ufc_identity_reconciliations where plan_sha256 = PLAN and canonical_id = x) is distinct from r->>'ufcstats_dob' then
      raise exception 'drift: % reconciliation DOB evidence', r->>'name'; end if;

    update public.ufc_identity_reconciliations
       set evidence = evidence || jsonb_build_object('attribute_conflicts', coalesce(evidence->'attribute_conflicts', '{}'::jsonb) || jsonb_build_object('dob', jsonb_build_object(
             'status', 'unresolved',
             'values', jsonb_build_array(
               jsonb_build_object('source', 'espn', 'external_id', r->>'espn', 'dob', r->>'espn_dob'),
               jsonb_build_object('source', 'ufcstats', 'external_id', r->>'ufcstats', 'dob', r->>'ufcstats_dob')),
             'row_value', r->>'espn_dob',
             'row_value_basis', 'ESPN row chosen as merge canonical by identity key. That is not a DOB resolution.',
             'not_changed_because', 'espnPortraitGate / verifiedPortraits confirm an ESPN headshot only when ufc_fighters.dob equals the ESPN athlete DOB',
             'evidence_location', 'combat_fighter_identities (espn + ufcstats rows under the canonical combat fighter)',
             'flagged_at', now())))
     where plan_sha256 = PLAN and canonical_id = x;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '% audit row update % <> 1', r->>'name', n; end if;
  end loop;

  select md5(string_agg(t::text, '|' order by t.id)) into after_fighters
    from public.ufc_fighters t where t.id in ('bae9a77f-a47a-428d-859b-3e4cb3175210', 'a56ac7e3-51e9-49b6-a7d6-64d27f1c4bb9');
  if after_fighters is distinct from before_fighters then raise exception 'post: fighter rows changed'; end if;
  if (select count(*) from public.ufc_identity_reconciliations where plan_sha256 = PLAN and evidence->'attribute_conflicts'->'dob'->>'status' = 'unresolved') <> 2 then
    raise exception 'post: unresolved DOB flags'; end if;
end
$dob$;

commit;
