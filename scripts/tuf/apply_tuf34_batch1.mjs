#!/usr/bin/env node
/**
 * TUF Phase 2, repair batch 1: TUF 34. Approved 2026-09-13.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env \
 *     node scripts/tuf/apply_tuf34_batch1.mjs [--write]
 *   node scripts/tuf/resolve_identity.mjs --write     # then re-stamp the ids
 *
 * Idempotent. Reads scripts/tuf/evidence/tuf34_phase2_2026-09-13.json and
 * selects (read-only) the two announced finale bouts. Without --write it
 * prints what it would change. Every assertion below must hold or nothing is
 * written.
 *
 * What it does, and what it deliberately does not:
 *
 *   - The two tournament finals become SCHEDULED professional bouts, linked to
 *     the announced ufc_bouts rows by exact finalist ids. No winner, method or
 *     round is written: a bout that has not happened has no result. The season
 *     stays ongoing with no winners.
 *   - The draft's "conflicts" on those finals are moved to _resolved_conflicts:
 *     the source named no winner because none existed yet.
 *   - Name repairs. Mehemedeli / Illimbek are misspellings of the ESPN and
 *     broadcaster spellings, kept on the roster as printed_as. Giovanna Canuto
 *     is a SOURCE CORRECTION to Gigi Canuto: no first-party source attests
 *     "Giovanna", so it is kept only as the superseded draft spelling in
 *     name_corrections, never as an alias.
 *   - Episode numbers for the ten bouts the broadcaster's own listing names,
 *     each with the listing's short sentence. The listing states pairing,
 *     stage and episode only; `states_winner: false` is carried with it, and
 *     the source is recorded without 'winner' in its fields, so it can never
 *     verify a house result.
 *   - House classifications stay unverified. Absence from our records is not
 *     affirmative proof that a bout was an exhibition.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');
const SLUG = 'tuf-34';
const BATCH = 'tuf34-batch1';

const env = { ...process.env };
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
async function q(p) {
  const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${p}`, { headers: H });
  if (!r.ok) throw new Error(`${p.split('?')[0]} ${r.status} ${await r.text()}`);
  return r.json();
}
const fail = (msg) => { console.error(`STOP: ${msg}`); process.exit(1); };
const fold = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const one = (v) => (Array.isArray(v) ? v[0] : v);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const evidencePath = path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf34_phase2_2026-09-13.json');
const evidence = readJson(evidencePath);
const seasonPath = path.join(DATA, 'seasons', `${SLUG}.json`);
const season = readJson(seasonPath);
const inventoryPath = path.join(DATA, 'seasons.json');
const inventory = readJson(inventoryPath);
const row = inventory.seasons.find((s) => s.slug === SLUG);
if (!row) fail('tuf-34 missing from the inventory');
if (row.season_state !== 'ongoing' || row.winners.length) fail('tuf-34 must still be ongoing with no winners');

const changes = [];
const bouts = () => season.bracket.flatMap((br) => br.stages.flatMap((st) => st.bouts.map((b) => ({ b, weight_class: br.weight_class, stage: st.stage }))));

/* ---- 1. names ------------------------------------------------------------ */
const ESPN = (id) => `https://sports.core.api.espn.com/v2/sports/mma/athletes/${id}`;
const listing = evidence.official_broadcaster_episode_claims[0];
const NAME_CORRECTIONS = [
  {
    draft_name: 'Mehemedeli Osmanli', name: 'Mehemmedeli Osmanli', fighter_id: '13dd06fe-1f79-401b-9a8a-23c61a907745',
    kind: 'spelling_variant', keep_draft_as_printed_as: true,
    basis: 'ESPN athlete 5345640 and the official episode listing both spell Mehemmedeli; the draft bracket dropped one letter. The same finalist\'s announced finale bout against Ilimbek Akylbek Uulu is stored by exact id.',
    sources: [{ family: 'espn_core_api', url: ESPN('5345640'), retrieved: evidence.identity_evidence[2].retrieved },
      { family: 'paramount_plus_episode_metadata', url: listing.url, retrieved: listing.retrieved, content_id: 'ALVE01KXEGE369ESES24FF74YSXA0V' }],
  },
  {
    draft_name: 'Illimbek Akylbek Uulu', name: 'Ilimbek Akylbek Uulu', fighter_id: '70116fec-53b8-4a05-8684-4415498f4889',
    kind: 'spelling_variant', keep_draft_as_printed_as: true,
    basis: 'ESPN athlete 5345639 and the official episode listing both spell Ilimbek; the draft roster doubled the l. The bracket already used the correct spelling.',
    sources: [{ family: 'espn_core_api', url: ESPN('5345639'), retrieved: evidence.identity_evidence[3].retrieved },
      { family: 'paramount_plus_episode_metadata', url: listing.url, retrieved: listing.retrieved, content_id: 'ALVE01KXEG9H3GE1XBPFBZG5A850XW' }],
  },
  {
    draft_name: 'Giovanna Canuto', name: 'Gigi Canuto', fighter_id: 'b4028b75-c0ad-4087-b91f-4ed24306eeb6',
    kind: 'source_correction', keep_draft_as_printed_as: false,
    official_alias: false,
    basis: 'ESPN athlete 5097909 is Gigi Canuto of Brazil, the only Canuto in ufc_fighters. The official episode listing independently names "Gigi Canuto of Brazil" in exactly the two bouts the draft gave to Giovanna Canuto: episode 3 against Anita Karim and episode 9 against Melissa Amaya. "Giovanna" appears only in the Wikipedia draft and no first-party source attests it, so it is kept here as the superseded draft spelling and is not an alias.',
    sources: [{ family: 'espn_core_api', url: ESPN('5097909'), retrieved: evidence.identity_evidence[1].retrieved },
      { family: 'paramount_plus_episode_metadata', url: listing.url, retrieved: listing.retrieved, content_id: 'ALVE01KV8XD7RZEDT8N54BHEEJ5PNH' },
      { family: 'paramount_plus_episode_metadata', url: listing.url, retrieved: listing.retrieved, content_id: 'ALVE01KXEG7ZZ8E3KSN3EQTKZSW2D8' }],
  },
];

