/* The Cloudflare path: the pass core runs in a Worker, reads the newsroom's
 * stored text, and fetches only the verified UFC.com results article.
 * Run: node --test scripts/weighins/lib/worker_path.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { sha256 } from './sha256.mjs';
import { matchFighter, parseUfcOfficial, parseWireItem, parseWeighInSources, SOURCE_ADAPTERS } from './sources.mjs';
import { storeReadings } from './pass_core.mjs';

function importGraph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (m[1].startsWith('.')) walk(resolvePath(dirname(file), m[1]));
      else seen.add(`bare:${m[1]}`);
    }
  };
  walk(fileURLToPath(entry));
  return [...seen];
}

test('the Worker import graph has no Node built-ins and no model/article modules', () => {
  const graph = importGraph(new URL('../../../workers/ufc-weigh-ins/src/index.js', import.meta.url));
  const bare = graph.filter((f) => f.startsWith('bare:'));
  assert.deepEqual(bare, [], `the Worker path imports ${bare.join(', ')}`);
  for (const file of graph) {
    for (const b of ['write_articles.mjs', 'polish_world_class.mjs', 'anthropic.mjs', 'build_fight_dna.mjs', 'news/lib.mjs']) assert.ok(!file.endsWith(b), `Worker reaches ${b}`);
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes('api.anthropic.com'), `${file} contains a model endpoint`);
    assert.ok(!/\bprocess\.env\b|\breadFileSync\b/.test(src), `${file} assumes a Node host`);
  }
  assert.ok(graph.some((f) => f.endsWith('pass_core.mjs')));
});

test('the pure-JS sha256 matches node:crypto byte for byte', () => {
  const inputs = ['', 'abc', 'e1|f1|1|155.5|made|https://www.ufc.com/news/x', 'Édgar Cháirez — 130 lb', 'x'.repeat(1000)];
  for (const s of inputs) assert.equal(sha256(s), createHash('sha256').update(s).digest('hex'));
});

test('the official lane never builds a slug: only newsroom-discovered UFC.com URLs', () => {
  const official = SOURCE_ADAPTERS.find((a) => a.kind === 'official');
  assert.deepEqual(official.url({ id: 'e', name: 'Noche UFC' }, null), []);
  assert.deepEqual(official.url({}, { official: [{ url: 'https://www.ufc.com/news/noche-ufc-silva-delgado-official-weigh-in-results' }] }),
    ['https://www.ufc.com/news/noche-ufc-silva-delgado-official-weigh-in-results']);
});

const CARD = [
  { id: 'f-silva', name: 'Jean Silva' }, { id: 'f-delgado', name: 'Jose Miguel Delgado' },
  { id: 'f-elliott', name: 'Tim Elliott' }, { id: 'f-chairez', name: 'Édgar Cháirez' },
  { id: 'f-rafa', name: 'Rafa Garcia' }, { id: 'f-moreno', name: 'Brandon Moreno' },
  { id: 'f-morales', name: 'Joseph Morales' }, { id: 'f-mcm', name: 'Tommy McMillen' },
];
const BOUTS = [
  { id: 'b1', fighter_a_id: 'f-silva', fighter_b_id: 'f-delgado', weight_class: 'FEATHERWEIGHT', is_title: false },
  { id: 'b2', fighter_a_id: 'f-elliott', fighter_b_id: 'f-chairez', weight_class: 'CATCHWEIGHT', is_title: false },
  { id: 'b3', fighter_a_id: 'f-moreno', fighter_b_id: 'f-morales', weight_class: 'FLYWEIGHT', is_title: false },
];

test('a boxer weighing in the same morning never becomes a UFC fighter', () => {
  assert.equal(matchFighter('Ryan Garcia', CARD), null, 'Ryan Garcia is not Rafa Garcia');
  assert.equal(matchFighter('Rafa Garcia', CARD).fighter.id, 'f-rafa');
  assert.equal(matchFighter('Main Card Jean Silva', CARD).fighter.id, 'f-silva', 'a heading glued onto the name');
  assert.equal(matchFighter('Jose Delgado', CARD).fighter.id, 'f-delgado', 'middle name omitted');
  assert.equal(matchFighter('Edgar Chairez', CARD).fighter.id, 'f-chairez', 'accents folded');
});

const OFFICIAL_TEXT = `Official Weigh-In Results | Noche UFC
Up Next
UFC 999: Somebody (170) vs Nobody (170)
Weigh-In Results:
MAIN CARD
Main Event - Featherweight Bout: Jean Silva (145) vs Jose Miguel Delgado (145.5)
Co-Main Event - Flyweight Bout: Brandon Moreno (125.5) vs Joseph Morales (125.5)
PRELIMS
Catchweight (130-lbs) Bout: Tim Elliott (130) vs Edgar Chairez (130)
Tags
Boxing: Ryan Garcia (147) vs Conor Benn (147)`;

test('the official results block parses pairs and the per-line catchweight, and nothing outside it', () => {
  const rows = parseUfcOfficial(OFFICIAL_TEXT);
  const names = rows.map((r) => r.name);
  assert.ok(!names.some((n) => /Somebody|Ryan Garcia/.test(n)), 'rails around the article are ignored');
  const elliott = rows.find((r) => /Elliott/.test(r.name));
  assert.equal(elliott.weight, 130);
  assert.equal(elliott.limit, 130, 'the catchweight is sourced from the label');
  assert.equal(rows.find((r) => /Silva/.test(r.name)).limit, null, 'no limit is invented for a division bout');
});

test('the fast lane reads stored newsroom text and contacts nobody', async () => {
  const wire = { url: 'https://www.mmafighting.com/ufc/1/noche-ufc-weigh-in-results', name: 'MMA Fighting', news_item_id: 'n1', published_at: '2026-09-11T16:00:00Z',
    text: 'Main Card Jean Silva (145) vs. Jose Miguel Delgado (145.5) Brandon Moreno (125.5) vs. Joseph Morales (125.5). The bout between Tim Elliott and Edgar Chairez was changed to a 130-pound catchweight. Tim Elliott (130) vs. Edgar Chairez (130)' };
  let contacted = 0;
  const r = await parseWeighInSources({ event: { id: 'e' }, bouts: BOUTS, fighters: CARD, fetchImpl: () => { contacted += 1; throw new Error('no'); }, discovered: { official: [], wire: [wire] } });
  assert.equal(contacted, 0, 'no publisher is refetched');
  assert.equal(r.readings.length, 6);
  assert.ok(r.readings.every((x) => x.source_kind === 'news' && x.news_item_id === 'n1'));
  assert.equal(r.readings.find((x) => x.fighter_id === 'f-elliott').sourced_limit_lbs, 130);
  assert.equal(r.readings.find((x) => x.fighter_id === 'f-morales').sourced_limit_lbs, null, 'a catchweight in a run-on text attaches only to the bout it names');
});

test('an official page naming too few booked fighters is rejected', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => 'Weigh-In Results:\nFeatherweight Bout: Jean Silva (145) vs Somebody Else (145)\nTags' });
  const r = await parseWeighInSources({ event: {}, bouts: BOUTS, fighters: CARD, fetchImpl, discovered: { official: [{ url: 'https://www.ufc.com/news/x-official-weigh-in-results' }], wire: [] } });
  assert.equal(r.readings.length, 0);
  assert.equal(r.trail[0].status, 'rejected');
});

/* ---------------- authority ordering over a database fake that behaves like PostgREST */

