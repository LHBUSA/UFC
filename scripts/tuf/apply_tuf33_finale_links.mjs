#!/usr/bin/env node
/**
 * TUF 33 — link both tournament finals to their exact professional bouts, from
 * first-party UFC evidence. Owner-approved 2026-09-13.
 *
 *   node scripts/tuf/apply_tuf33_finale_links.mjs              dry run
 *   node scripts/tuf/apply_tuf33_finale_links.mjs --write      write seasons.json + seasons/tuf-33.json
 *   node scripts/tuf/apply_tuf33_finale_links.mjs --check      exit 1 unless already applied (idempotence)
 *   UFC_ENV_FILE=... node scripts/tuf/apply_tuf33_finale_links.mjs --verify-db
 *                                                              also re-check the canonical rows live (read-only)
 *
 * Inputs: scripts/tuf/evidence/tuf33_ufc_first_party_finale_evidence_2026-09-13.json
 * (UFC.com weigh-ins, results, event update, episode 12 recap, athlete profiles)
 * and the read-only bout snapshot scripts/tuf/lib/fixtures/tuf33_finalist_bouts_2026-09-13.json.
 * The Paramount+ listing is not used. The verifier is not changed: each final gets
 * the explicit link it already honours, verified_against = "ufc_bouts:<uuid>".
 *
 * Every change is a separate correction with its own repair key, old value, new
 * value, reason and first-party source:
 *   inventory  finalists (Welterweight: Matt Dixon -> Rodrigo Sezinando), winners,
 *              final_bouts, finale_event/finale_date, winner_note, completion_unverified,
 *              and the "winners" inventory conflict -> _resolved_conflicts
 *   season     both finals: verified_against, classification unverified -> professional,
 *              and an official winner source
 * Refused (stop) on any mismatch between the evidence, the snapshot and the files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');
const VERIFY_DB = process.argv.includes('--verify-db');
const BATCH = 'tuf33-finals-exact-linkage';
const APPROVED = { by: 'owner', on: '2026-09-13' };
const fail = (m) => { console.error(`STOP: ${m}`); process.exit(1); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const one = (v) => (Array.isArray(v) ? v[0] : v);

const EVIDENCE = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf33_ufc_first_party_finale_evidence_2026-09-13.json'));
const SNAPSHOT = readJson(path.join(ROOT, 'scripts', 'tuf', 'lib', 'fixtures', 'tuf33_finalist_bouts_2026-09-13.json'));
const inventoryPath = path.join(DATA, 'seasons.json');
const seasonPath = path.join(DATA, 'seasons', 'tuf-33.json');
const inventory = readJson(inventoryPath);
const season = readJson(seasonPath);
const row = inventory.seasons.find((s) => s.slug === 'tuf-33');
if (!row) fail('no tuf-33 inventory row');

const src = (key, extra = {}) => {
  const s = EVIDENCE.sources[key];
  if (!s) fail(`evidence source ${key} missing`);
  return { family: s.family, evidence_level: 'official', url: s.url, ...(s.published_on_site ? { published_on_site: s.published_on_site } : {}), retrieved: EVIDENCE.retrieved, quote: s.quotes[0], ...extra };
};
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const METHOD_LABEL = { SUB: 'Submission', KO_TKO: 'KO/TKO' };

/* ---- 1. prove each final against the snapshot (and optionally the live DB) ---- */
const finals = {};
for (const [wc, ev] of Object.entries(EVIDENCE.finals)) {
  const bout = season.bracket.find((b) => b.weight_class === wc)?.stages.find((s) => s.stage === 'final')?.bouts;
  if (!bout || bout.length !== 1) fail(`${wc}: expected exactly one final in the bracket`);
  const f = bout[0];
  if (f.a !== ev.a || f.b !== ev.b) fail(`${wc}: bracket final is ${f.a} vs ${f.b}, evidence says ${ev.a} vs ${ev.b}`);
  if (f.winner !== ev.winner) fail(`${wc}: bracket winner ${f.winner}, first-party winner ${ev.winner}`);
  const ids = [f.a_fighter_id, f.b_fighter_id];
  if (ids.some((x) => !x)) fail(`${wc}: finalist identity unresolved`);
  const snap = SNAPSHOT.bouts[ev.ufc_bout_id];
  if (!snap) fail(`${wc}: bout ${ev.ufc_bout_id} not in the snapshot`);
  const pair = (b) => [b.fighter_a_id, b.fighter_b_id].sort().join('|');
  if (pair(snap) !== [...ids].sort().join('|')) fail(`${wc}: bout ${ev.ufc_bout_id} is not between the finalist ids`);
  const others = Object.values(SNAPSHOT.bouts).filter((b) => b.id !== snap.id && pair(b) === pair(snap));
  if (others.length) fail(`${wc}: ${others.length} other bout(s) between the finalists`);
  const e = one(snap.event); const r = one(snap.result);
  if (e.name !== ev.event || e.event_date !== ev.event_date) fail(`${wc}: snapshot event ${e.name} ${e.event_date}, evidence ${ev.event} ${ev.event_date}`);
  if (snap.status !== 'complete' || !r) fail(`${wc}: bout not complete with a result`);
  const winnerId = f.winner === f.a ? f.a_fighter_id : f.b_fighter_id;
  if (r.winner_id !== winnerId) fail(`${wc}: result winner ${r.winner_id} is not ${f.winner}`);
  if (r.round !== ev.round || mmss(r.time_sec) !== ev.time) fail(`${wc}: result R${r.round} ${mmss(r.time_sec)}, first-party R${ev.round} ${ev.time}`);
  finals[wc] = { f, ev, snap, e, r, ids, winnerId };
}
if (Object.keys(finals).length !== (row.weight_classes || []).length) fail('evidence does not cover every weight class');