const dbNames = new Map((await q(`ufc_fighters?select=id,name&id=in.(${NAME_CORRECTIONS.map((c) => c.fighter_id).join(',')})`)).map((f) => [f.id, f.name]));
for (const c of NAME_CORRECTIONS) {
  if (dbNames.get(c.fighter_id) !== c.name) fail(`${c.fighter_id} is "${dbNames.get(c.fighter_id)}" in ufc_fighters, expected "${c.name}"`);
}
const canuto = await q('ufc_fighters?select=id,name&name=ilike.*canuto*');
if (canuto.length !== 1) fail(`expected exactly one Canuto in ufc_fighters, found ${canuto.length}`);

const corrected = new Map((season.name_corrections || []).map((c) => [c.draft_name, c]));
for (const c of NAME_CORRECTIONS) {
  const applied = { bout_corners: 0, bout_winners: 0, roster: 0 };
  for (const { b } of bouts()) {
    if (b.a === c.draft_name) { b.a = c.name; applied.bout_corners += 1; }
    if (b.b === c.draft_name) { b.b = c.name; applied.bout_corners += 1; }
    if (b.winner === c.draft_name) { b.winner = c.name; applied.bout_winners += 1; }
  }
  for (const t of season.teams) for (const p of t.roster) {
    if (p.name !== c.draft_name) continue;
    p.name = c.name;
    if (c.keep_draft_as_printed_as) p.printed_as = c.draft_name;
    applied.roster += 1;
  }
  const touched = applied.bout_corners + applied.bout_winners + applied.roster;
  if (!touched && !corrected.has(c.draft_name)) fail(`"${c.draft_name}" is not in the season file and was never corrected`);
  if (touched) {
    const { keep_draft_as_printed_as, ...record } = c;
    corrected.set(c.draft_name, { ...record, batch: BATCH, applied });
    changes.push(`name ${c.draft_name} -> ${c.name} (${JSON.stringify(applied)})`);
  }
}
season.name_corrections = [...corrected.values()];

