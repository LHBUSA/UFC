/* The pass contract, end to end, against an in-memory PostgREST double.
 *
 * These are the tests that matter for production safety. Everything here is
 * about what happens when the world misbehaves: UFC.com times out, returns a
 * 502, gets redesigned, publishes a broken row, moves a start time, changes a
 * carrier, or the scheduler fires the same pass twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runBroadcastPass, TABLE, CHANGES_TABLE, WORKER } from './pass_core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTING = readFileSync(join(HERE, '..', 'fixtures', 'events_listing.html'), 'utf8');
const NOW = Date.parse('2026-09-10T12:00:00Z'); // two days before the Noche card

/* ------------------------------------------------------------ the doubles */

/** Minimal in-memory stand-in for the BroadcastPostgrest surface we use. */
class FakeSb {
  constructor(seed = {}) {
    this.tables = {
      [TABLE]: seed[TABLE] ?? [],
      [CHANGES_TABLE]: seed[CHANGES_TABLE] ?? [],
      ufc_ingest_runs: seed.ufc_ingest_runs ?? [],
      ufc_events: seed.ufc_events ?? [],
    };
    this.writes = [];
  }

  async select(table, query = '') {
    const rows = [...(this.tables[table] ?? [])];
    /* Only the filters this pass actually issues. */
    const worker = /worker=eq\.([^&]+)/.exec(query);
    const statusEq = /status=eq\.([^&]+)/.exec(query);
    const statusIn = /status=in\.\(([^)]+)\)/.exec(query);
    let out = rows;
    if (worker) out = out.filter((r) => r.worker === worker[1]);
    if (statusEq) out = out.filter((r) => r.status === statusEq[1]);
    if (statusIn) out = out.filter((r) => statusIn[1].split(',').includes(r.status));
    const gte = /event_date=gte\.([^&]+)/.exec(query);
    const lte = /event_date=lte\.([^&]+)/.exec(query);
    if (gte) out = out.filter((r) => r.event_date >= gte[1]);
    if (lte) out = out.filter((r) => r.event_date <= lte[1]);
    if (/order=started_at\.desc/.test(query)) out = [...out].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    const limit = /limit=(\d+)/.exec(query);
    if (limit) out = out.slice(0, Number(limit[1]));
    return out.map((r) => ({ ...r }));
  }

  async insert(table, rows, opts = {}) {
    this.writes.push({ op: 'insert', table, n: rows.length, opts });
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
    return null;
  }

  async upsert(table, rows, { onConflict } = {}) {
    assert.ok(onConflict, 'upsert must always name its conflict target');
    this.writes.push({ op: 'upsert', table, n: rows.length, onConflict });
    const key = onConflict;
    const cur = this.tables[table] ?? [];
    for (const row of rows) {
      const i = cur.findIndex((r) => r[key] === row[key]);
      if (i === -1) cur.push({ ...row }); else cur[i] = { ...cur[i], ...row };
    }
    this.tables[table] = cur;
    return null;
  }

  async patch(table, filter, patch) {
    this.writes.push({ op: 'patch', table, filter, patch });
    const inList = /ufc_slug=in\.\(([^)]*)\)/.exec(filter);
    const eq = /ufc_slug=eq\.([^&]+)/.exec(filter);
    const slugs = inList
      ? inList[1].split(',').map((s) => s.replace(/^"|"$/g, ''))
      : eq ? [decodeURIComponent(eq[1])] : [];
    for (const r of this.tables[table] ?? []) {
      if (slugs.includes(r.ufc_slug)) Object.assign(r, patch);
    }
    return null;
  }

  rows() { return this.tables[TABLE]; }
  row(slug) { return this.tables[TABLE].find((r) => r.ufc_slug === slug) ?? null; }
  changes() { return this.tables[CHANGES_TABLE]; }
  runs() { return this.tables.ufc_ingest_runs.filter((r) => r.worker === WORKER); }
}

