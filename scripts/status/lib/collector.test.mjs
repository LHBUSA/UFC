/* Collector write path and counters. Run: node --test scripts/status/lib/collector.test.mjs
 *
 * The property under test is that the counters describe the DATABASE, not the
 * client's intentions. A collector running every ten minutes over a six-hour
 * overlapping window re-offers the same stories about thirty-six times each;
 * if a no-op counts as a write, the one number anyone checks to answer "is
 * this working?" says yes forever while the table sits still.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { insertCountingRows } from '../collect_status_events.mjs';

/**
 * A PostgREST stand-in with a real unique index on fingerprint, honouring
 * `resolution=ignore-duplicates` + `return=representation` the way PostgREST
 * does: the response contains a row per row actually INSERTED, and nothing for
 * the ones it ignored.
 */
function fakeDb({ rejectFingerprints = new Set(), failBatch = false } = {}) {
  const table = new Map();
  const requests = [];
  const sb = {
    async insert(name, rows, opts) {
      requests.push({ name, count: rows.length, opts });
      assert.equal(opts.onConflict, 'fingerprint', 'the upsert must name the real unique index');
      assert.equal(opts.ignoreDuplicates, true);
      assert.equal(opts.returning, true, 'counting inserted rows requires representation');
      if (failBatch && rows.length > 1) throw new Error('PostgREST 400: batch blew up');
      const inserted = [];
      for (const r of rows) {
        if (rejectFingerprints.has(r.fingerprint)) {
          throw new Error('new row for relation violates check constraint "status_clinical_requires_quote"');
        }
        if (table.has(r.fingerprint)) continue;   // ignore-duplicates: no row returned
        table.set(r.fingerprint, r);
        inserted.push(r);
      }
      return inserted;
    },
  };
  return { sb, table, requests };
}

const row = (fp) => ({ fingerprint: fp, fighter_id: 'f1', status_type: 'withdrawal', source_url: 'https://x.invalid/a' });

/* ================= the replay property ================= */

test('replaying an identical item reports inserted=0, duplicate_noop=1, and changes nothing', () => {
  const { sb, table } = fakeDb();
  const one = [row('fp-1')];

  return (async () => {
    const first = await insertCountingRows(sb, one);
    assert.deepEqual(first.counters, { offered: 1, inserted: 1, duplicate_noop: 0, rejected: 0 });
    assert.equal(table.size, 1);

    const replay = await insertCountingRows(sb, one);
    assert.equal(replay.counters.inserted, 0, 'a duplicate is not a write');
    assert.equal(replay.counters.duplicate_noop, 1);
    assert.equal(replay.counters.offered, 1);
    assert.equal(table.size, 1, 'and table cardinality is unchanged');
  })();
});

test('thirty-six replays of the same window still report zero inserts', async () => {
  /* Ten-minute cadence over a six-hour window. The old counter would have
   * claimed 36 writes for one story. */
  const { sb, table } = fakeDb();
  const window = [row('fp-a'), row('fp-b'), row('fp-c')];
  await insertCountingRows(sb, window);
  assert.equal(table.size, 3);

  let claimedWrites = 0;
  for (let pass = 0; pass < 35; pass += 1) {
    const r = await insertCountingRows(sb, window);
    claimedWrites += r.counters.inserted;
  }
  assert.equal(claimedWrites, 0, '35 further passes inserted nothing and must say so');
  assert.equal(table.size, 3, 'cardinality unchanged across every pass');
});

test('a window that is mostly known reports only the genuinely new row', async () => {
  const { sb, table } = fakeDb();
  await insertCountingRows(sb, [row('fp-1'), row('fp-2')]);

  const r = await insertCountingRows(sb, [row('fp-1'), row('fp-2'), row('fp-3')]);
  assert.deepEqual(r.counters, { offered: 3, inserted: 1, duplicate_noop: 2, rejected: 0 });
  assert.equal(table.size, 3);
});

test('the counters always add up', async () => {
  const { sb } = fakeDb({ rejectFingerprints: new Set(['fp-bad']), failBatch: true });
  const r = await insertCountingRows(sb, [row('fp-1'), row('fp-bad'), row('fp-2')]);
  const { offered, inserted, duplicate_noop: dup, rejected } = r.counters;
  assert.equal(inserted + dup + rejected, offered, 'offered = inserted + duplicate_noop + rejected');
});

/* ================= fail-safety ================= */

test('one malformed row costs one row, not the whole pass', async () => {
  /* A CHECK violation — a clinical claim with no quote — would otherwise take
   * down a batch carrying a genuine main-event withdrawal. */
  const { sb, table } = fakeDb({ rejectFingerprints: new Set(['fp-bad']), failBatch: true });
  const r = await insertCountingRows(sb, [row('fp-good-1'), row('fp-bad'), row('fp-good-2')]);

  assert.equal(r.counters.inserted, 2, 'the healthy rows still land');
  assert.equal(r.counters.rejected, 1);
  assert.equal(table.size, 2);
  assert.equal(r.rejected[0].reason, 'insert_rejected');
  assert.match(r.rejected[0].detail, /status_clinical_requires_quote/, 'and the reason is kept, not swallowed');
});

test('a batch is one round trip when nothing is wrong', async () => {
  const { sb, requests } = fakeDb();
  await insertCountingRows(sb, [row('a'), row('b'), row('c')]);
  assert.equal(requests.length, 1, 'a ten-minute job should not make one request per story');
  assert.equal(requests[0].count, 3);
});

test('nothing to write makes no request at all', async () => {
  const { sb, requests } = fakeDb();
  const r = await insertCountingRows(sb, []);
  assert.deepEqual(r.counters, { offered: 0, inserted: 0, duplicate_noop: 0, rejected: 0 });
  assert.equal(requests.length, 0);
});

test('a unique violation that escapes ignore-duplicates is a no-op, not a loss', async () => {
  /* Two passes racing on the same story: the loser gets 23505. The row exists
   * either way, so it is a duplicate — counting it as rejected would make a
   * healthy race look like data loss. */
  const sb = {
    async insert(_name, rows) {
      if (rows.length > 1) throw new Error('batch');
      throw new Error('duplicate key value violates unique constraint "ufc_fighter_status_events_fingerprint_key"');
    },
  };
  const r = await insertCountingRows(sb, [row('fp-1'), row('fp-2')]);
  assert.equal(r.counters.duplicate_noop, 2);
  assert.equal(r.counters.rejected, 0);
});