for (const t of season.teams) for (const p of t.roster) {
  if (p.weight_class === "Men's Bantameight") { p.weight_class = "Men's Bantamweight"; changes.push(`roster weight class typo fixed for ${p.name}`); }
}

/* ---- 2. episode numbers from the broadcaster's listing ------------------- */
/* Names as the listing prints them -> the name the archive carries. Only
 * identities already established by id. */
const LISTING_NAME = { 'Tina Black': 'Valesca Machado', 'Gigi Canuto': 'Gigi Canuto' };
for (const claim of evidence.official_broadcaster_episode_claims) {
  if (claim.states_winner !== false) fail(`episode ${claim.episode}: a listing claim must record that it states no winner`);
  const archiveNames = claim.pairing.map((n) => LISTING_NAME[n] || n);
  const hits = bouts().filter(({ b, weight_class, stage }) => weight_class === claim.weight_class && stage === claim.stage
    && [fold(b.a), fold(b.b)].sort().join('|') === archiveNames.map(fold).sort().join('|'));
  if (hits.length !== 1) fail(`episode ${claim.episode}: ${claim.pairing.join(' vs ')} matches ${hits.length} ${claim.weight_class} ${claim.stage} bouts`);
  const { b } = hits[0];
  if (b.episode != null && b.episode !== claim.episode) fail(`${b.a} vs ${b.b}: already episode ${b.episode}, listing says ${claim.episode}`);
  const repair = `${BATCH}-episode-${claim.episode}`;
  const printed = Object.fromEntries(claim.pairing.filter((n) => LISTING_NAME[n] && LISTING_NAME[n] !== n).map((n) => [LISTING_NAME[n], n]));
  const src = {
    repair, fields: ['episode'], url: claim.url, family: 'paramount_plus_episode_metadata', content_id: claim.content_id,
    retrieved: claim.retrieved, quote: claim.quote, states_winner: false,
    ...(Object.keys(printed).length ? { printed_names: printed } : {}),
  };
  if (b.episode !== claim.episode) changes.push(`episode ${claim.episode}: ${b.a} vs ${b.b}`);
  b.episode = claim.episode;
  b.sources = [...(b.sources || []).filter((s) => s.repair !== repair), src];
}
for (const { b, stage } of bouts()) {
  if (stage === 'final' || b.episode != null) continue;
  b.episode_blocker = b.a === 'Christian Strong' && b.b === 'Marlon Jones'
    ? 'SOURCE_AMBIGUOUS: the listing\'s episode 2 describes "Britain versus the US in the first bantamweight fight" without naming anyone, and the archive records no nationality to attach it by.'
    : 'EPISODE_NOT_AVAILABLE: no episode in the official listing names this pairing.';
}

