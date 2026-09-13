#!/usr/bin/env node
/**
 * TUF 1 contestants: attach ESPN athlete ids through the exact finale card.
 * Approved 2026-09-13 for these 16 fighters ONLY — not the wider ESPN-id gap.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env node scripts/reconcile/tuf1_espn_athlete_ids.mjs
 *
 * Read-only. Fetches ESPN event 400254386 (The Ultimate Fighter 1 Finale) and
 * our rows for event c93a5b04, runs scripts/tuf/lib/espnFinaleIdentity.mjs,
 * and — only if the plan is clean (16 mapped, 0 ambiguous, 0 conflicting, 0
 * duplicate ids) — writes:
 *   scripts/reconcile/evidence/tuf1_espn_athlete_ids.2026-09-13.json   the plan
 *   scripts/reconcile/20260913_tuf1_espn_athlete_ids.sql                the guarded transaction
 * Proof first (BEGIN … ROLLBACK), then apply, with scripts/db/apply_supabase_migration.ps1.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planEspnIdBackfill } from '../tuf/lib/espnFinaleIdentity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN = 'tuf1-espn-athlete-ids-2026-09-13';
const EVENT_ID = 'c93a5b04-6a74-4ec9-854b-422fbfbc5074';
const ESPN_EVENT = '400254386';
const ESPN_SOURCE_ID = 'cd71b196-8197-4df4-a806-26a78678d04b';

const env = { ...process.env };
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const q = async (p) => { const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`${p.split('?')[0]} ${r.status} ${await r.text()}`); return r.json(); };
const j = async (u) => { const r = await fetch(u.replace(/^http:/, 'https:')); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); };
const one = (v) => (Array.isArray(v) ? v[0] : v);

/* The 16 contestants, by the ids the archive's identity registry decided. */
const season = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons', 'tuf-1.json'), 'utf8'));
const expected = season.teams.flatMap((t) => t.roster).map((r) => ({ id: r.fighter_id, name: r.name }));
if (expected.length !== 16 || expected.some((e) => !e.id)) { console.error('STOP: expected 16 linked TUF 1 contestants'); process.exit(1); }
const ids = expected.map((e) => e.id);

const fighters = await q(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,dob&id=in.(${ids})`);
const boutRows = await q(`ufc_bouts?select=id,fighter_a_id,fighter_b_id,result:ufc_bout_results(winner_id,round)&event_id=eq.${EVENT_ID}`);
const bouts = boutRows.map((b) => ({ id: b.id, fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id, winner_id: one(b.result)?.winner_id ?? null, round: one(b.result)?.round ?? null }));
/* Opponents outside the 16 (the main event) still need their names for the reproduction check. */
const oppIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))].filter((x) => !ids.includes(x));
const others = oppIds.length ? await q(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id,dob&id=in.(${oppIds})`) : [];

const event = await j(`https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${ESPN_EVENT}?lang=en&region=us`);
if (!/Ultimate Fighter 1 Finale/i.test(event.name) || !String(event.date).startsWith('2005-04-10T01:00')) { console.error(`STOP: ESPN event is ${event.name} ${event.date}`); process.exit(1); }
const competitions = [];
for (const c of event.competitions) {
  const comp = c.$ref ? await j(c.$ref) : c;
  const status = comp.status?.$ref ? await j(comp.status.$ref) : comp.status;
  const competitors = [];
  for (const k of comp.competitors) {
    const a = await j(k.athlete.$ref);
    competitors.push({ athlete_id: String(a.id), name: a.fullName, winner: Boolean(k.winner), dob: a.dateOfBirth ? String(a.dateOfBirth).slice(0, 10) : null });
  }
  competitions.push({ id: String(comp.id), period: status?.period ?? null, clock: status?.displayClock ?? null, competitors });
}
const candidateIds = competitions.flatMap((c) => c.competitors.map((x) => x.athlete_id));
const espnIdHolders = await q(`ufc_fighters?select=id,name,espn_athlete_id&espn_athlete_id=in.(${candidateIds})`);

