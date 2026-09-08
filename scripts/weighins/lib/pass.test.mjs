/* The live pass: window, storage, corrections, status mirror, boundaries.
 * Run: node --test scripts/weighins/lib/pass.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { planWindow, CADENCE, WINDOW } from './window.mjs';
import { parseUfcOfficial, parseCommissionTable, parseWireItem, matchFighter, parseWeighInSources } from './sources.mjs';
import { storeReadings, mirrorMisses, LOCK_ID, WORKER } from '../weighin_pass.mjs';

/* ================= the boundary ================= */

function importGraph(entryUrl) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { return; }
    for (const m of src.matchAll(/^\s*import\s[\s\S]*?from\s+['"](\.[^'"]+)['"]/gm)) walk(resolvePath(dirname(file), m[1]));
  };
  walk(fileURLToPath(entryUrl));
  return [...seen];
}

test('the live pass can never reach a model, an article writer or a DNA build', () => {
  /* A weigh-in desk polling every three minutes that quietly starts paying per
   * fighter per correction would cost money continuously and look like it is
   * working. Enforced rather than promised. */
  const graph = importGraph(new URL('../weighin_pass.mjs', import.meta.url));
  const banned = ['write_articles.mjs', 'polish_world_class.mjs', 'anthropic.mjs', 'build_fight_dna.mjs'];
  for (const file of graph) {
    for (const b of banned) assert.ok(!file.endsWith(b), `the weigh-in pass reaches ${b}`);
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes('api.anthropic.com'), `${file} contains a model endpoint`);
  }
  assert.ok(graph.some((f) => f.endsWith('weights.mjs')), 'sanity: the walk found the arithmetic');
  assert.ok(graph.some((f) => f.endsWith('sources.mjs')), 'and the adapters');
});

test('the weigh-in desk does not queue behind the newsroom', () => {
  /* A four-minute editorial sweep holding the newsroom lock would silence the
   * desk for the exact window the feature exists for. */
  assert.equal(LOCK_ID, 'weigh-ins');
  assert.notEqual(LOCK_ID, 'newsroom');
  assert.equal(WORKER, 'ufc-weigh-ins', 'and its ledger rows are its own');
});

/* ================= the window ================= */

const AT = (iso) => Date.parse(iso);
const EVENT = { id: 'e1', name: 'UFC 331', event_date: '2026-09-19' };

test('the pass is live through weigh-in morning', () => {
  /* Weigh-ins are the morning before the card. */
  const p = planWindow({ nextEvent: EVENT, now: AT('2026-09-18T09:30:00Z') });
  assert.equal(p.mode, 'live');
  assert.equal(p.minEveryMinutes, CADENCE.live);
  assert.ok(CADENCE.live >= 2 && CADENCE.live <= 5, 'a 2-5 minute cadence during the window');
});

test('outside fight week the pass is idle and fetches nothing', () => {
  const p = planWindow({ nextEvent: EVENT, now: AT('2026-09-01T12:00:00Z') });
  assert.equal(p.mode, 'idle');
  assert.equal(p.minEveryMinutes, CADENCE.idle);
  assert.ok(CADENCE.idle >= 12 * 60, 'idle must be genuinely cheap, not merely slower');
});

test('fight week but not weigh-in morning is a slower watch', () => {
  const p = planWindow({ nextEvent: EVENT, now: AT('2026-09-16T12:00:00Z') });
  assert.equal(p.mode, 'watch');
  assert.ok(p.minEveryMinutes > CADENCE.live && p.minEveryMinutes < CADENCE.idle);
});

test('a pass that ran a minute ago skips before touching a source', () => {
  const p = planWindow({ nextEvent: EVENT, now: AT('2026-09-18T09:30:00Z'), lastRunAt: '2026-09-18T09:29:00Z' });
  assert.equal(p.skip, true, 'the cadence gate is what makes a one-minute trigger affordable');
  assert.match(p.reason, /minimum/);
});

