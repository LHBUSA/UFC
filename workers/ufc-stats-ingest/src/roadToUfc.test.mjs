/* Road to UFC lane: series detection, card linking, typeless final bouts.
 * Run: node --test src/roadToUfc.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Espn, ROAD_TO_UFC_EVENT } from './espn.mjs';
import { roadToUfc } from './index.js';

test('series: an ESPN event is Road to UFC only when its name begins with the series name', () => {
  for (const n of ['Road to UFC Season 5: Macau Quarterfinals 1', 'Road to UFC: Shanghai Episode 5 & 6', 'Road to UFC: Season 2 Finals']) assert.ok(ROAD_TO_UFC_EVENT.test(n), n);
  for (const n of ['UFC Fight Night: Road to UFC', 'UFC 280: Oliveira vs. Makhachev', "Dana White's Contender Series: Season 10, Week 6", 'PFL Road to Glory', 'Road to UFCX']) assert.ok(!ROAD_TO_UFC_EVENT.test(n), n);
});

const ctxWith = ({ events, bouts, fighters }) => ({ events, bouts, fightersById: new Map(fighters.map((f) => [f.id, f])) });
const raw = (athleteIds) => ({ competitions: [{ competitors: athleteIds.map((id) => ({ id })) }] });

test('linking: a UFC Stats Road to UFC card is linked only by date AND a shared ESPN athlete', () => {
  const ufcstatsCard = { id: 'e46', ufcstats_id: '8fbcd82bf7f352bf', espn_event_id: null, name: 'UFC - Road to UFC 4.6', event_date: '2025-08-22', event_series: 'road_to_ufc' };
  const ctx = ctxWith({
    events: [ufcstatsCard, { id: 'fn', ufcstats_id: 'x', espn_event_id: null, name: 'UFC Fight Night: Walker vs. Zhang', event_date: '2025-08-23', event_series: 'ufc' }],
    bouts: [{ id: 'b1', event_id: 'e46', fighter_a_id: 'f1', fighter_b_id: 'f2' }, { id: 'b2', event_id: 'fn', fighter_a_id: 'f3', fighter_b_id: 'f4' }],
    fighters: [{ id: 'f1', espn_athlete_id: '5140897' }, { id: 'f2', espn_athlete_id: null }, { id: 'f3', espn_athlete_id: '999' }, { id: 'f4', espn_athlete_id: null }],
  });
  assert.equal(roadToUfc.linkRoadToUfcEvent(ctx, raw(['5140897', '5300517']), '2025-08-22')?.id, 'e46');
  assert.equal(roadToUfc.linkRoadToUfcEvent(ctx, raw(['111', '222']), '2025-08-22'), undefined, 'no shared athlete: new card, never a date-only link');
  assert.equal(roadToUfc.linkRoadToUfcEvent(ctx, raw(['5140897']), '2025-09-30'), undefined, 'date outside a day');
  assert.equal(roadToUfc.linkRoadToUfcEvent(ctx, raw(['999']), '2025-08-23'), undefined, 'never links a UFC card, even with a shared athlete');
});

test('typeless FINAL bouts are kept on the Road to UFC lane; typeless unfinished ones stay placeholders; the UFC lane is unchanged', async () => {
  const comp = (id, { type = undefined, final = true } = {}) => ({
    id, type, matchNumber: 1, status: { $ref: `s://${id}`, type: {} },
    competitors: [{ id: '10', order: 1, athlete: { $ref: 'a://10' }, winner: true }, { id: '20', order: 2, athlete: { $ref: 'a://20' }, winner: false }],
    _final: final,
  });
  const payload = () => ({ url: 'e://1', raw: { competitions: [comp('c1'), comp('c2', { final: false }), comp('c3', { type: { text: 'Lightweight' } })] } });
  const espn = new Espn({ minIntervalMs: 0 });
  espn.json = async (u) => {
    const id = String(u).split('//')[1];
    const final = id !== 'c2';
    return { type: { name: final ? 'STATUS_FINAL' : 'STATUS_SCHEDULED', completed: final, state: final ? 'post' : 'pre' }, result: final ? { displayName: 'KO/TKO' } : undefined, period: 1, displayClock: '1:10' };
  };
  const rtu = payload();
  const rows = await espn.bouts(rtu, { allowTypeless: true });
  assert.deepEqual(rows.map((r) => r.espn_competition_id), ['c1', 'c3']);
  assert.equal(rows[0].weight_class_raw, '');
  assert.deepEqual(rtu.skipped, ['c2']);
  const ufc = payload();
  const ufcRows = await espn.bouts(ufc);
  assert.deepEqual(ufcRows.map((r) => r.espn_competition_id), ['c3'], 'UFC lane still treats a typeless competition as a placeholder');
});