/** A fetch double. `listing` may be a string, an Error, or a {status} object. */
function fakeFetch({ listing = LISTING, detail = '<title>Noche UFC: Silva vs Delgado | UFC</title>', calls = [] } = {}) {
  return async (url, opts) => {
    calls.push({ url, timeoutMs: opts?.timeoutMs });
    const body = url.includes('/events') ? listing : detail;
    if (body instanceof Error) throw body;
    if (body && typeof body === 'object' && 'status' in body) {
      return { ok: false, status: body.status, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => String(body) };
  };
}

const silent = { error() {}, warn() {}, log() {} };
const run = (sb, opts = {}) => runBroadcastPass({ sb, log: silent }, { now: NOW, fetchImpl: fakeFetch(), write: true, force: true, ...opts });

/* --------------------------------------------------------------- the tests */

test('a cold start stores every recognised card and logs one change row each', async () => {
  const sb = new FakeSb();
  const r = await run(sb);
  assert.equal(r.status, 'ok');
  assert.equal(r.counters.recognised, 4);
  assert.equal(r.counters.inserted, 4);
  assert.equal(r.counters.changed, 0);
  assert.equal(sb.rows().length, 4);
  assert.equal(sb.changes().length, 4);
  assert.ok(sb.changes().every((c) => c.kind === 'new'));

  const noche = sb.row('ufc-fight-night-september-12-2026');
  assert.equal(noche.main_card_start_utc, '2026-09-12T21:00:00.000Z');
  assert.equal(noche.event_name, 'Noche UFC: Silva vs Delgado', 'branded name came from the detail fetch');
  assert.equal(noche.verified_at, noche.last_changed_at, 'a new row was verified and changed at the same instant');
  assert.ok(noche.content_hash);
});

test('re-running against identical upstream content is idempotent', async () => {
  const sb = new FakeSb();
  await run(sb);
  const before = sb.rows().map((r) => ({ ...r }));
  const changeCount = sb.changes().length;

  const later = NOW + 90 * 60000;
  const r2 = await runBroadcastPass({ sb, log: silent }, { now: later, fetchImpl: fakeFetch(), write: true, force: true });

  assert.equal(r2.counters.unchanged, 4);
  assert.equal(r2.counters.changed, 0);
  assert.equal(r2.counters.inserted, 0);
  assert.equal(sb.rows().length, 4, 'no duplicate rows');
  assert.equal(sb.changes().length, changeCount, 'no new change rows');

  for (const row of sb.rows()) {
    const prev = before.find((b) => b.ufc_slug === row.ufc_slug);
    assert.equal(row.last_changed_at, prev.last_changed_at, 'last_changed_at must not move when nothing changed');
    assert.equal(row.content_hash, prev.content_hash);
    assert.equal(row.verified_at, new Date(later).toISOString(), 'verified_at must move on every successful verification');
  }
});

test('a third identical run still costs exactly one bulk verified_at patch', async () => {
  const sb = new FakeSb();
  await run(sb);
  sb.writes.length = 0;
  await runBroadcastPass({ sb, log: silent }, { now: NOW + 3600e3, fetchImpl: fakeFetch(), write: true, force: true });
  const patches = sb.writes.filter((w) => w.op === 'patch' && w.table === TABLE);
  const upserts = sb.writes.filter((w) => w.op === 'upsert');
  assert.equal(patches.length, 1, 'one PATCH for all four unchanged rows, not four');
  assert.equal(upserts.length, 0, 'nothing to upsert');
});

test('a source start-time change moves last_changed_at and records a typed change row', async () => {
  const sb = new FakeSb();
  await run(sb);
  const before = sb.row('ufc-332');

  /* UFC.com moves the UFC 332 main card an hour later. The fixture's epoch
   * 1791072000 becomes 1791075600. */
  const moved = LISTING.replaceAll('1791072000', '1791075600');
  const later = NOW + 6 * 3600e3;
  const r = await runBroadcastPass({ sb, log: silent }, { now: later, fetchImpl: fakeFetch({ listing: moved }), write: true, force: true });

  assert.equal(r.counters.changed, 1);
  assert.equal(r.counters.unchanged, 3, 'the other three cards were untouched');
  const after = sb.row('ufc-332');
  assert.equal(after.main_card_start_utc, '2026-10-04T01:00:00.000Z');
  assert.equal(after.last_changed_at, new Date(later).toISOString());
  assert.notEqual(after.last_changed_at, before.last_changed_at);
  assert.notEqual(after.content_hash, before.content_hash);
  assert.equal(after.first_seen_at, before.first_seen_at, 'first_seen_at is never rewritten');

  const logged = sb.changes().filter((c) => c.ufc_slug === 'ufc-332' && c.kind === 'time');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].field, 'main_card_start_utc');
  assert.equal(logged[0].before_value, '2026-10-04T00:00:00.000Z');
});

test('a source broadcaster change is recorded as a broadcast change', async () => {
  const sb = new FakeSb();
  await run(sb);
  const dropped = LISTING.replace(/<a href="https:\/\/www\.cbs\.com[^"]*" class="e-button--black-outlined">[^<]*<\/a>/, '');
  const later = NOW + 6 * 3600e3;
  const r = await runBroadcastPass({ sb, log: silent }, { now: later, fetchImpl: fakeFetch({ listing: dropped }), write: true, force: true });

  assert.equal(r.counters.changed, 1);
  const after = sb.row('ufc-332');
  assert.equal(after.broadcasts.find((b) => b.provider === 'CBS'), undefined);
  assert.equal(after.broadcasts.length, 2, 'the other two carriers survive');
  assert.ok(sb.changes().some((c) => c.ufc_slug === 'ufc-332' && c.kind === 'broadcast'));
});