const plan = planEspnIdBackfill({ expected, fighters: [...fighters, ...others], bouts, competitions, espnIdHolders });
const retrieved = new Date().toISOString();
const combat = await q(`combat_fighters?select=id,ufc_fighter_id,identity_state,identities:combat_fighter_identities(source_id,external_id)&ufc_fighter_id=in.(${ids})`);
const report = {
  plan: PLAN, retrieved, espn_event: { id: ESPN_EVENT, name: event.name, date: event.date }, our_event: EVENT_ID,
  expected: plan.expected, mapped: plan.mapped, ambiguous: plan.ambiguous, conflicts: plan.conflicts, duplicate_ids: plan.duplicate_ids,
  problems: plan.problems, warnings: plan.warnings,
  combat_mirror: combat.map((c) => ({ ufc_fighter_id: c.ufc_fighter_id, combat_fighter_id: c.id, identity_state: c.identity_state, has_espn_identity: c.identities.some((i) => i.source_id === ESPN_SOURCE_ID) })),
  mappings: plan.mappings,
};
console.log(JSON.stringify({ expected: report.expected, mapped: report.mapped, ambiguous: report.ambiguous, conflicts: report.conflicts, duplicate_ids: report.duplicate_ids, problems: report.problems, warnings: report.warnings }, null, 1));
if (!plan.ok) { console.error('STOP: plan is not clean; nothing written'); process.exit(1); }
if (combat.length !== 16 || combat.some((c) => c.identity_state !== 'verified' || c.identities.some((i) => i.source_id === ESPN_SOURCE_ID))) {
  console.error('STOP: combat mirror is not one verified record per fighter without an ESPN identity'); process.exit(1);
}
for (const m of plan.mappings) m.combat_fighter_id = combat.find((c) => c.ufc_fighter_id === m.fighter_id).id;

const evPath = path.join(ROOT, 'scripts', 'reconcile', 'evidence', 'tuf1_espn_athlete_ids.2026-09-13.json');
fs.mkdirSync(path.dirname(evPath), { recursive: true });
fs.writeFileSync(evPath, JSON.stringify(report, null, 1) + '\n');
const sha = crypto.createHash('sha256').update(JSON.stringify(plan.mappings)).digest('hex');

