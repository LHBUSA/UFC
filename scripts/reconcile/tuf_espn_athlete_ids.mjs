#!/usr/bin/env node
/**
 * TUF contestants: attach ESPN athlete ids through one exact finale card.
 * The generic form of scripts/reconcile/tuf1_espn_athlete_ids.mjs (applied
 * 2026-09-13), with the same planner, guards and audit contract.
 *
 *   UFC_ENV_FILE=... node scripts/reconcile/tuf_espn_athlete_ids.mjs \
 *     --season tuf-2 --our-event <ufc_events id> --espn-event 400254173 \
 *     --espn-name "Ultimate Fighter 2 Finale" --espn-date 2005-11-06T02:00 --expected 10 --date 2026-09-13
 *
 * Read-only. The expected set is every contestant of the season (roster and
 * pre-draft cast, by the ids the archive's identity registry decided) who has a
 * bout on our finale event — nothing wider. Only a clean plan (expected ==
 * mapped, 0 ambiguous, 0 conflicting, 0 duplicate ids, combat mirror as
 * expected) writes:
 *   scripts/reconcile/evidence/<season>_espn_athlete_ids.<date>.json
 *   scripts/reconcile/<yyyymmdd>_<season>_espn_athlete_ids.sql
 * Proof first (BEGIN … ROLLBACK), then apply, with scripts/db/apply_supabase_migration.ps1.
 * No DOB is written: where ESPN or a commission record disagrees with the
 * canonical date, all values go into the audit row's evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planEspnIdBackfill, fold } from '../tuf/lib/espnFinaleIdentity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const SEASON = opt('--season');
const EVENT_ID = opt('--our-event');
const ESPN_EVENT = opt('--espn-event');
const ESPN_NAME = opt('--espn-name');
const ESPN_DATE = opt('--espn-date');
const EXPECTED = Number(opt('--expected'));
const DATE = opt('--date');
if (!SEASON || !EVENT_ID || !ESPN_EVENT || !ESPN_NAME || !ESPN_DATE || !EXPECTED || !DATE) { console.error('usage: --season --our-event --espn-event --espn-name --espn-date --expected --date'); process.exit(2); }
const PLAN = `${SEASON.replace(/-/g, '')}-espn-athlete-ids-${DATE}`;
const ESPN_SOURCE_ID = 'cd71b196-8197-4df4-a806-26a78678d04b';
const SQL_REL = `scripts/reconcile/${DATE.replace(/-/g, '')}_${SEASON.replace(/-/g, '')}_espn_athlete_ids.sql`;

const env = { ...process.env };
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const q = async (p) => { const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`${p.split('?')[0]} ${r.status} ${await r.text()}`); return r.json(); };
const j = async (u) => { const r = await fetch(u.replace(/^http:/, 'https:')); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); };
const one = (v) => (Array.isArray(v) ? v[0] : v);
const stop = (m) => { console.error(`STOP: ${m}`); process.exit(1); };

const season = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons', `${SEASON}.json`), 'utf8'));
const cast = [...season.teams.flatMap((t) => t.roster), ...(season.pre_draft_cast || [])].filter((r) => r.fighter_id);
const castIds = [...new Set(cast.map((r) => r.fighter_id))];

const boutRows = await q(`ufc_bouts?select=id,fighter_a_id,fighter_b_id,result:ufc_bout_results(winner_id,round)&event_id=eq.${EVENT_ID}`);
const bouts = boutRows.map((b) => ({ id: b.id, fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id, winner_id: one(b.result)?.winner_id ?? null, round: one(b.result)?.round ?? null }));
const onCard = castIds.filter((id) => bouts.some((b) => b.fighter_a_id === id || b.fighter_b_id === id));
const fighters = await q(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,dob&id=in.(${onCard})`);
const expected = fighters.map((f) => ({ id: f.id, name: f.name }));
if (expected.length !== EXPECTED) stop(`expected ${EXPECTED} contestants on our finale card, found ${expected.length}`);
const oppIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))].filter((x) => !onCard.includes(x));
const others = oppIds.length ? await q(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,dob&id=in.(${oppIds})`) : [];

const event = await j(`https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${ESPN_EVENT}?lang=en&region=us`);
if (!String(event.name).includes(ESPN_NAME) || !String(event.date).startsWith(ESPN_DATE)) stop(`ESPN event is ${event.name} ${event.date}`);
const competitions = [];
for (const c of event.competitions) {
  const comp = c.$ref ? await j(c.$ref) : c;
  const status = comp.status?.$ref ? await j(comp.status.$ref) : comp.status;
  const competitors = [];
  for (const k of comp.competitors) {
    const a = await j(k.athlete.$ref);
    competitors.push({ athlete_id: String(a.id), name: a.fullName, winner: Boolean(k.winner), dob: a.dateOfBirth ? String(a.dateOfBirth).slice(0, 10) : null });
  }
  competitions.push({ id: String(comp.id), period: status?.period ?? null, competitors });
}
const candidateIds = competitions.flatMap((c) => c.competitors.map((x) => x.athlete_id));
const espnIdHolders = await q(`ufc_fighters?select=id,name,espn_athlete_id&espn_athlete_id=in.(${candidateIds})`);
const plan = planEspnIdBackfill({ expected, fighters: [...fighters, ...others], bouts, competitions, espnIdHolders });

/* Commission DOBs, where the season cites a commission record: evidence only. */
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'commission_records.json'), 'utf8'));
const commissionDob = (name) => {
  const surname = fold(String(name).split(' ').pop());
  const hits = new Set(ledger.records.filter((r) => ledger.documents.find((d) => d.id === r.document_id)?.seasons.includes(SEASON))
    .flatMap((r) => r.corners.filter((c) => fold(c.printed).includes(surname) && c.dob).map((c) => c.dob)));
  return hits.size === 1 ? [...hits][0] : null;
};