test('a pass that last ran long enough ago proceeds', () => {
  const p = planWindow({ nextEvent: EVENT, now: AT('2026-09-18T09:30:00Z'), lastRunAt: '2026-09-18T09:20:00Z' });
  assert.equal(p.skip, false);
});

test('no upcoming event, an unparseable date, or a past card are all idle', () => {
  assert.equal(planWindow({ nextEvent: null, now: AT('2026-09-18T09:30:00Z') }).mode, 'idle');
  assert.equal(planWindow({ nextEvent: { id: 'x', event_date: 'soon' }, now: AT('2026-09-18T09:30:00Z') }).mode, 'idle');
  assert.equal(planWindow({ nextEvent: EVENT, now: AT('2026-09-25T09:30:00Z') }).mode, 'idle');
});

test('the window opens before and closes after the scale, generously', () => {
  assert.ok(WINDOW.opensHoursBefore > 24, 'weigh-ins are the day before, so the window must span it');
  assert.ok(WINDOW.closesHoursBefore < WINDOW.opensHoursBefore);
  assert.ok(WINDOW.watchHoursBefore > WINDOW.opensHoursBefore);
});

/* ================= parsers ================= */

test('the official page yields name/weight pairs and no verdict', () => {
  const rows = parseUfcOfficial('Jane Doe (155.5) vs. John Roe (156)\nAlex Poe (135) vs. Sam Vega (136)');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.weight), [155.5, 156, 135, 136]);
  for (const r of rows) assert.ok(!('result' in r), 'whether a weight made the limit depends on a contract this parser cannot see');
});

test('a commission table is surname-first and still resolves', () => {
  const rows = parseCommissionTable('DOE, JANE  155.5\nROE, JOHN   156.0\nnot a row at all');
  assert.deepEqual(rows.map((r) => r.name), ['JANE DOE', 'JOHN ROE']);
  assert.equal(rows[0].weight, 155.5);
});

test('a wire miss with no figure records the miss and invents no number', () => {
  const r = parseWireItem('Jane Doe misses weight for UFC 331 co-main event');
  assert.equal(r.unmeasuredMiss, true);
  assert.ok(r.raw.length, 'and keeps the sentence it came from');
});

test('a wire report with a figure beside the name takes the figure', () => {
  const rows = parseWireItem('Jane Doe (158.5 lbs) missed weight on Friday morning.');
  assert.equal(rows[0].weight, 158.5);
  assert.equal(rows[0].reportedMiss, true);
});

test('a number floating in prose is not attached to anybody', () => {
  /* "the 155 lb division" must not become somebody's official weight. */
  const rows = parseWireItem('The 155 lb division is stacked ahead of Saturday.');
  assert.ok(Array.isArray(rows) ? rows.length === 0 : rows.unmeasuredMiss !== true);
});

test('only fighters booked on this card are matchable', () => {
  const card = [{ id: 'f1', name: 'Jane Doe' }, { id: 'f2', name: 'John Roe' }];
  assert.equal(matchFighter('Jane Doe', card).fighter.id, 'f1');
  assert.equal(matchFighter('Doe', card)?.fighter?.id, 'f1', 'a unique surname on the card resolves');
  assert.equal(matchFighter('Someone Else', card), null, 'a name not on the card attaches to nobody');
});

test('an ambiguous surname on one card attaches to nobody', () => {
  const card = [{ id: 'f1', name: 'Jane Silva' }, { id: 'f2', name: 'Bruno Silva' }];
  assert.equal(matchFighter('Silva', card), null, 'a weight on the wrong athlete is worse than a missing row');
});

test('with no fetcher supplied, nothing is contacted and it says so', () => {
  return parseWeighInSources({ event: EVENT, bouts: [], fighters: [] }).then((r) => {
    assert.deepEqual(r.readings, []);
    assert.equal(r.sources_fetched, 0);
    assert.match(r.note, /no source was contacted/);
  });
});

/* ================= storage, replay, corrections ================= */