function db() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async select() { return rows.map((r) => ({ ...r })); },
    async insert(_t, batch, opts) {
      assert.equal(opts.returning, true);
      const out = [];
      for (const r of batch) {
        if (rows.some((x) => x.fingerprint === r.fingerprint)) continue;
        const row = { superseded_at: null, ...r, id: `w${++seq}` };
        rows.push(row);
        out.push({ ...row });
      }
      return out;
    },
    async patch(_t, filter, body) { for (const r of rows) if (filter === `id=eq.${r.id}`) Object.assign(r, body); return []; },
  };
}
const current = (rows) => {
  const live = rows.filter((r) => !r.superseded_at);
  return new Map(live.map((r) => [r.fighter_id, r]));
};
const R = (kind, weight, over = {}) => ({
  event_id: 'e1', bout_id: 'b1', fighter_id: 'f-silva', attempt_number: 1, official_weight_lbs: weight, result: 'made',
  source_kind: kind, source_name: kind === 'official' ? 'UFC.com' : 'MMA Fighting', source_url: `https://${kind}.example/${weight}`,
  detected_at: '2026-09-11T16:00:00Z', fingerprint: `${kind}-${weight}`, _fighter_name: 'Jean Silva', _unmeasured_miss: false, ...over,
});

test('wire then official in one pass: official is current, the wire row is kept and superseded', async () => {
  const sb = db();
  const w = await storeReadings(sb, [R('official', 145), R('news', 145)]);
  assert.equal(w.counters.inserted, 2);
  assert.equal(w.counters.confirmations, 1);
  assert.equal(sb.rows.length, 2, 'history keeps both');
  const cur = current(sb.rows).get('f-silva');
  assert.equal(cur.source_kind, 'official');
  assert.equal(cur.supersedes_id, sb.rows.find((r) => r.source_kind === 'news').id);
});

test('official with a different number is a visible correction of the wire', async () => {
  const sb = db();
  await storeReadings(sb, [R('news', 145.5)]);
  const w = await storeReadings(sb, [R('official', 145)]);
  assert.equal(w.counters.corrections, 1);
  const cur = current(sb.rows).get('f-silva');
  assert.equal(Number(cur.official_weight_lbs), 145);
  assert.match(cur.correction_reason, /corrected 145.5 → 145/);
});

test('a wire reading arriving after the official is archived, never current', async () => {
  const sb = db();
  await storeReadings(sb, [R('official', 145)]);
  const w = await storeReadings(sb, [R('news', 146)]);
  assert.equal(w.counters.lower_authority_archived, 1);
  assert.equal(current(sb.rows).get('f-silva').source_kind, 'official');
  assert.equal(sb.rows.length, 2);
});

test('the next cron over the same sources is all duplicate no-ops', async () => {
  const sb = db();
  const batch = () => [R('news', 145), R('official', 145), R('news', 145.5, { fighter_id: 'f-delgado', fingerprint: 'n-d' }), R('official', 145.5, { fighter_id: 'f-delgado', fingerprint: 'o-d' })];
  await storeReadings(sb, batch());
  const n = sb.rows.length;
  for (let i = 0; i < 5; i += 1) {
    const again = await storeReadings(sb, batch());
    assert.equal(again.counters.inserted, 0);
    assert.equal(again.counters.duplicate_noop, 4);
    assert.equal(again.counters.corrections + again.counters.confirmations, 0);
  }
  assert.equal(sb.rows.length, n);
});