const combat = await q(`combat_fighters?select=id,ufc_fighter_id,identity_state,identities:combat_fighter_identities(source_id,external_id)&ufc_fighter_id=in.(${onCard})`);
const report = {
  plan: PLAN, season: SEASON, retrieved: new Date().toISOString(), espn_event: { id: ESPN_EVENT, name: event.name, date: event.date }, our_event: EVENT_ID,
  expected: plan.expected, mapped: plan.mapped, ambiguous: plan.ambiguous, conflicts: plan.conflicts, duplicate_ids: plan.duplicate_ids,
  problems: plan.problems, warnings: plan.warnings,
  combat_mirror: combat.map((c) => ({ ufc_fighter_id: c.ufc_fighter_id, combat_fighter_id: c.id, identity_state: c.identity_state, has_espn_identity: c.identities.some((i) => i.source_id === ESPN_SOURCE_ID) })),
  mappings: plan.mappings.map((m) => ({ ...m, commission_dob: commissionDob(m.name) })),
};
console.log(JSON.stringify({ expected: report.expected, mapped: report.mapped, ambiguous: report.ambiguous, conflicts: report.conflicts, duplicate_ids: report.duplicate_ids, problems: report.problems, warnings: report.warnings, dob_evidence: report.mappings.filter((m) => (m.espn_dob && m.espn_dob !== m.canonical_dob) || (m.commission_dob && m.commission_dob !== m.canonical_dob)).map((m) => ({ name: m.name, canonical: m.canonical_dob, espn: m.espn_dob, commission: m.commission_dob })) }, null, 1));
if (!plan.ok) stop('plan is not clean; nothing written');
if (combat.length !== EXPECTED || combat.some((c) => c.identity_state !== 'verified' || c.identities.some((i) => i.source_id === ESPN_SOURCE_ID))) stop('combat mirror is not one verified record per fighter without an ESPN identity');
for (const m of report.mappings) m.combat_fighter_id = combat.find((c) => c.ufc_fighter_id === m.fighter_id).id;

const evPath = path.join(ROOT, 'scripts', 'reconcile', 'evidence', `${SEASON.replace(/-/g, '')}_espn_athlete_ids.${DATE}.json`);
fs.mkdirSync(path.dirname(evPath), { recursive: true });
fs.writeFileSync(evPath, JSON.stringify(report, null, 1) + '\n');
const sha = crypto.createHash('sha256').update(JSON.stringify(plan.mappings)).digest('hex');
const N = EXPECTED;