test('an upstream TIMEOUT preserves every stored row and writes no schedule data', async () => {
  const sb = new FakeSb();
  await run(sb);
  const before = JSON.stringify(sb.rows());
  sb.writes.length = 0;

  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const r = await runBroadcastPass({ sb, log: silent }, {
    now: NOW + 6 * 3600e3, fetchImpl: fakeFetch({ listing: timeout }), write: true, force: true,
  });

  assert.equal(r.status, 'upstream_failed');
  assert.equal(r.diagnostics.error, 'timeout');
  assert.equal(r.preserved_rows, 4);
  assert.equal(JSON.stringify(sb.rows()), before, 'not one field of good data moved');
  assert.equal(sb.writes.filter((w) => w.table === TABLE).length, 0, 'no write touched the schedule table');
  assert.equal(sb.runs().at(-1).status, 'failed', 'but the failure IS recorded');
});

test('an upstream NON-200 preserves every stored row', async () => {
  const sb = new FakeSb();
  await run(sb);
  const before = JSON.stringify(sb.rows());

  const r = await runBroadcastPass({ sb, log: silent }, {
    now: NOW + 6 * 3600e3, fetchImpl: fakeFetch({ listing: { status: 503 } }), write: true, force: true,
  });

  assert.equal(r.status, 'upstream_failed');
  assert.equal(r.diagnostics.http_status, 503);
  assert.equal(r.diagnostics.error, 'HTTP 503');
  assert.equal(JSON.stringify(sb.rows()), before);
});

test('UNEXPECTED MARKUP fails closed: the schedule survives a redesign', async () => {
  const sb = new FakeSb();
  await run(sb);
  const before = JSON.stringify(sb.rows());

  const r = await runBroadcastPass({ sb, log: silent }, {
    now: NOW + 6 * 3600e3,
    fetchImpl: fakeFetch({ listing: '<html><body><main class="brand-new-markup">Events</main></body></html>'.padEnd(900, ' ') }),
    write: true, force: true,
  });

  assert.equal(r.status, 'parser_unrecognised');
  assert.equal(JSON.stringify(sb.rows()), before, 'a CSS rename must never blank a start time');
  assert.equal(sb.runs().at(-1).status, 'failed');
});

test('a PARTIAL parse collapse is also refused, not written', async () => {
  const sb = new FakeSb();
  await run(sb);
  const before = JSON.stringify(sb.rows());

  /* Three upcoming cards were known; a page that now yields one is a broken
   * page, not a cancelled season. */
  const oneRow = LISTING.slice(0, LISTING.indexOf('<div class="l-listing__item', LISTING.indexOf('<div class="l-listing__item') + 10)) + '</div></div></body></html>';
  const r = await runBroadcastPass({ sb, log: silent }, {
    now: NOW + 6 * 3600e3, fetchImpl: fakeFetch({ listing: oneRow }), write: true, force: true,
  });

  assert.equal(r.status, 'parser_unrecognised');
  assert.match(r.diagnostics.error, /collapsed/);
  assert.equal(JSON.stringify(sb.rows()), before);
});

test('ONE MALFORMED ROW does not poison the rest of the schedule', async () => {
  const sb = new FakeSb();
  /* A listing row with an event link and a headline, but a start-time block of
   * garbage. It parses as an event with null times and must simply be stored
   * as such, while the other three are unaffected. */
  const junk = '<div class="l-listing__item views-row"><article class="c-card-event--result">'
    + '<h3 class="c-card-event--result__headline"><a href="/event/broken-card">Broken vs Card</a></h3>'
    + '<div class="c-card-event--result__date tz-change-data" data-main-card-timestamp="NOT-A-TIME" data-prelims-card-timestamp="" data-early-card-timestamp=""></div>'
    + '</article></div>';
  const withJunk = LISTING.replace('<h1>Events</h1>', `<h1>Events</h1>${junk}`);

  const r = await runBroadcastPass({ sb, log: silent }, { now: NOW, fetchImpl: fakeFetch({ listing: withJunk }), write: true, force: true });

  assert.equal(r.status, 'ok');
  assert.equal(sb.rows().length, 5, 'four good cards plus the degraded one');
  const broken = sb.row('broken-card');
  assert.equal(broken.main_card_start_utc, null, 'no time invented for it');
  assert.equal(broken.event_date, null);
  assert.deepEqual(broken.broadcasts, []);
  const good = sb.row('ufc-332');
  assert.equal(good.main_card_start_utc, '2026-10-04T00:00:00.000Z', 'the good card is untouched');
  assert.equal(good.broadcasts.length, 3);
});