/* ---- 3. the finals: scheduled, not conflicted ---------------------------- */
const finals = [];
for (const fe of evidence.finale_evidence) {
  const ids = [fe.a_fighter_id, fe.b_fighter_id];
  const rows = await q(`ufc_bouts?select=id,status,event_id,fighter_a_id,fighter_b_id,event:ufc_events(id,name,event_date),result:ufc_bout_results(winner_id)&fighter_a_id=in.(${ids})&fighter_b_id=in.(${ids})`);
  const live = rows.filter((r) => r.fighter_a_id !== r.fighter_b_id && r.status !== 'cancelled');
  if (live.length !== 1) fail(`${fe.weight_class}: expected one live bout between the finalists, found ${live.length}`);
  const bout = live[0];
  const ev = one(bout.event);
  if (ev.name !== fe.event || ev.event_date !== fe.event_date) fail(`${fe.weight_class}: bout is on ${ev.name} ${ev.event_date}, evidence says ${fe.event} ${fe.event_date}`);
  if (one(bout.result)) fail(`${fe.weight_class}: the bout has a result now — resolve it from the result row, not as scheduled`);
  if (bout.status !== 'announced') fail(`${fe.weight_class}: bout status is ${bout.status}`);
  const stage = season.bracket.find((br) => br.weight_class === fe.weight_class)?.stages.find((st) => st.stage === 'final');
  if (stage?.bouts.length !== 1) fail(`${fe.weight_class}: expected one final in the bracket`);
  const b = stage.bouts[0];
  const want = new Map(NAME_CORRECTIONS.map((c) => [c.name, c.fighter_id]));
  for (const [name, id] of [[b.a, b.a_fighter_id], [b.b, b.b_fighter_id]]) {
    const expected = want.get(name) || id;
    if (!ids.includes(expected)) fail(`${fe.weight_class} final: ${name} (${expected}) is not one of the announced bout's fighters`);
  }
  if (b.winner || b.method || b.round) fail(`${fe.weight_class} final already carries a result`);
  const checked = evidence.finale_evidence[0].retrieved.slice(0, 10);
  const verified = `ufc_bouts ${bout.id} — exact finalist-versus-finalist matchup, status announced, no result row (checked ${checked})`;
  Object.assign(b, {
    classification: 'professional',
    classification_source: `scheduled on a sanctioned UFC card, not yet contested: ${ev.name}, ${ev.event_date}; ${verified}`,
    result_state: 'scheduled',
    scheduled: { event: ev.name, date: ev.event_date, event_id: ev.id, ufc_bout_id: bout.id, verified_against: verified },
  });
  finals.push({ weight_class: fe.weight_class, a: b.a, b: b.b, event: ev.name, date: ev.event_date, status: 'scheduled', ufc_bout_id: bout.id, verified_against: verified });
  changes.push(`${fe.weight_class} final scheduled: ${b.a} vs ${b.b}, ${ev.name} ${ev.event_date}, bout ${bout.id}`);
}

const conflicts = season._conflicts || [];
const resolved = season._resolved_conflicts || [];
for (const c of conflicts) {
  const f = finals.find((x) => c.field === `${x.weight_class}_final`);
  if (!f) fail(`unexpected open conflict ${c.field}`);
  resolved.push({
    field: c.field, detail: c.detail, resolved_by: BATCH, resolved_with: f.verified_against,
    resolution: `Not a source conflict. The draft was taken before the final was fought, so no source could name a winner. The bout is scheduled for ${f.date} on ${f.event}; no winner is recorded until its result row exists.`,
  });
  changes.push(`conflict ${c.field} resolved as scheduled`);
}
season._conflicts = [];
season._resolved_conflicts = resolved;

/* ---- 4. inventory: link the finale card ---------------------------------- */
const events = [...new Set(finals.map((f) => `${f.event}|${f.date}`))];
if (events.length !== 1) fail('both finals are expected on one card');
const [event, date] = events[0].split('|');
row.finale_event = event;
row.finale_date = date;
row.finale_link_basis = `Scheduled, not yet fought: both tournament finals are announced bouts on ${event} (${date}), matched by exact finalist ids in ufc_bouts — ${finals.map((f) => `${f.a} vs ${f.b}`).join('; ')}. No winner is recorded until the results exist.`;
row.final_bouts = finals.map(({ weight_class, a, b, event: e, date: d, status, ufc_bout_id, verified_against }) => ({ weight_class, a, b, event: e, date: d, status, ufc_bout_id, verified_against }));
row.winners = [];
row.season_state = 'ongoing';

console.log(changes.join('\n') || 'no changes (already applied)');
if (!WRITE) { console.log('\n(dry run — pass --write)'); process.exit(0); }
fs.writeFileSync(seasonPath, JSON.stringify(season, null, 2) + '\n');
fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + '\n');
console.log('\nwrote web/data/tuf/seasons/tuf-34.json and web/data/tuf/seasons.json — now run resolve_identity.mjs --write');
