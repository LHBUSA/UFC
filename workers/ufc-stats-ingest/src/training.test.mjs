/* Current-camp capture (migration 032). Run: node --test src/training.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { associationOf, captureAssociation, newTrainingNotes, activeRoster, planCampSweep, CAMP_SWEEP } from './training.mjs';

test('associationOf takes id + name and never the location', () => {
  const doc = { association: { id: 7027, name: ' Teixeira MMA  & Fitness ', location: { country: 'Brazil' } } };
  assert.deepEqual(associationOf(doc), { id: '7027', name: 'Teixeira MMA & Fitness' });
  assert.equal(associationOf({ association: { id: '1' } }), null);
  assert.equal(associationOf({ association: { name: 'Gym' } }), null);
  assert.equal(associationOf({}), null);
  assert.equal(associationOf(null), null);
});

function fakeEnv(response, calls) {
  const env = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response), { status: 200 });
  };
  return env;
}

test('captureAssociation calls the SQL function with the fighter identity and counts the action', async () => {
  const calls = [];
  const env = fakeEnv({ action: 'changed', event_id: 'ev1' }, calls);
  const notes = newTrainingNotes();
  const f = { id: 'f1', espn_athlete_id: '42', name: 'A' };
  await captureAssociation(env, notes, f, { espn_athlete_id: '42', association: { id: '9', name: 'Gym B' }, source_url: 'https://espn/x' }, '2026-09-26T00:00:00Z');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /rest\/v1\/rpc\/ufc_training_record_association$/);
  assert.deepEqual(calls[0].body, { p_fighter_id: 'f1', p_espn_athlete_id: '42', p_association_id: '9', p_association_name: 'Gym B', p_source_url: 'https://espn/x', p_captured_at: '2026-09-26T00:00:00Z' });
  assert.equal(notes.changed, 1);
  assert.deepEqual(notes.changes, [{ fighter_id: 'f1', name: 'A', to: 'Gym B', event_id: 'ev1' }]);
});

test('an absent association is still sent (the SQL side writes nothing and says so)', async () => {
  const calls = [];
  const env = fakeEnv({ action: 'absent' }, calls);
  const notes = newTrainingNotes();
  await captureAssociation(env, notes, { id: 'f1', espn_athlete_id: '42' }, { espn_athlete_id: '42', association: null, source_url: 'https://espn/x' });
  assert.equal(calls[0].body.p_association_id, null);
  assert.equal(notes.absent, 1);
});

test('a document for a different athlete is never written', async () => {
  const calls = [];
  const env = fakeEnv({ action: 'first' }, calls);
  const notes = newTrainingNotes();
  await captureAssociation(env, notes, { id: 'f1', espn_athlete_id: '42' }, { espn_athlete_id: '43', association: { id: '9', name: 'G' } });
  assert.equal(calls.length, 0);
  assert.equal(notes.identity_mismatch, 1);
});

test('a database failure is counted, never thrown into the ingest', async () => {
  const calls = [];
  const env = fakeEnv(new Error('boom'), calls);
  const notes = newTrainingNotes();
  const r = await captureAssociation(env, notes, { id: 'f1', espn_athlete_id: '42' }, { espn_athlete_id: '42', association: { id: '9', name: 'G' }, source_url: 'https://espn/x' });
  assert.equal(r, null);
  assert.equal(notes.errors, 1);
});

test('no notes object (a caller outside the lane) means no capture', async () => {
  const calls = [];
  const env = fakeEnv({ action: 'first' }, calls);
  assert.equal(await captureAssociation(env, undefined, { id: 'f1', espn_athlete_id: '42' }, { espn_athlete_id: '42' }), null);
  assert.equal(calls.length, 0);
});

const events = [
  { id: 'e_old', event_date: '2024-01-01', event_series: 'ufc' },
  { id: 'e_recent', event_date: '2026-06-01', event_series: 'ufc' },
  { id: 'e_next', event_date: '2026-10-03', event_series: 'ufc' },
  { id: 'e_far', event_date: '2026-12-12', event_series: 'ufc' },
  { id: 'e_dwcs', event_date: '2026-08-01', event_series: 'contender_series' },
];
const bouts = [
  { id: 'b1', event_id: 'e_old', fighter_a_id: 'old', fighter_b_id: 'x', status: 'final' },
  { id: 'b2', event_id: 'e_recent', fighter_a_id: 'recent', fighter_b_id: 'booked', status: 'final' },
  { id: 'b3', event_id: 'e_next', fighter_a_id: 'booked', fighter_b_id: 'debut', status: 'announced' },
  { id: 'b4', event_id: 'e_far', fighter_a_id: 'far', fighter_b_id: 'gone', status: 'cancelled' },
  { id: 'b5', event_id: 'e_dwcs', fighter_a_id: 'dwcs', fighter_b_id: 'dwcs2', status: 'final' },
];
const resultsByBout = new Map([['b1', {}], ['b2', {}], ['b5', {}]]);

test('active roster = UFC bout in 18 months or booked; not is_active, not DWCS, not cancelled', () => {
  const r = activeRoster({ bouts, events, resultsByBout, today: '2026-09-26' });
  assert.deepEqual([...r.keys()].sort(), ['booked', 'debut', 'recent']);
  assert.deepEqual(r.get('booked'), { booked_on: '2026-10-03', last_fought_on: '2026-06-01' });
  assert.deepEqual(r.get('debut'), { booked_on: '2026-10-03', last_fought_on: null });
});

test('sweep plan: booked soon first, then never observed, then stalest; fresh and already-read skipped', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const roster = new Map([
    ['booked', { booked_on: '2026-10-03' }], ['debut', { booked_on: '2026-10-03' }],
    ['stale', { booked_on: null }], ['never', { booked_on: null }], ['fresh', { booked_on: null }],
    ['read', { booked_on: null }], ['noespn', { booked_on: null }],
  ]);
  const fighters = new Map([...roster.keys()].map((k) => [k, { id: k, espn_athlete_id: k === 'noespn' ? null : `e_${k}` }]));
  const lastConfirmed = new Map([
    ['booked', '2026-09-23T00:00:00Z'],   // 3.5 days: due under the 2-day booked recheck
    ['debut', '2026-09-26T00:00:00Z'],    // fresh even for booked
    ['stale', '2026-08-01T00:00:00Z'],
    ['fresh', '2026-09-20T00:00:00Z'],    // 6 days < 14
  ]);
  const plan = planCampSweep({ roster, fighters, lastConfirmed, fetched: new Set(['read']), now, today: '2026-09-26' });
  assert.deepEqual(plan.ids, ['booked', 'never', 'stale']);
  const capped = planCampSweep({ roster, fighters, lastConfirmed, fetched: new Set(), now, today: '2026-09-26', cfg: { ...CAMP_SWEEP, max: 1 } });
  assert.deepEqual(capped.ids, ['booked']);
  assert.equal(capped.due, 4);
});