function fakeDb(existing = []) {
  const table = new Map(existing.map((r) => [r.fingerprint, r]));
  const status = new Map();
  const patches = [];
  let seq = 0;
  const sb = {
    async select(name) {
      if (name === 'ufc_weigh_in_results') return [...table.values()].filter((r) => !r.superseded_at);
      return [];
    },
    async insert(name, rows, opts) {
      assert.equal(opts.returning, true, 'counting inserted rows requires representation');
      assert.equal(opts.ignoreDuplicates, true);
      const target = name === 'ufc_weigh_in_results' ? table : status;
      const out = [];
      for (const r of rows) {
        if (target.has(r.fingerprint)) continue;
        const withId = { ...r, id: `${name === 'ufc_weigh_in_results' ? 'w' : 's'}${++seq}` };
        target.set(r.fingerprint, withId);
        out.push(withId);
      }
      return out;
    },
    async patch(name, filter, body) {
      patches.push({ name, filter, body });
      for (const r of table.values()) if (filter.includes(r.id)) Object.assign(r, body);
      return [];
    },
  };
  return { sb, table, status, patches };
}

const reading = (over = {}) => ({
  event_id: 'e1', bout_id: 'b1', fighter_id: 'f1',
  contracted_limit_lbs: 155, allowance_lbs: 1, limit_basis: 'division_rule',
  official_weight_lbs: 155.5, attempt_number: 1, result: 'made', over_by_lbs: null,
  catchweight_lbs: null, weighed_at: null,
  source_url: 'https://www.ufc.com/event/ufc-331', source_name: 'UFC.com', source_kind: 'official',
  source_published_at: '2026-09-18T09:12:00Z', detected_at: '2026-09-18T09:15:00Z',
  first_seen_at: '2026-09-18T09:15:00Z', last_seen_at: '2026-09-18T09:15:00Z',
  raw_text: 'Jane Doe (155.5)', provenance: {}, fingerprint: 'fp-made-155.5',
  _fighter_name: 'Jane Doe', _unmeasured_miss: false,
  ...over,
});

test('replaying an identical reading inserts nothing and changes no cardinality', async () => {
  const { sb, table } = fakeDb();
  const first = await storeReadings(sb, [reading()]);
  assert.equal(first.counters.inserted, 1);
  assert.equal(table.size, 1);

  const replay = await storeReadings(sb, [reading()]);
  assert.equal(replay.counters.inserted, 0, 'a re-read is not a write');
  assert.equal(replay.counters.duplicate_noop, 1);
  assert.equal(table.size, 1, 'and the table is unchanged');
});

test('twenty passes over one unchanged weigh-in report zero inserts', async () => {
  const { sb, table } = fakeDb();
  await storeReadings(sb, [reading()]);
  let claimed = 0;
  for (let i = 0; i < 20; i += 1) claimed += (await storeReadings(sb, [reading()])).counters.inserted;
  assert.equal(claimed, 0, 'a three-minute cadence must not report the same weight as new all morning');
  assert.equal(table.size, 1);
});

test('a changed weight becomes a correction chain, not a silent overwrite', async () => {
  const { sb, table, patches } = fakeDb();
  await storeReadings(sb, [reading({ official_weight_lbs: 158.0, result: 'missed', over_by_lbs: 2.0, fingerprint: 'fp-158.0' })]);
  const corr = await storeReadings(sb, [reading({ official_weight_lbs: 158.5, result: 'missed', over_by_lbs: 2.5, fingerprint: 'fp-158.5' })]);

  assert.equal(corr.counters.corrections, 1);
  assert.equal(table.size, 2, 'both readings exist; nothing was overwritten');
  const superseded = patches.find((p) => p.body.superseded_at);
  assert.ok(superseded, 'the earlier reading is marked superseded rather than deleted');
  const original = [...table.values()].find((r) => r.official_weight_lbs === 158.0);
  assert.equal(original.official_weight_lbs, 158.0, 'the number that was on the page is still answerable');
});