test('a failed DETAIL fetch degrades to the headline and never fails the pass', async () => {
  const sb = new FakeSb();
  const fetchImpl = async (url, opts) => {
    if (url.includes('/events')) return { ok: true, status: 200, text: async () => LISTING };
    throw new Error('detail page down');
  };
  const r = await runBroadcastPass({ sb, log: silent }, { now: NOW, fetchImpl, write: true, force: true });
  assert.equal(r.status, 'ok');
  assert.equal(sb.row('ufc-332').event_name, 'Silva vs Wang', 'the listing headline is still a real UFC.com string');
});

test('the detail fetch is bounded and does not repeat for an already-branded row', async () => {
  const calls = [];
  const sb = new FakeSb();
  await runBroadcastPass({ sb, log: silent }, { now: NOW, fetchImpl: fakeFetch({ calls }), write: true, force: true });
  const firstDetail = calls.filter((c) => c.url.includes('/event/')).length;
  assert.ok(firstDetail > 0 && firstDetail <= 4, `capped detail fetches, got ${firstDetail}`);

  calls.length = 0;
  await runBroadcastPass({ sb, log: silent }, { now: NOW + 3600e3, fetchImpl: fakeFetch({ calls }), write: true, force: true });
  assert.equal(calls.filter((c) => c.url.includes('/event/')).length, 0, 'branded names are not re-fetched');
});

test('a DUPLICATE invocation with no elapsed time is gated off before any fetch', async () => {
  const calls = [];
  const sb = new FakeSb();
  await run(sb);

  /* The same wake again, one second later, without force. */
  const r = await runBroadcastPass({ sb, log: silent }, {
    now: NOW + 1000, fetchImpl: fakeFetch({ calls }), write: true, force: false,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'a duplicate invocation must not reach UFC.com at all');
  assert.equal(sb.rows().length, 4);
});

test('a dry run parses, diffs and reports — and writes nothing', async () => {
  const sb = new FakeSb();
  await run(sb);
  const before = JSON.stringify(sb.rows());
  const moved = LISTING.replaceAll('1791072000', '1791075600');
  sb.writes.length = 0;

  const r = await runBroadcastPass({ sb, log: silent }, {
    now: NOW + 6 * 3600e3, fetchImpl: fakeFetch({ listing: moved }), write: false, force: true,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.counters.changed, 1, 'the change is detected');
  assert.deepEqual(r.changed, [{ slug: 'ufc-332', fields: ['main_card_start_utc'] }]);
  assert.equal(sb.writes.length, 0, 'and nothing was persisted');
  assert.equal(JSON.stringify(sb.rows()), before);
});

test('a confident local event match is written; an ambiguous one is not', async () => {
  const sb = new FakeSb({
    ufc_events: [
      { id: 'local-332', name: 'UFC 332: Silva vs. Wang', event_date: '2026-10-03' },
      { id: 'dwcs-a', name: "Dana White's Contender Series", event_date: '2026-09-19' },
      { id: 'dwcs-b', name: "Dana White's Contender Series", event_date: '2026-09-19' },
    ],
  });
  await run(sb);
  assert.equal(sb.row('ufc-332').event_id, 'local-332');
  assert.equal(sb.row('ufc-332').match_status, 'matched');
  const ufc331 = sb.row('cryptocom-ufc-331');
  assert.equal(ufc331.event_id, null, 'two same-named events on the date: link nothing');
  assert.equal(ufc331.match_status, 'ambiguous');
  assert.equal(sb.row('ufc-fight-night-september-12-2026').match_status, 'unmatched');
});

test('the run ledger records the source URL, status, parser and counters', async () => {
  const sb = new FakeSb();
  await run(sb, { trigger: 'cron */30 * * * *' });
  const last = sb.runs().at(-1);
  assert.equal(last.worker, WORKER);
  assert.equal(last.status, 'success');
  assert.equal(last.notes.trigger, 'cron */30 * * * *');
  assert.equal(last.notes.diagnostics.source_url, 'https://www.ufc.com/events');
  assert.equal(last.notes.diagnostics.http_status, 200);
  assert.equal(last.notes.diagnostics.parser, 'ufc-events-listing-v1');
  assert.equal(last.notes.diagnostics.recognised, 4);
  assert.equal(last.notes.counters.inserted, 4);
  /* No secret may ever reach the ledger. */
  assert.ok(!JSON.stringify(last).match(/eyJ|service_role|Bearer /), 'no credentials in the ledger');
});

test('the fetch is given a timeout on every call', async () => {
  const calls = [];
  await runBroadcastPass({ sb: new FakeSb(), log: silent }, { now: NOW, fetchImpl: fakeFetch({ calls }), write: false, force: true });
  assert.ok(calls.length > 0);
  for (const c of calls) assert.ok(Number.isFinite(c.timeoutMs) && c.timeoutMs > 0, `no timeout on ${c.url}`);
});
