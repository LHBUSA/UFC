// Production Elo (elo_core) vs research Elo (features_v2.eloLadder): bit-identical.
//
//   node --test scripts/model/v2/elo_parity.test.mjs                        synthetic fixture
//   PBE_MODEL_CACHE=<extract> node --test scripts/model/v2/elo_parity.test.mjs   + the full historical dataset
//
// The V2 shadow must not deploy unless the full-history test passes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { eloLadder } from './features_v2.mjs';
import { ladderInput, eloRatingsAsOf, eloArtifactBody, eloDiff, sha256Hex, ELO_K, ELO_START } from './elo_core.mjs';

/** The research harness's own input construction (research.mjs / dataset_v2.mjs), reproduced verbatim. */
function researchInput(bouts, events, results) {
  return bouts.map((b) => {
    const date = events.get(b.event_id)?.event_date;
    const f1 = b.fighter_a_id < b.fighter_b_id ? b.fighter_a_id : b.fighter_b_id;
    const f2 = f1 === b.fighter_a_id ? b.fighter_b_id : b.fighter_a_id;
    const r = results.get(b.id);
    const winner = r?.winner_id ? r.winner_id : r?.method === 'DRAW' ? 'draw' : null;
    return { id: b.id, date, f1, f2, winner };
  }).filter((b) => b.date);
}

/** Every bout's research pre-rating must equal the production as-of rating on that bout's date. */
function assertParity(bouts, events, results) {
  const research = eloLadder(researchInput(bouts, events, results), ELO_K);
  const input = ladderInput(bouts, new Map([...events].map(([id, e]) => [id, e.event_date])), results);
  const byDate = new Map();
  for (const b of input) { if (!byDate.has(b.date)) byDate.set(b.date, []); byDate.get(b.date).push(b); }
  let checked = 0;
  for (const [date, list] of byDate) {
    const { ratings, counts } = eloRatingsAsOf(input, date, ELO_K);
    for (const b of list) {
      const pre = research.get(b.id);
      assert.ok(pre, `research has no rating for ${b.id}`);
      assert.equal(ratings.get(b.f1) ?? ELO_START, pre.r1, `r1 ${b.id} ${date}`);
      assert.equal(ratings.get(b.f2) ?? ELO_START, pre.r2, `r2 ${b.id} ${date}`);
      assert.equal(counts.get(b.f1) ?? 0, pre.n1);
      assert.equal(counts.get(b.f2) ?? 0, pre.n2);
      checked += 1;
    }
  }
  return { checked, dates: byDate.size };
}

test('synthetic: same-date double bouts, draws, no contests and unordered input all match research exactly', () => {
  const ev = new Map([['e1', { event_date: '1994-03-11' }], ['e2', { event_date: '1994-03-11' }], ['e3', { event_date: '1995-01-01' }], ['e4', { event_date: '2030-01-01' }]]);
  const F = ['a1', 'b2', 'c3', 'd4', 'e5'];
  const bouts = [
    { id: 'x9', event_id: 'e1', fighter_a_id: F[1], fighter_b_id: F[0] },
    { id: 'x1', event_id: 'e1', fighter_a_id: F[0], fighter_b_id: F[2] }, // same fighter twice on one date
    { id: 'x5', event_id: 'e2', fighter_a_id: F[3], fighter_b_id: F[4] },
    { id: 'x3', event_id: 'e3', fighter_a_id: F[0], fighter_b_id: F[3] },
    { id: 'x4', event_id: 'e3', fighter_a_id: F[2], fighter_b_id: F[4] },
    { id: 'x7', event_id: 'e4', fighter_a_id: F[1], fighter_b_id: F[2] }, // future, unresulted
  ].sort((a, b) => (a.id < b.id ? -1 : 1)); // research input order is id asc, like the extract
  const results = new Map([['x9', { winner_id: F[1] }], ['x1', { winner_id: F[0] }], ['x5', { winner_id: null, method: 'DRAW' }], ['x3', { winner_id: null, method: 'NC' }], ['x4', { winner_id: F[4] }]]);
  const r = assertParity(bouts, ev, results);
  assert.equal(r.checked, 6);
});

test('artifact: deterministic, hash-stable, exclusive of results dated on as_of', async () => {
  const ev = new Map([['e1', { event_date: '2020-01-01' }], ['e2', { event_date: '2020-02-01' }]]);
  const bouts = [{ id: 'b1', event_id: 'e1', fighter_a_id: 'f1', fighter_b_id: 'f2' }, { id: 'b2', event_id: 'e2', fighter_a_id: 'f1', fighter_b_id: 'f3' }];
  const results = new Map([['b1', { winner_id: 'f1' }], ['b2', { winner_id: 'f3' }]]);
  const input = ladderInput(bouts, new Map([...ev].map(([k, v]) => [k, v.event_date])), results);
  const a = eloArtifactBody(input, '2020-02-01');
  const b = eloArtifactBody(input, '2020-02-01');
  assert.equal(await sha256Hex(JSON.stringify(a)), await sha256Hex(JSON.stringify(b)));
  assert.equal(a.results_used, 1, 'the 2020-02-01 result is excluded from the 2020-02-01 artifact');
  assert.ok(eloDiff(a, 'f1', 'f2') > 0);
  assert.equal(eloDiff(a, 'zz', 'yy'), 0, 'unrated fighters read 1500');
});

const CACHE = process.env.PBE_MODEL_CACHE;
test('FULL HISTORY: production as-of ratings equal research pre-bout ratings for every historical bout', { skip: !CACHE && 'set PBE_MODEL_CACHE to the clean extract' }, () => {
  const L = (n) => fs.readFileSync(path.join(CACHE, `${n}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const events = new Map(L('events').map((e) => [e.id, e]));
  const results = new Map(L('results').map((r) => [r.bout_id, r]));
  const bouts = L('bouts');
  const r = assertParity(bouts, events, results);
  console.log(`elo parity: ${r.checked} bouts across ${r.dates} dates, bit-identical`);
  assert.ok(r.checked >= 9000);
});