const lit = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const rows = plan.mappings.map((m) => `    {"fighter_id":"${m.fighter_id}","combat_fighter_id":"${m.combat_fighter_id}","name":${JSON.stringify(m.name)},"ufcstats_id":"${m.ufcstats_id}","espn":"${m.espn_athlete_id}","espn_name":${JSON.stringify(m.espn_name)},"espn_dob":${JSON.stringify(m.espn_dob)},"bout_id":"${m.bout_id}","opponent_id":"${m.opponent_id}","role":"${m.role}","competition":"${m.espn_competition_id}"}`).join(',\n');
const sql = `-- TUF 1 contestants — attach ESPN athlete ids, 2026-09-13.
--
-- Approved for exactly these 16 fighters. Generated by
-- scripts/reconcile/tuf1_espn_athlete_ids.mjs from the plan in
-- scripts/reconcile/evidence/tuf1_espn_athlete_ids.2026-09-13.json (sha256 ${sha}).
--
-- Each mapping is anchored to one exact bout: the fighter's bout on our finale
-- event ${EVENT_ID} reproduced by one ESPN competition on ESPN event ${ESPN_EVENT}
-- (winner/loser role, round and both names agree). Nothing is merged, no DOB is
-- written to ufc_fighters, no UFC Stats id changes. Each fighter gains its ESPN id
-- and its combat mirror gains the ESPN identity row (with ESPN's printed DOB as
-- source evidence), and an audit row records the before-image.
--
-- FAIL CLOSED: exact pre-state is asserted per row; any ESPN id already held by
-- any canonical fighter aborts; every other row in the touched tables is
-- fingerprinted before and must be identical after; touched fighters may change
-- only espn_athlete_id and updated_at.
--
-- Proof, then apply:
--   pwsh scripts/db/apply_supabase_migration.ps1 -Mode proof -Chain -Paths "<source-attach migration>,scripts/reconcile/20260913_tuf1_espn_athlete_ids.sql"

begin;

do $attach$
declare
  PLAN constant text := '${PLAN}';
  ESPN_SOURCE constant uuid := '${ESPN_SOURCE_ID}';
  EVENT constant uuid := '${EVENT_ID}';
  plan_rows jsonb := '[
${rows}
  ]'::jsonb;
  touched uuid[];
  touched_combat uuid[];
  p jsonb; n bigint; fp_before jsonb; fp_after jsonb; k text; before_row jsonb; after_row jsonb; new_ids uuid[] := '{}'; new_id uuid;
begin
  select array_agg((x->>'fighter_id')::uuid), array_agg((x->>'combat_fighter_id')::uuid) into touched, touched_combat from jsonb_array_elements(plan_rows) x;
  if jsonb_array_length(plan_rows) <> 16 or (select count(distinct x->>'espn') from jsonb_array_elements(plan_rows) x) <> 16
     or (select count(distinct x->>'fighter_id') from jsonb_array_elements(plan_rows) x) <> 16 then
    raise exception 'plan: expected 16 distinct fighters and 16 distinct ESPN ids'; end if;
  /* No canonical fighter anywhere may already hold one of these ESPN ids. */
  select count(*) into n from public.ufc_fighters where espn_athlete_id in (select x->>'espn' from jsonb_array_elements(plan_rows) x);
  if n <> 0 then raise exception 'collision: % canonical fighter(s) already hold a planned ESPN id', n; end if;
  select count(*) into n from public.combat_fighter_identities where source_id = ESPN_SOURCE and external_id in (select x->>'espn' from jsonb_array_elements(plan_rows) x);
  if n <> 0 then raise exception 'collision: % combat ESPN identity row(s) already hold a planned ESPN id', n; end if;

  select jsonb_build_object(
    'ufc_fighters',              (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id <> all(touched)),
    'ufc_fighters_touched_rest', (select jsonb_build_array(count(*), md5(coalesce(string_agg((to_jsonb(t) - 'espn_athlete_id' - 'updated_at')::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id = any(touched)),
    'ufc_bouts',                 (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_bouts t),
    'ufc_bout_results',          (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id), ''))) from public.ufc_bout_results t),
    'ufc_fighter_aliases',       (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighter_aliases t),
    'ufc_images',                (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_images t),
    'ufc_image_candidates',      (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_image_candidates t),
    'combat_fighters',           (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighters t),
    'combat_fighter_identities', (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighter_identities t),
    'ufc_identity_reconciliations', (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_identity_reconciliations t)
  ) into fp_before;

  for p in select * from jsonb_array_elements(plan_rows) loop
    /* ---- exact pre-state ---- */
    if not exists (select 1 from public.ufc_fighters where id = (p->>'fighter_id')::uuid and name = p->>'name'
                     and ufcstats_id = p->>'ufcstats_id' and espn_athlete_id is null) then
      raise exception 'drift: % is not the planned canonical row (name, UFC Stats id, no ESPN id)', p->>'name'; end if;
    if not exists (select 1 from public.ufc_bouts b join public.ufc_bout_results r on r.bout_id = b.id
                     where b.id = (p->>'bout_id')::uuid and b.event_id = EVENT
                       and array[b.fighter_a_id, b.fighter_b_id] @> array[(p->>'fighter_id')::uuid, (p->>'opponent_id')::uuid]
                       and ((p->>'role' = 'winner' and r.winner_id = (p->>'fighter_id')::uuid) or (p->>'role' = 'loser' and r.winner_id = (p->>'opponent_id')::uuid))) then
      raise exception 'drift: % bout % is not the planned finale bout, opponent and result', p->>'name', p->>'bout_id'; end if;
    if (select count(*) from public.combat_fighters where id = (p->>'combat_fighter_id')::uuid and ufc_fighter_id = (p->>'fighter_id')::uuid and identity_state = 'verified') <> 1 then
      raise exception 'drift: combat mirror for %', p->>'name'; end if;

    select to_jsonb(t) into before_row from public.ufc_fighters t where t.id = (p->>'fighter_id')::uuid;
    insert into public.ufc_identity_reconciliations (plan_sha256, kind, canonical_id, duplicate_id, evidence, before_images, operator)
    values ('${sha}', 'source_id_attach', (p->>'fighter_id')::uuid, null,
      jsonb_build_object('plan', PLAN, 'name', p->>'name', 'espn_athlete_id', p->>'espn', 'espn_name', p->>'espn_name', 'espn_dob', p->>'espn_dob',
        'ufcstats_id', p->>'ufcstats_id', 'anchor', jsonb_build_object('our_event', EVENT, 'bout_id', p->>'bout_id', 'role', p->>'role', 'opponent_id', p->>'opponent_id', 'espn_event', '${ESPN_EVENT}', 'espn_competition', p->>'competition'),
        'proof', 'the fighter''s bout on our finale event is reproduced by exactly one ESPN competition on the same event: winner/loser role, round and both printed names agree'),
      jsonb_build_object('ufc_fighters', before_row), 'scripts/reconcile/20260913_tuf1_espn_athlete_ids.sql');

    update public.ufc_fighters set espn_athlete_id = p->>'espn', updated_at = now() where id = (p->>'fighter_id')::uuid and espn_athlete_id is null;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '% update % <> 1', p->>'name', n; end if;

    insert into public.combat_fighter_identities (combat_fighter_id, source_id, external_id, external_url, display_name, dob, verification_state, confidence, evidence)
    values ((p->>'combat_fighter_id')::uuid, ESPN_SOURCE, p->>'espn', 'https://www.espn.com/mma/fighter/_/id/' || (p->>'espn'), p->>'espn_name', (p->>'espn_dob')::date, 'verified', 100,
      jsonb_build_object('bridge', 'ufc_fighters.espn_athlete_id', 'ufc_fighter_id', p->>'fighter_id', 'reconciliation', PLAN, 'espn_competition', p->>'competition', 'bout_id', p->>'bout_id'))
    returning id into new_id;
    new_ids := new_ids || new_id;

    /* ---- post-state for the row ---- */
    select to_jsonb(t) into after_row from public.ufc_fighters t where t.id = (p->>'fighter_id')::uuid;
    if (after_row->>'espn_athlete_id') is distinct from p->>'espn' or (after_row->>'ufcstats_id') is distinct from p->>'ufcstats_id'
       or (after_row->>'dob') is distinct from (before_row->>'dob') or (after_row->>'name') is distinct from (before_row->>'name') then
      raise exception 'post: % changed beyond its ESPN id', p->>'name'; end if;
  end loop;

  select jsonb_build_object(
    'ufc_fighters',              (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id <> all(touched)),
    'ufc_fighters_touched_rest', (select jsonb_build_array(count(*), md5(coalesce(string_agg((to_jsonb(t) - 'espn_athlete_id' - 'updated_at')::text, '|' order by t.id), ''))) from public.ufc_fighters t where t.id = any(touched)),
    'ufc_bouts',                 (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_bouts t),
    'ufc_bout_results',          (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.bout_id), ''))) from public.ufc_bout_results t),
    'ufc_fighter_aliases',       (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_fighter_aliases t),
    'ufc_images',                (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_images t),
    'ufc_image_candidates',      (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_image_candidates t),
    'combat_fighters',           (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighters t),
    'combat_fighter_identities', (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.combat_fighter_identities t where t.id <> all(new_ids)),
    'ufc_identity_reconciliations', (select jsonb_build_array(count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), ''))) from public.ufc_identity_reconciliations t where t.plan_sha256 <> '${sha}')
  ) into fp_after;
  for k in select jsonb_object_keys(fp_before) loop
    if fp_before->k is distinct from fp_after->k then
      raise exception 'post: unrelated rows changed in % (before % after %)', k, fp_before->k, fp_after->k; end if;
  end loop;
  select count(*) into n from public.ufc_fighters where id = any(touched) and espn_athlete_id is not null;
  if n <> 16 then raise exception 'post: % of 16 fighters carry their ESPN id', n; end if;
  select count(*) into n from public.ufc_identity_reconciliations where plan_sha256 = '${sha}';
  if n <> 16 then raise exception 'post: % audit rows', n; end if;
  if array_length(new_ids, 1) <> 16 then raise exception 'post: % combat ESPN identities', array_length(new_ids, 1); end if;

  /* A proof run asks for the result as an exception so the rollback carries a report. */
  if current_setting('reconcile.report', true) = 'raise' then
    raise exception 'PROOF OK: 16 fighters, 16 ESPN ids, 16 combat identities, 16 audit rows; unrelated fingerprints identical: %', fp_after;
  end if;
end
$attach$;

commit;
`;
fs.writeFileSync(path.join(ROOT, 'scripts', 'reconcile', '20260913_tuf1_espn_athlete_ids.sql'), sql);
console.log(`wrote evidence and SQL (plan sha256 ${sha})`);
