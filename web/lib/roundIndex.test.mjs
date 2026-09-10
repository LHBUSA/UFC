/* /round-by-round read contract. Run: npm run test:round-index
 *
 * The page used to walk five tables through a pager that returned whatever
 * prefix it had when a page failed, so a partial archive rendered as the whole
 * one. These tests pin the replacement: exactly one request, and anything less
 * than the full contract is an error, never a smaller archive. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./market.test-hooks.mjs', import.meta.url);   // stubs `server-only` for the test run only
process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key-not-a-real-credential';

const R = await import('./roundIndex.ts');

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const bout = (extra = {}) => ({
  bout_id: uuid(), event_id: uuid(), event_name: 'UFC 999: Alpha vs. Bravo', event_date: '2026-09-05',
  fighter_a_id: uuid(), fighter_a_name: 'Alpha', fighter_a_espn_athlete_id: null, fighter_a_ufcstats_id: 'aaaaaaaaaaaaaaaa',
  fighter_b_id: uuid(), fighter_b_name: 'Bravo', fighter_b_espn_athlete_id: null, fighter_b_ufcstats_id: 'bbbbbbbbbbbbbbbb',
  weight_class: 'LIGHTWEIGHT', is_womens: false, is_title: false, bout_order: 1, scheduled_rounds: 3,
  method: 'KO_TKO', finish_round: 2, winner_id: null, rounds_observed: 2, both_corners: true, is_tournament: false, ...extra,
});
const page = (over = {}) => {
  const recent = Array.from({ length: 12 }, () => bout());
  /* A scheduled five-rounder that ended in round 2: it IS a five-round fight. */
  const five = [bout({ scheduled_rounds: 5, rounds_observed: 2, is_title: true }), bout({ scheduled_rounds: 5, rounds_observed: 5 })];
  return {
    contract: 'ufc_round_index_page.v1', generated_at: '2026-09-10T16:00:00Z',
    totals: { eligible: 20, both_corners: 20, by_rounds_observed: { 2: 15, 5: 5 }, by_scheduled_rounds: { 3: 18, 5: 2 }, scheduled_five_round: 2 },
    provenance: { round_rows: 90, last_captured_at: '2026-09-08T09:49:37Z', source: 'ufc_bout_round_stats via ufc_round_index' },
    shelves: { recent, 'five-round': five, title: [five[0]], tournament: [], historic: recent.slice(0, 3) },
    ...over,
  };
};

test('a complete payload parses; the five-round shelf is scheduled distance', () => {
  const idx = R.parseRoundIndexPage(page());
  assert.equal(idx.provenance.requests, 1);
  const five = idx.sections.find((s) => s.key === 'five-round');
  assert.equal(five.bouts.length, 2);
  assert.ok(five.bouts.some((b) => b.scheduledRounds === 5 && b.roundsCovered === 2), 'a five-rounder that ended in R2 is on the shelf');
  assert.equal(idx.sections.find((s) => s.key === 'tournament'), undefined, 'an empty shelf is omitted, not shown empty');
  assert.equal(idx.totals.byRoundsObserved[5], 5);
});

test('a short recent shelf is a failure, not a quiet week', () => {
  const p = page(); p.shelves.recent = p.shelves.recent.slice(0, 5);
  assert.throws(() => R.parseRoundIndexPage(p), R.RoundIndexUnavailable);
});

test('distributions that do not sum to the eligible total are rejected (partial aggregation)', () => {
  const p = page(); p.totals.by_rounds_observed = { 2: 15 };
  assert.throws(() => R.parseRoundIndexPage(p), /distribution sums/);
});

test('a bout missing a field is rejected rather than rendered', () => {
  const p = page(); p.shelves.recent[3] = { ...p.shelves.recent[3], fighter_b_name: null };
  assert.throws(() => R.parseRoundIndexPage(p), /incomplete bout/);
});

test('a five-round shelf holding a three-round bout is rejected', () => {
  const p = page(); p.shelves['five-round'][1] = bout({ scheduled_rounds: 3, rounds_observed: 5 });
  assert.throws(() => R.parseRoundIndexPage(p), /not scheduled for five/);
});

test('wrong or missing contract is rejected', () => {
  assert.throws(() => R.parseRoundIndexPage({ ...page(), contract: 'v0' }), /unexpected contract/);
  assert.throws(() => R.parseRoundIndexPage(null), R.RoundIndexUnavailable);
});

test('getRoundIndex makes exactly one request and fails loudly on any failure', async () => {
  const real = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push(String(url)); return new Response(JSON.stringify(page()), { status: 200 }); };
    const idx = await R.getRoundIndex();
    assert.equal(calls.length, 1, 'one request for the whole page');
    assert.match(calls[0], /\/rest\/v1\/rpc\/ufc_round_index_page$/);
    assert.equal(idx.sections[0].bouts.length, 12);

    globalThis.fetch = async () => new Response('upstream timeout', { status: 504 });
    await assert.rejects(R.getRoundIndex(), /HTTP 504/);

    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(R.getRoundIndex(), /transport/);

    globalThis.fetch = async () => new Response('{"contract":"ufc_round_index_page.v1","totals":', { status: 200 });
    await assert.rejects(R.getRoundIndex(), /not JSON/);
  } finally {
    globalThis.fetch = real;
  }
});

test('coverage lookups never exceed their chunk and skip failed chunks rather than guessing', async () => {
  const real = globalThis.fetch;
  try {
    const ids = Array.from({ length: 130 }, () => uuid());
    const seen = [];
    globalThis.fetch = async (url) => {
      const u = String(url); seen.push(u);
      const n = (u.match(/in\.\(([^)]*)\)/)[1].split(',')).length;
      assert.ok(n <= 60, 'chunk of at most 60 ids');
      if (seen.length === 2) return new Response('nope', { status: 500 });
      const got = u.match(/in\.\(([^)]*)\)/)[1].split(',');
      return new Response(JSON.stringify(got.map((id) => ({ bout_id: id, rounds_observed: 3, both_corners: true }))), { status: 200 });
    };
    const cov = await R.getRoundCoverageFor(ids);
    assert.equal(seen.length, 3);
    assert.equal(cov.size, 130 - 60, 'the failed chunk contributes nothing, not zeros');
  } finally {
    globalThis.fetch = real;
  }
});
