/* Normalization, fingerprinting, change detection and event matching. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseEventsPage, PARSER } from './parse.mjs';
import { normalizeEvent, fingerprint, diffEvent, comparableOf, matchLocalEvent, COMPARABLE } from './normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTING = readFileSync(join(HERE, '..', 'fixtures', 'events_listing.html'), 'utf8');
const NOW = Date.parse('2026-09-12T12:00:00Z');
const OPTS = { sourceUrl: 'https://www.ufc.com/events', parser: PARSER };

const raws = parseEventsPage(LISTING, { now: NOW }).events;
const rawBySlug = (s) => raws.find((e) => e.ufc_slug === s);
const norm = (slug, extra = {}) => normalizeEvent(rawBySlug(slug), { ...OPTS, ...extra });

test('a real Fight Night normalizes to the documented shape', () => {
  const n = norm('ufc-fight-night-september-12-2026', { brandedName: 'Noche UFC: Silva vs Delgado' });
  assert.equal(n.event_name, 'Noche UFC: Silva vs Delgado');
  assert.equal(n.event_headline, 'Silva vs Delgado');
  assert.equal(n.event_date, '2026-09-12');
  assert.equal(n.early_prelims_start_utc, null);
  assert.equal(n.prelims_start_utc, '2026-09-12T18:00:00.000Z');
  assert.equal(n.main_card_start_utc, '2026-09-12T21:00:00.000Z');
  assert.equal(n.ufc_event_url, 'https://www.ufc.com/event/ufc-fight-night-september-12-2026');
  assert.equal(n.source, 'UFC.com');
  assert.deepEqual(n.broadcasts, [{
    provider: 'Paramount+', region: 'US', type: 'streaming',
    watch_url: n.broadcasts[0].watch_url, segments: ['prelims', 'main_card'],
  }]);
});

test('broadcasts are an array even when there is exactly one carrier', () => {
  const n = norm('ufc-fight-night-september-12-2026');
  assert.ok(Array.isArray(n.broadcasts));
  assert.equal(n.broadcasts.length, 1);
});

test('multiple carriers are ordered deterministically by first segment then name', () => {
  const n = norm('ufc-332');
  assert.deepEqual(n.broadcasts.map((b) => b.provider), ['Paramount+', 'UFC Fight Pass', 'CBS']);
  /* Re-normalizing the same row in a different array order must not move the
   * hash — otherwise every reorder upstream would read as "the card changed". */
  const shuffled = { ...rawBySlug('ufc-332'), broadcasts: [...rawBySlug('ufc-332').broadcasts].reverse() };
  assert.equal(fingerprint(normalizeEvent(shuffled, OPTS)), fingerprint(n));
});

test('a card with no carrier normalizes to an empty array, never a placeholder', () => {
  const n = norm('ufc-fight-night-september-05-2026');
  assert.deepEqual(n.broadcasts, []);
  assert.equal(n.event_name, 'Hooker vs Parnasse', 'the headline is a real source string');
});

test('the UTC date differs from the Eastern event date for a late main card', () => {
  const n = norm('cryptocom-ufc-331');
  assert.equal(n.main_card_start_utc, '2026-09-20T01:00:00.000Z');
  assert.equal(n.event_date, '2026-09-19', 'UFC dates this card Saturday, and so do we');
});

test('normalizeEvent refuses a row with no slug or no name', () => {
  assert.equal(normalizeEvent(null, OPTS), null);
  assert.equal(normalizeEvent({ ufc_slug: '' }, OPTS), null);
  assert.equal(normalizeEvent({ ufc_slug: 'x', event_headline: null }, OPTS), null);
});

test('the fingerprint covers the card facts and ignores bookkeeping', () => {
  const a = norm('ufc-332');
  const b = { ...a, source_url: 'https://www.ufc.com/events?page=1', parser: 'something-v9', tickets_url: 'https://example.com' };
  assert.equal(fingerprint(a), fingerprint(b), 'parser version must not read as a card change');
  assert.deepEqual(Object.keys(comparableOf(a)), COMPARABLE);
});

test('the fingerprint is stable across repeated normalization — idempotency at the unit level', () => {
  const first = fingerprint(norm('ufc-332'));
  for (let i = 0; i < 5; i += 1) assert.equal(fingerprint(norm('ufc-332')), first);
});

test('a changed start time is detected, typed as a time change, and nothing else moves', () => {
  const before = norm('ufc-332');
  const after = { ...before, main_card_start_utc: '2026-10-04T01:00:00.000Z' };
  const d = diffEvent(before, after);
  assert.equal(d.length, 1);
  assert.equal(d[0].field, 'main_card_start_utc');
  assert.equal(d[0].kind, 'time');
  assert.equal(d[0].before, '2026-10-04T00:00:00.000Z');
  assert.equal(d[0].after, '2026-10-04T01:00:00.000Z');
  assert.notEqual(fingerprint(before), fingerprint(after));
});

test('a changed broadcaster is detected and typed as a broadcast change', () => {
  const before = norm('ufc-332');
  const after = { ...before, broadcasts: before.broadcasts.filter((b) => b.provider !== 'CBS') };
  const d = diffEvent(before, after);
  assert.equal(d.length, 1);
  assert.equal(d[0].field, 'broadcasts');
  assert.equal(d[0].kind, 'broadcast');
});

test('an identical record produces no diff at all', () => {
  const a = norm('cryptocom-ufc-331');
  const b = norm('cryptocom-ufc-331');
  assert.deepEqual(diffEvent(a, b), []);
  assert.equal(fingerprint(a), fingerprint(b));
});

test('a venue move is typed separately from a time move', () => {
  const before = norm('ufc-332');
  const d = diffEvent(before, { ...before, venue: 'Somewhere Else Arena' });
  assert.equal(d[0].kind, 'venue');
});

test('matching links a UFC.com row to exactly one local event on that date', () => {
  const rec = norm('ufc-332');
  const m = matchLocalEvent(rec, [
    { id: 'e1', name: 'UFC 332: Silva vs. Wang', event_date: '2026-10-03' },
    { id: 'e2', name: 'UFC Fight Night: Someone vs. Other', event_date: '2026-10-10' },
  ]);
  assert.equal(m.match_status, 'matched');
  assert.equal(m.event_id, 'e1');
});

test('two local events on one date are resolved by name, not by position', () => {
  const rec = norm('ufc-332');
  const m = matchLocalEvent(rec, [
    { id: 'dwcs', name: "Dana White's Contender Series 2026: Week 9", event_date: '2026-10-03' },
    { id: 'real', name: 'UFC 332: Silva vs. Wang', event_date: '2026-10-03' },
  ]);
  assert.equal(m.event_id, 'real');
});

test('an undecidable date reports ambiguous and links nothing', () => {
  const rec = norm('ufc-332');
  const m = matchLocalEvent(rec, [
    { id: 'a', name: 'UFC Fight Night', event_date: '2026-10-03' },
    { id: 'b', name: 'UFC Fight Night', event_date: '2026-10-03' },
  ]);
  assert.equal(m.match_status, 'ambiguous');
  assert.equal(m.event_id, null, 'a wrong link is worse than no link');
});

test('no candidate on the date leaves the row unmatched rather than guessing the nearest', () => {
  const rec = norm('ufc-332');
  const m = matchLocalEvent(rec, [{ id: 'x', name: 'UFC 332: Silva vs. Wang', event_date: '2026-10-04' }]);
  assert.equal(m.match_status, 'unmatched');
  assert.equal(m.event_id, null);
});