test('pending becomes made without losing the pending record', async () => {
  const { sb, table } = fakeDb();
  await storeReadings(sb, [reading({ result: 'pending', official_weight_lbs: null, fingerprint: 'fp-pending' })]);
  await storeReadings(sb, [reading({ result: 'made', official_weight_lbs: 155.5, fingerprint: 'fp-made' })]);
  assert.equal(table.size, 2);
});

test('pending becomes missed, and the miss carries its delta', async () => {
  const { sb, status } = fakeDb();
  await storeReadings(sb, [reading({ result: 'pending', official_weight_lbs: null, fingerprint: 'fp-p' })]);
  await storeReadings(sb, [reading({ result: 'missed', official_weight_lbs: 158.5, over_by_lbs: 2.5, fingerprint: 'fp-m' })]);
  const ev = [...status.values()];
  assert.equal(ev.length, 1);
  assert.match(ev[0].status_detail, /Missed weight by 2.5 lb/);
});

/* ================= status mirror ================= */

test('a miss creates exactly one weight_miss status event, and a replay creates none', async () => {
  const { sb, status } = fakeDb();
  const miss = reading({ result: 'missed', official_weight_lbs: 158.5, over_by_lbs: 2.5, fingerprint: 'fp-miss' });
  await storeReadings(sb, [miss]);
  assert.equal(status.size, 1);

  for (let i = 0; i < 5; i += 1) await storeReadings(sb, [miss]);
  assert.equal(status.size, 1, 'five more passes must not mint five more claims about a named athlete');
});

test('the mirrored status event carries provenance and no medical inference', async () => {
  const { sb, status } = fakeDb();
  await storeReadings(sb, [reading({ result: 'missed', official_weight_lbs: 158.5, over_by_lbs: 2.5, fingerprint: 'fp-miss' })]);
  const ev = [...status.values()][0];
  assert.equal(ev.status_type, 'weight_miss');
  assert.equal(ev.event_id, 'e1');
  assert.equal(ev.bout_id, 'b1');
  assert.equal(ev.source_url, 'https://www.ufc.com/event/ufc-331');
  assert.equal(ev.source_kind, 'official');
  assert.ok(ev.weigh_in_result_id, 'the link back to the measurement');
  /* A missed cut is not a diagnosis. */
  for (const clinical of ['injury_type', 'body_part', 'injury_side', 'clinical_quote']) {
    assert.equal(clinical in ev, false, `${clinical} must not appear on a weight-miss event`);
  }
});

test('a made weight mirrors nothing', async () => {
  const { sb, status } = fakeDb();
  await storeReadings(sb, [reading()]);
  assert.equal(status.size, 0, 'making weight is not an availability event');
});

test('an unmeasured miss still mirrors, with the numeric fields absent', async () => {
  const { sb, status } = fakeDb();
  await storeReadings(sb, [reading({
    result: 'pending', official_weight_lbs: null, over_by_lbs: null,
    contracted_limit_lbs: null, allowance_lbs: null, limit_basis: 'unsupported',
    fingerprint: 'fp-unmeasured', _unmeasured_miss: true,
  })]);
  const ev = [...status.values()][0];
  assert.equal(ev.status_type, 'weight_miss');
  assert.match(ev.status_detail, /no figure published/);
});

test('a withdrawal after weighing in keeps the weight on file', async () => {
  const { sb, table } = fakeDb();
  await storeReadings(sb, [reading({ result: 'made', official_weight_lbs: 155.5, fingerprint: 'fp-made' })]);
  await storeReadings(sb, [reading({ result: 'withdrawn', official_weight_lbs: null, fingerprint: 'fp-wd' })]);
  assert.equal(table.size, 2, 'the fighter made weight and then came off; both are true and both are stored');
  assert.ok([...table.values()].some((r) => r.official_weight_lbs === 155.5));
});

test('counters always add up', async () => {
  const { sb } = fakeDb();
  const r = await storeReadings(sb, [reading({ fingerprint: 'a' }), reading({ fingerprint: 'b', fighter_id: 'f2' })]);
  const { offered, inserted, duplicate_noop: dup, rejected } = r.counters;
  assert.equal(inserted + dup + rejected, offered);
});
