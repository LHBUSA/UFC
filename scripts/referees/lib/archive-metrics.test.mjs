/**
 * Proves the 500-row truncation cannot come back.
 *
 *   node --test scripts/referees/lib/archive-metrics.test.mjs
 *
 * The original query carried `limit=500` as the whole request rather than a
 * page size, so Herb Dean's packet described 203 of his 1,351 assignments and
 * said nothing about the other 1,148. The distribution read as his record.
 *
 * The fixture below is a synthetic referee with 1,351 assignments — deliberately
 * past the boundary, and deliberately the real number that was wrong — served
 * through a fake paginated source that honours limit and offset exactly as
 * PostgREST does. If pagination regresses, the count comes back 500 (or 203)
 * and these fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRefereeBouts,
  computeArchiveMetrics,
  archiveMetricsFor,
  DEFAULT_PAGE_SIZE,
} from './archive-metrics.mjs';

/** A referee with `total` assignments, served page by page. */
function fixture(total, { methodOf = (i) => (i % 3 === 0 ? 'KO_TKO' : i % 3 === 1 ? 'SUB' : 'DEC_U') } = {}) {
  const rows = Array.from({ length: total }, (_, i) => ({
    bout_id: `b${String(i).padStart(5, '0')}`,
    method: methodOf(i),
    round: (i % 3) + 1,
    time_sec: 60 + (i % 200),
    is_title: i % 97 === 0,
    card_position: i % 11 === 0 ? 'main' : 'prelim',
    event_date: `20${10 + (i % 15)}-01-01`,
    event_name: `Event ${i}`,
    fighter_a_name: `A${i}`,
    fighter_b_name: `B${i}`,
    weight_class: 'LIGHTWEIGHT',
  }));

  const calls = [];
  const fetchPage = async (pathAndQuery) => {
    calls.push(pathAndQuery);
    const limit = Number(/[?&]limit=(\d+)/.exec(pathAndQuery)?.[1] ?? total);
    const offset = Number(/[?&]offset=(\d+)/.exec(pathAndQuery)?.[1] ?? 0);
    return rows.slice(offset, offset + limit);
  };
  return { rows, fetchPage, calls };
}

test('a referee with more than 500 assignments is not truncated', async () => {
  const { fetchPage, calls } = fixture(1351);
  const bouts = await fetchRefereeBouts('herb-dean', fetchPage);

  assert.equal(bouts.length, 1351, 'every assignment must be fetched, not the first page of them');
  assert.notEqual(bouts.length, DEFAULT_PAGE_SIZE, 'stopping at the page size is the exact bug this guards');
  assert.notEqual(bouts.length, 203, 'and 203 was what the shipped packet claimed');
  assert.equal(calls.length, 3, '1351 rows at 500 per page is three requests');
});

test('paging is deterministic and loses nothing at a page boundary', async () => {
  /* 1000 is the nastiest case: the last page is exactly full, so a reader that
   * stops on "a full page means done" would be right by accident at 500 and
   * wrong here. */
  for (const total of [499, 500, 501, 1000, 1001]) {
    const { rows, fetchPage } = fixture(total);
    const got = await fetchRefereeBouts('x', fetchPage);
    assert.equal(got.length, total, `total ${total} should come back whole`);
    assert.deepEqual(got.map((b) => b.bout_id), rows.map((b) => b.bout_id), `total ${total} should keep order and lose nothing`);
    assert.equal(new Set(got.map((b) => b.bout_id)).size, total, `total ${total} must not repeat a row`);
  }
});

test('every request asks for an explicit ordered page', async () => {
  const { fetchPage, calls } = fixture(1200);
  await fetchRefereeBouts('x', fetchPage);
  for (const c of calls) {
    assert.match(c, /order=event_date\.desc\.nullslast,bout_id\.asc/, 'ordering must be explicit, or offsets mean nothing');
    assert.match(c, /limit=500/);
    assert.match(c, /offset=\d+/);
  }
});

test('the distribution covers the complete sample', async () => {
  const { fetchPage } = fixture(1351);
  const bouts = await fetchRefereeBouts('herb-dean', fetchPage);
  const m = computeArchiveMetrics(bouts);

  assert.equal(m.sample_bouts, 1351);
  const methodTotal = Object.values(m.method_distribution).reduce((a, b) => a + b, 0);
  const roundTotal = Object.values(m.round_distribution).reduce((a, b) => a + b, 0);
  assert.equal(methodTotal, 1351, 'the method distribution must add up to the whole sample');
  assert.equal(roundTotal, 1351, 'and so must the round distribution');
});

test('a count that disagrees with the directory writes nothing', async () => {
  /* The fail-closed rule. A short read, a half-loaded table or a referee whose
   * bouts moved mid-run all look like this, and none of them may produce a
   * packet. */
  const { fetchPage } = fixture(669);
  await assert.rejects(
    () => archiveMetricsFor('john-mccarthy', 670, fetchPage),
    /fetched 669 bout rows but the directory says 670/,
  );
  await assert.rejects(
    () => archiveMetricsFor('john-mccarthy', undefined, fetchPage),
    /no directory bout count/,
    'an absent expectation is not permission to skip the check',
  );

  const ok = await archiveMetricsFor('john-mccarthy', 669, fetchPage);
  assert.equal(ok.sample_bouts, 669, 'and it succeeds when they agree');
});

test('a source that never returns a short page is refused rather than looped', async () => {
  const endless = async () => Array.from({ length: 500 }, (_, i) => ({ bout_id: `x${i}`, method: 'DEC_U' }));
  await assert.rejects(() => fetchRefereeBouts('x', endless, { maxPages: 4 }), /refusing to loop/);
});

test('no assignments is null, not an empty distribution', async () => {
  const { fetchPage } = fixture(0);
  assert.equal(computeArchiveMetrics(await fetchRefereeBouts('x', fetchPage)), null);
});

test('the main-event count carries the size of the subset it counts', async () => {
  /* card_position is only recorded for recent events. Once the sample is the
   * whole career, a bare main-event count sits next to a much larger bout count
   * and reads as a rate, so the metrics have to say what the count covers. */
  const { fetchPage } = fixture(1351, {});
  const bouts = await fetchRefereeBouts('herb-dean', fetchPage);
  const unlabelled = bouts.map((b, i) => (i < 1149 ? { ...b, card_position: null } : b));

  const m = computeArchiveMetrics(unlabelled);
  assert.equal(m.sample_bouts, 1351);
  assert.equal(m.card_position_sample, 202, 'only the labelled rows count toward the subset');
  assert.ok(m.main_event_assignments <= m.card_position_sample, 'a main event must be one of the labelled rows');

  const all = computeArchiveMetrics(bouts);
  assert.equal(all.card_position_sample, 1351, 'with every row labelled the subset is the sample');
});