if (VERIFY_DB) {
  const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
  const env = { ...process.env };
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  for (const [wc, x] of Object.entries(finals)) {
    const [a, b] = x.ids;
    const rows = await (await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/ufc_bouts?select=id,status,event:ufc_events(name,event_date),result:ufc_bout_results(winner_id,round,time_sec)&or=(and(fighter_a_id.eq.${a},fighter_b_id.eq.${b}),and(fighter_a_id.eq.${b},fighter_b_id.eq.${a}))`, { headers: H })).json();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== x.ev.ufc_bout_id) fail(`${wc}: live database has ${Array.isArray(rows) ? rows.length : '?'} bout(s) between the finalists, expected only ${x.ev.ufc_bout_id}`);
    const le = one(rows[0].event); const lr = one(rows[0].result);
    if (le.name !== x.ev.event || le.event_date !== x.ev.event_date || lr?.winner_id !== x.winnerId) fail(`${wc}: live row differs from the snapshot`);
  }
  console.log('live database re-check: both finals match (read-only)');
}

/* ---- 2. season file: the two finals ---- */
const corr = (repair, field, oldV, newV, reason, sources) => ({ repair, field, old: oldV, new: newV, kind: 'official_source_correction', reason, sources, batch: BATCH, approved: APPROVED });
for (const [wc, x] of Object.entries(finals)) {
  const { f, ev, e } = x;
  const key = `${BATCH}/${wc.toLowerCase()}-final`;
  const link = `ufc_bouts:${ev.ufc_bout_id}`;
  const designation = ev.designation_sources.map((k) => src(k));
  const mine = (f.corrections || []).filter((c) => c.batch === BATCH);
  const was = (field) => (mine.some((c) => c.field === field) ? mine.find((c) => c.field === field).old : f[field] ?? null);
  const priorClassificationSource = mine.some((c) => c.field === 'classification_source') ? mine.find((c) => c.field === 'classification_source').old : f.classification_source ?? null;
  const exact = `the only bout between the two finalist ids in ufc_bouts (${ev.ufc_bout_id}), on ${e.name}, ${e.event_date}; UFC's own ${wc.toLowerCase()} finale designation names this pairing on this card and date`;
  /* Old values are read BEFORE anything below overwrites them. */
  const draft = { verified_against: was('verified_against'), classification: was('classification') };

  f.verified_against = link;
  f.classification = 'professional';
  f.classification_source = `contested on a sanctioned UFC card; exact finale bout ufc_bouts ${ev.ufc_bout_id} + ufc_bout_results on ${e.name}, ${e.event_date}; designated "TUF ${wc} Finale Bout" by UFC`;
  f.classification_basis = {
    affirmative: [
      { family: 'our_records', evidence_level: 'canonical', what: `ufc_bouts ${ev.ufc_bout_id} + ufc_bout_results on ${e.name}, ${e.event_date}`, note: 'contested on a sanctioned professional card; the result row names the tournament winner' },
      src(ev.designation_sources[0], { note: `UFC's official designation of the ${wc.toLowerCase()} finale on this card` }),
    ],
    corroborating: ev.designation_sources.slice(1).map((k) => src(k)),
    authority: 'affirmative',
  };
  f.sources = [...(f.sources || []).filter((s) => !String(s.repair || '').startsWith(BATCH)),
    { repair: `${key}/winner`, fields: ['winner'], ...src(ev.winner_sources[0]), corroboration: ev.winner_sources.slice(1).map((k) => EVIDENCE.sources[k].url) }];
  f.corrections = [
    ...(f.corrections || []).filter((c) => c.batch !== BATCH),
    corr(`${key}/link`, 'verified_against', draft.verified_against, link, `explicit exact link: ${exact}`, designation),
    corr(`${key}/classification`, 'classification', draft.classification, 'professional', `UFC designates this bout the TUF ${wc} finale on ${ev.ufc_com_event_title} (${e.event_date}), a sanctioned professional card; the exact finale bout and its result are in our records`, designation),
    corr(`${key}/classification`, 'classification_source', priorClassificationSource, f.classification_source, 'basis for the professional classification, from the exact finale bout and UFC\'s designation', designation),
  ];
}

/* ---- 3. inventory row ---- */
const rowMine = (row.corrections || []).filter((c) => c.batch === BATCH);
const rowWas = (field, current) => (rowMine.some((c) => c.field === field) ? rowMine.find((c) => c.field === field).old : current);

const welter = finals.Welterweight;
const oldFinalists = rowWas('finalists', row.finalists ?? null);
const oldWelter = (oldFinalists || []).find((x) => x.weight_class === 'Welterweight');
if (!oldWelter) fail('no welterweight finalists entry to correct');
if (!rowMine.length && JSON.stringify(oldWelter.fighters) !== JSON.stringify(['Daniil Donchenko', 'Matt Dixon'])) fail(`welterweight finalists are ${oldWelter.fighters.join(' vs ')}, expected the draft's Donchenko vs Dixon`);
const semi = season.bracket.find((b) => b.weight_class === 'Welterweight').stages.find((s) => s.stage === 'semi_final').bouts;
if (!semi.some((b) => [b.a, b.b].includes('Matt Dixon') && [b.a, b.b].includes('Daniil Donchenko') && b.winner === 'Daniil Donchenko')) fail('the bracket does not hold Donchenko def. Dixon in the welterweight semi-final');
const newFinalists = (oldFinalists || []).map((x) => (x.weight_class === 'Welterweight'
  ? { weight_class: 'Welterweight', fighters: [welter.f.a, welter.f.b], fighter_ids: [welter.f.a_fighter_id, welter.f.b_fighter_id] }
  : x));

const newWinners = Object.entries(finals).map(([wc, x]) => ({ weight_class: wc, fighter: x.f.winner, fighter_id: x.winnerId }));
const newFinalBouts = Object.entries(finals).map(([wc, x]) => ({
  weight_class: wc, a: x.f.a, b: x.f.b, winner: x.f.winner, method: METHOD_LABEL[x.r.method] || x.r.method, round: x.r.round,
  event: x.e.name, date: x.e.event_date, ufc_bout_id: x.ev.ufc_bout_id, verified_against: `ufc_bouts:${x.ev.ufc_bout_id}`,
}));
const firstCard = [...newFinalBouts].sort((a, b) => a.date.localeCompare(b.date))[0];
const basis = `Linked by explicit bout id from first-party UFC evidence. The finals were on two cards: ${newFinalBouts.map((b) => `${b.weight_class} ${b.a} vs ${b.b} on ${b.event}, ${b.date} (ufc_bouts ${b.ufc_bout_id})`).join('; ')}. UFC's official weigh-in results designate each as the TUF finale bout on that card, and UFC moved the welterweight finale off UFC 319 due to injury. finale_event names the first of the two cards; each final carries its own event and date.`;

const rowCorrections = [
  corr(`${BATCH}/welterweight-finalists`, 'finalists', oldFinalists, newFinalists,
    'The draft (Wikipedia) listed Matt Dixon as a welterweight finalist. UFC\'s episode 12 recap has Donchenko and Dixon fight in the semi-final "to see who will face Sezinando in the welterweight finale", and the finale pairings are Morales vs Idiris and Sezinando vs Donchenko. Matt Dixon was the semi-final opponent, not a finalist.',
    [src('episode_12_recap'), { ...src('profile_daniil_donchenko'), quote: EVIDENCE.sources.profile_daniil_donchenko.quotes[1] }]),
  corr(`${BATCH}/winners`, 'winners', rowWas('winners', row.winners), newWinners,
    'UFC states both finals and their winners: Morales submitted Idiris to win the TUF 33 flyweight final (UFC 319); Donchenko stopped Sezinando to win the TUF 33 welterweight final (Noche UFC). Each matches the exact finale bout\'s result row.',
    [src('profile_joseph_morales'), src('noche_prelim_results'), src('profile_daniil_donchenko')]),
  corr(`${BATCH}/final-bouts`, 'final_bouts', rowWas('final_bouts', row.final_bouts ?? null), newFinalBouts, 'each final linked to its exact bout, card and date from first-party UFC designation', [src('ufc319_weigh_in'), src('noche_weigh_in'), src('ufc319_updates')]),
  corr(`${BATCH}/finale-event`, 'finale_event', rowWas('finale_event', row.finale_event), firstCard.event, 'the first of the two finale cards (multi-card precedent: tuf-china-1); each final carries its own card in final_bouts', [src('ufc319_weigh_in')]),
  corr(`${BATCH}/finale-event`, 'finale_date', rowWas('finale_date', row.finale_date), firstCard.date, 'date of the first finale card', [src('ufc319_weigh_in')]),
  corr(`${BATCH}/winners`, 'winner_note', rowWas('winner_note', row.winner_note ?? null), null, 'the disagreement it described is resolved by first-party UFC evidence', [src('profile_joseph_morales'), src('profile_daniil_donchenko')]),
  corr(`${BATCH}/winners`, 'completion_unverified', rowWas('completion_unverified', row.completion_unverified ?? null), null, 'both finals are now linked to exact result rows and the winners are stated by UFC', [src('ufc319_weigh_in'), src('noche_weigh_in')]),
];

row.finalists = newFinalists;
row.winners = newWinners;
row.finale_event = firstCard.event;
row.finale_date = firstCard.date;
row.finale_link_basis = basis;
row.final_bouts = newFinalBouts;
delete row.winner_note;
delete row.completion_unverified;
row.corrections = [...(row.corrections || []).filter((c) => c.batch !== BATCH), ...rowCorrections];

/* ---- 4. the inventory "winners" conflict ---- */
const open = (inventory._conflicts || []).filter((c) => c.scope === 'tuf-33');
const resolved = (inventory._resolved_conflicts || []).filter((c) => c.scope === 'tuf-33' && c.resolved_by === BATCH);
if (open.length > 1 || (open.length === 1 && open[0].field !== 'winners')) fail(`unexpected open tuf-33 inventory conflicts: ${open.map((c) => c.field).join(', ')}`);
if (!open.length && !resolved.length) fail('the tuf-33 winners conflict is missing');
const resolution = {
  resolved_by: BATCH, resolved_with: newFinalBouts.map((b) => `ufc_bouts ${b.ufc_bout_id} (${b.event}, ${b.date})`).join('; ') + ' + UFC.com weigh-in results, event results and athlete profiles',
  resolution: 'Resolved by first-party UFC evidence: Joseph Morales won the TUF 33 flyweight final at UFC 319 (2025-08-16) and Daniil Donchenko won the TUF 33 welterweight final at Noche UFC (2025-09-13). The draft\'s welterweight finalist (Matt Dixon) was the semi-final opponent; the finalist was Rodrigo Sezinando.',
  approved: APPROVED,
};
if (open.length) {
  inventory._conflicts = inventory._conflicts.filter((c) => c !== open[0]);
  inventory._resolved_conflicts = [...(inventory._resolved_conflicts || []), { ...open[0], ...resolution }];
} else Object.assign(resolved[0], resolution);

const baseNote = String(season._provenance?.note ?? '').replace(/ TUF 33 finals linked by explicit bout id[\s\S]*$/, '');
season._provenance = { ...season._provenance, note: `${baseNote} TUF 33 finals linked by explicit bout id from first-party UFC evidence (${BATCH}): Morales vs Idiris on UFC 319 (2025-08-16) and Donchenko vs Sezinando on Noche UFC / UFC Fight Night: Lopes vs. Silva (2025-09-13); both classified professional; winners stated by UFC.` };

const outputs = [[seasonPath, JSON.stringify(season, null, 2) + '\n'], [inventoryPath, JSON.stringify(inventory, null, 2) + '\n']];
if (CHECK) {
  const stale = outputs.filter(([p, t]) => fs.readFileSync(p, 'utf8') !== t).map(([p]) => path.relative(ROOT, p));
  if (stale.length) { console.error(`not applied or not idempotent: ${stale.join(', ')}`); process.exit(1); }
  console.log(`idempotent: re-applying ${BATCH} changes nothing`);
  process.exit(0);
}
console.log(JSON.stringify({ batch: BATCH, finals: Object.fromEntries(Object.entries(finals).map(([wc, x]) => [wc, { bout: `${x.f.a} vs ${x.f.b}`, link: `ufc_bouts:${x.ev.ufc_bout_id}`, event: x.e.name, date: x.e.event_date, winner: x.f.winner }])), finalists: newFinalists, winners: newWinners, corrections: rowCorrections.length + 6 }, null, 1));
if (!WRITE) { console.log('(dry run — pass --write)'); process.exit(0); }
for (const [p, t] of outputs) fs.writeFileSync(p, t);
console.log('wrote web/data/tuf/seasons.json and web/data/tuf/seasons/tuf-33.json');