const rows = report.mappings.map((m) => '    ' + JSON.stringify({
  fighter_id: m.fighter_id, combat_fighter_id: m.combat_fighter_id, name: m.name, ufcstats_id: m.ufcstats_id, espn: m.espn_athlete_id, espn_name: m.espn_name,
  espn_dob: m.espn_dob, canonical_dob: m.canonical_dob, commission_dob: m.commission_dob, bout_id: m.bout_id, opponent_id: m.opponent_id, role: m.role, competition: m.espn_competition_id,
}).replace(/'/g, "''")).join(',\n');

const fingerprint = (exclusions) => `jsonb_build_object(
    'ufc_fighters',              (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id <> all(touched)),
    'ufc_fighters_touched_rest', (select jsonb_build_array(count(*), md5(coalesce(string_agg((to_jsonb(t) - 'espn_athlete_id' - 'updated_at')::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id = any(touched)),
    'ufc_bouts',                 (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_bouts t),
    'ufc_bout_results',          (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id), ''))) from public.ufc_bout_results t),
    'ufc_fighter_aliases',       (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighter_aliases t),
    'ufc_images',                (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_images t),
    'ufc_image_candidates',      (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_image_candidates t),
    'combat_fighters',           (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighters t),
    'combat_fighter_identities', (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighter_identities t ${exclusions.identities}),
    'ufc_identity_reconciliations', (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_identity_reconciliations t ${exclusions.audit})
  )`;

const sql = `-- ${SEASON} contestants — attach ESPN athlete ids, ${DATE}.
--
-- Approved for exactly these ${N} fighters. Generated by
-- scripts/reconcile/tuf_espn_athlete_ids.mjs from the plan in
-- scripts/reconcile/evidence/${path.basename(evPath)} (sha256 ${sha}).
--
-- Each mapping is anchored to one exact bout: the fighter's bout on our finale
-- event ${EVENT_ID} reproduced by one ESPN competition on ESPN event ${ESPN_EVENT}
-- (winner/loser role, round and both names agree). Nothing is merged, no DOB is
-- written to ufc_fighters, no UFC Stats id changes. Where ESPN or a commission
-- record prints a different DOB, every value is kept in the audit evidence.
--
-- FAIL CLOSED: exact pre-state per row; any planned ESPN id already held by any
-- canonical fighter or combat ESPN identity aborts; every other row in the
-- touched tables is fingerprinted and must be identical after; touched fighters
-- may change only espn_athlete_id and updated_at.

begin;

do $attach$
declare
  PLAN_ID constant text := '${PLAN}';
  ESPN_SOURCE constant uuid := '${ESPN_SOURCE_ID}';
  OUR_EVENT constant uuid := '${EVENT_ID}';
  plan_rows jsonb := '[
${rows}
  ]'::jsonb;
  touched uuid[];
  p jsonb; n bigint; fp_before jsonb; fp_after jsonb; k text; before_row jsonb; after_row jsonb; new_ids uuid[] := '{}'; new_id uuid;
begin
  select array_agg((x->>'fighter_id')::uuid) into touched from jsonb_array_elements(plan_rows) x;
  if jsonb_array_length(plan_rows) <> ${N} or (select count(distinct x->>'espn') from jsonb_array_elements(plan_rows) x) <> ${N}
     or (select count(distinct x->>'fighter_id') from jsonb_array_elements(plan_rows) x) <> ${N} then
    raise exception 'plan: expected ${N} distinct fighters and ${N} distinct ESPN ids'; end if;
  select count(*) into n from public.ufc_fighters where espn_athlete_id in (select x->>'espn' from jsonb_array_elements(plan_rows) x);
  if n <> 0 then raise exception 'collision: % canonical fighter(s) already hold a planned ESPN id', n; end if;
  select count(*) into n from public.combat_fighter_identities where source_id = ESPN_SOURCE and external_id in (select x->>'espn' from jsonb_array_elements(plan_rows) x);
  if n <> 0 then raise exception 'collision: % combat ESPN identity row(s) already hold a planned ESPN id', n; end if;

  select ${fingerprint({ identities: '', audit: '' })} into fp_before;

  for p in select * from jsonb_array_elements(plan_rows) loop
    if not exists (select 1 from public.ufc_fighters where id = (p->>'fighter_id')::uuid and name = p->>'name'
                     and ufcstats_id = p->>'ufcstats_id' and espn_athlete_id is null
                     and dob is not distinct from (p->>'canonical_dob')::date) then
      raise exception 'drift: % is not the planned canonical row (name, UFC Stats id, DOB, no ESPN id)', p->>'name'; end if;
    if not exists (select 1 from public.ufc_bouts b join public.ufc_bout_results r on r.bout_id = b.id
                     where b.id = (p->>'bout_id')::uuid and b.event_id = OUR_EVENT
                       and array[b.fighter_a_id, b.fighter_b_id] @> array[(p->>'fighter_id')::uuid, (p->>'opponent_id')::uuid]
                       and ((p->>'role' = 'winner' and r.winner_id = (p->>'fighter_id')::uuid) or (p->>'role' = 'loser' and r.winner_id = (p->>'opponent_id')::uuid))) then
      raise exception 'drift: % bout % is not the planned finale bout, opponent and result', p->>'name', p->>'bout_id'; end if;
    if (select count(*) from public.combat_fighters where id = (p->>'combat_fighter_id')::uuid and ufc_fighter_id = (p->>'fighter_id')::uuid and identity_state = 'verified') <> 1 then
      raise exception 'drift: combat mirror for %', p->>'name'; end if;

    select to_jsonb(t) into before_row from public.ufc_fighters t where t.id = (p->>'fighter_id')::uuid;
    insert into public.ufc_identity_reconciliations (plan_sha256, kind, canonical_id, duplicate_id, evidence, before_images, operator)
    values ('${sha}', 'source_id_attach', (p->>'fighter_id')::uuid, null,
      jsonb_build_object('plan', PLAN_ID, 'name', p->>'name', 'espn_athlete_id', p->>'espn', 'espn_name', p->>'espn_name', 'ufcstats_id', p->>'ufcstats_id',
        'dob_evidence', jsonb_build_object('canonical', p->>'canonical_dob', 'espn', p->>'espn_dob', 'commission', p->>'commission_dob',
          'disputed', (p->>'espn_dob' is not null and p->>'espn_dob' is distinct from p->>'canonical_dob') or (p->>'commission_dob' is not null and p->>'commission_dob' is distinct from p->>'canonical_dob'),
          'action', 'canonical dob unchanged; a disagreement is recorded, not resolved by vote'),
        'anchor', jsonb_build_object('our_event', OUR_EVENT, 'bout_id', p->>'bout_id', 'role', p->>'role', 'opponent_id', p->>'opponent_id', 'espn_event', '${ESPN_EVENT}', 'espn_competition', p->>'competition'),
        'proof', 'the fighter''s bout on our finale event is reproduced by exactly one ESPN competition on the same event: winner/loser role, round and both printed names agree'),
      jsonb_build_object('ufc_fighters', before_row), '${SQL_REL}');

    update public.ufc_fighters set espn_athlete_id = p->>'espn', updated_at = now() where id = (p->>'fighter_id')::uuid and espn_athlete_id is null;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '% update % <> 1', p->>'name', n; end if;

    insert into public.combat_fighter_identities (combat_fighter_id, source_id, external_id, external_url, display_name, dob, verification_state, confidence, evidence)
    values ((p->>'combat_fighter_id')::uuid, ESPN_SOURCE, p->>'espn', 'https://www.espn.com/mma/fighter/_/id/' || (p->>'espn'), p->>'espn_name', (p->>'espn_dob')::date, 'verified', 100,
      jsonb_build_object('bridge', 'ufc_fighters.espn_athlete_id', 'ufc_fighter_id', p->>'fighter_id', 'reconciliation', PLAN_ID, 'espn_competition', p->>'competition', 'bout_id', p->>'bout_id'))
    returning id into new_id;
    new_ids := new_ids || new_id;

    select to_jsonb(t) into after_row from public.ufc_fighters t where t.id = (p->>'fighter_id')::uuid;
    if (after_row->>'espn_athlete_id') is distinct from p->>'espn' or (after_row->>'ufcstats_id') is distinct from p->>'ufcstats_id'
       or (after_row->>'dob') is distinct from (before_row->>'dob') or (after_row->>'name') is distinct from (before_row->>'name') then
      raise exception 'post: % changed beyond its ESPN id', p->>'name'; end if;
  end loop;

  select ${fingerprint({ identities: 'where t.id <> all(new_ids)', audit: `where t.plan_sha256 <> '${sha}'` })} into fp_after;
  for k in select jsonb_object_keys(fp_before) loop
    if fp_before->k is distinct from fp_after->k then
      raise exception 'post: unrelated rows changed in % (before % after %)', k, fp_before->k, fp_after->k; end if;
  end loop;
  select count(*) into n from public.ufc_fighters where id = any(touched) and espn_athlete_id is not null;
  if n <> ${N} then raise exception 'post: % of ${N} fighters carry their ESPN id', n; end if;
  select count(*) into n from public.ufc_identity_reconciliations where plan_sha256 = '${sha}';
  if n <> ${N} then raise exception 'post: % audit rows', n; end if;
  if array_length(new_ids, 1) <> ${N} then raise exception 'post: % combat ESPN identities', array_length(new_ids, 1); end if;

  if current_setting('reconcile.report', true) = 'raise' then
    raise exception 'PROOF OK: ${N} fighters, ${N} ESPN ids, ${N} combat identities, ${N} audit rows; unrelated fingerprints identical: %', fp_after;
  end if;
end
$attach$;

commit;
`;
fs.writeFileSync(path.join(ROOT, SQL_REL), sql);

/* Retired-slug redirects to add, for review (the slug is keyed on the ESPN id once attached). */
const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
console.log(`wrote ${path.relative(ROOT, evPath)} and ${SQL_REL} (plan sha256 ${sha})`);
console.log(report.mappings.map((m) => `  { retiredSourceId: "${m.ufcstats_id}", canonicalSlug: "${slugify(m.name)}-${m.espn_athlete_id}", reconciliation: "${PLAN}" },`).join('\n'));
