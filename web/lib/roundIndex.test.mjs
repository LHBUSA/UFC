/* /round-by-round read model. Run: npm run test:round-index
 *
 * The claim this page makes is "these are the fights with round data, and
 * this is how many there are". The old read path could make that claim on the
 * strength of a failed read: a PostgREST page that errored mid-walk came back
 * as a shorter array and rendered as a complete, smaller archive. These tests
 * pin the replacement rule: a document is accepted whole or not at all, and
 * every failure mode lands on "unavailable", never on a smaller "ok".
 * See market.test-hooks.mjs for why `server-only` needs stubbing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./market.test-hooks.mjs', import.meta.url);
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const { parseRoundIndex, getRoundIndex, buildSections } = await import('./roundIndex.ts');

const card = (over = {}) => ({
  bout_id: 'b1', event_id: 'e1', event_name: 'UFC Fight Night: Hooker vs. Parnasse', event_date: '2026-09-05',
  bout_order: 14, weight_class: 'LIGHTWEIGHT', is_womens: false, is_title: false, scheduled_rounds: 5,
  method: 'KO_TKO', finish_round: 1, winner_id: 'f2', rounds_covered: 1, both_corners: true,
  fighter_a: { id: 'f1', name: 'Dan Hooker' }, fighter_b: { id: 'f2', name: 'Salahdine Parnasse' }, ...over,
});
const doc = (over = {}) => ({
  contract: 'ufc_round_index/v1', generated_at: '2026-09-10T16:00:00Z',
  freshness: { last_round_capture_at: '2026-09-10T16:06:56Z', round_rows: 41930 },
  totals: { eligible: 3, both_corners: 3, by_observed_rounds: { 1: 1, 3: 1, 5: 1 }, first_event_date: '1994-03-11',
    last_event_date: '2026-09-05', scheduled_five_round: 2, five_rounds_recorded: 1 },
  shelves: { recent: [card()], scheduled_five_round: [card()], title: [], tournament: [], historic: [card()] },
  ...over,
});

test('a whole document is accepted', () => {
  const r = parseRoundIndex(doc());
  assert.equal(r.status, 'ok');
  assert.equal(r.totals.eligible, 3);
  assert.equal(r.shelves.recent[0].fighterA.name, 'Dan Hooker');
});

test('five-round shelf is scheduled length: a five-round fight that ended in R1 is on it', () => {
  const r = parseRoundIndex(doc());
  const five = buildSections(r).find((s) => s.key === 'five-round');
  assert.ok(five, 'five-round section present');
  assert.equal(five.bouts[0].scheduledRounds, 5);
  assert.equal(five.bouts[0].roundsCovered, 1);
  assert.match(five.blurb, /scheduled for five rounds/);
});

test('empty shelves are dropped, never shown empty', () => {
  const keys = buildSections(parseRoundIndex(doc())).map((s) => s.key);
  assert.deepEqual(keys, ['recent', 'five-round', 'historic']);
});

test('a distribution that does not account for every eligible bout is unavailable, not ok', () => {
  const d = doc(); d.totals.by_observed_rounds = { 1: 1, 3: 1 };  // one bout silently missing
  assert.equal(parseRoundIndex(d).status, 'unavailable');
});

test('a missing shelf, a malformed card, missing totals or a wrong contract are unavailable', () => {
  const noShelf = doc(); delete noShelf.shelves.title;
  assert.equal(parseRoundIndex(noShelf).status, 'unavailable');
  const badCard = doc(); badCard.shelves.recent = [{ ...card(), fighter_b: null }];
  assert.equal(parseRoundIndex(badCard).status, 'unavailable');
  const noTotals = doc(); delete noTotals.totals.eligible;
  assert.equal(parseRoundIndex(noTotals).status, 'unavailable');
  assert.equal(parseRoundIndex(doc({ contract: 'something-else' })).status, 'unavailable');
  assert.equal(parseRoundIndex(null).status, 'unavailable');
  assert.equal(buildSections(parseRoundIndex(null)).length, 0);
});

test('HTTP failure, transport failure and a truncated body are unavailable, not a smaller archive', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"message":"boom"}', { status: 503 });
    assert.deepEqual(await getRoundIndex(), { status: 'unavailable', reason: 'HTTP 503' });
    globalThis.fetch = async () => { throw new Error('socket hang up'); };
    assert.equal((await getRoundIndex()).status, 'unavailable');
    globalThis.fetch = async () => new Response('{"contract":"ufc_round_index/v1","totals":{"eligi', { status: 200 });
    assert.equal((await getRoundIndex()).status, 'unavailable');
  } finally { globalThis.fetch = real; }
});

test('the whole page is ONE backend request', async () => {
  const real = globalThis.fetch; let calls = 0; let url = '';
  try {
    globalThis.fetch = async (u) => { calls += 1; url = String(u); return new Response(JSON.stringify(doc()), { status: 200 }); };
    const r = await getRoundIndex();
    assert.equal(r.status, 'ok');
    assert.equal(calls, 1);
    assert.match(url, /\/rest\/v1\/rpc\/ufc_round_index$/);
  } finally { globalThis.fetch = real; }
});
