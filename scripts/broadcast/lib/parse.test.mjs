/* Parser tests, against a fixture cut from the real https://www.ufc.com/events
 * response captured 2026-09-12. The fixture keeps four listing rows verbatim
 * (only inline SVG and fighter headshots stripped, neither of which is parsed):
 *
 *   ufc-fight-night-september-12-2026  Noche UFC — one carrier, no early prelims
 *   cryptocom-ufc-331                  numbered card — two carriers
 *   ufc-332                            numbered card — three carriers incl. CBS
 *   ufc-fight-night-september-05-2026  past card — no carrier published
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseEventsPage, parseEventBlock, parseEventTitle, epochToIso, easternDate,
  providerFromLabel, providerType, safeWatchUrl, isAllowedSourceUrl, splitListing,
} from './parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(HERE, '..', 'fixtures', n), 'utf8');
const LISTING = fixture('events_listing.html');
const DETAIL = fixture('event_detail_noche.html');
const NOW = Date.parse('2026-09-12T12:00:00Z');

const bySlug = (page, slug) => page.events.find((e) => e.ufc_slug === slug);

test('the listing page parses every row it contains', () => {
  const page = parseEventsPage(LISTING, { now: NOW });
  assert.equal(page.ok, true);
  assert.equal(page.rows, 4);
  assert.equal(page.recognised, 4);
  assert.equal(page.unrecognised, 0);
  assert.equal(page.upcoming, 3, 'the September 5 card is in the past at NOW');
});

test('a normal Fight Night: one carrier, prelims and main card, no early prelims', () => {
  const e = bySlug(parseEventsPage(LISTING, { now: NOW }), 'ufc-fight-night-september-12-2026');
  assert.equal(e.event_headline, 'Silva vs Delgado');
  assert.equal(e.ufc_event_url, 'https://www.ufc.com/event/ufc-fight-night-september-12-2026');
  assert.equal(e.early_prelims_start_utc, null, 'UFC.com publishes an empty attribute; it must stay null, not 1970');
  assert.equal(e.prelims_start_utc, '2026-09-12T18:00:00.000Z');
  assert.equal(e.main_card_start_utc, '2026-09-12T21:00:00.000Z');
  assert.equal(e.venue, 'Desert Diamond Arena');
  assert.equal(e.city, 'Glendale');
  assert.equal(e.region, 'AZ');
  assert.equal(e.country, 'United States');
  assert.equal(e.broadcasts.length, 1);
  assert.equal(e.broadcasts[0].provider, 'Paramount+');
  assert.deepEqual(e.broadcasts[0].segments, ['prelims', 'main_card']);
  assert.ok(e.broadcasts[0].watch_url.startsWith('https://'));
});

test('a numbered card with two carriers keeps both, de-duplicated across segments', () => {
  const e = bySlug(parseEventsPage(LISTING, { now: NOW }), 'cryptocom-ufc-331');
  const names = e.broadcasts.map((b) => b.provider).sort();
  assert.deepEqual(names, ['Paramount+', 'UFC Fight Pass']);
  const p = e.broadcasts.find((b) => b.provider === 'Paramount+');
  assert.deepEqual(p.segments, ['early_prelims', 'prelims', 'main_card'],
    'Paramount+ carries three segments but must appear exactly once');
  assert.equal(e.early_prelims_start_utc, '2026-09-19T21:00:00.000Z');
});

test('a numbered card with three carriers keeps the TV network alongside the streamers', () => {
  const e = bySlug(parseEventsPage(LISTING, { now: NOW }), 'ufc-332');
  assert.equal(e.broadcasts.length, 3);
  const cbs = e.broadcasts.find((b) => b.provider === 'CBS');
  assert.ok(cbs, 'CBS must survive: a single `network` string would have dropped it');
  assert.equal(cbs.type, 'tv');
  assert.deepEqual(cbs.segments, ['main_card']);
  assert.equal(e.broadcasts.find((b) => b.provider === 'Paramount+').type, 'streaming');
});

test('an event with no published carrier gets an empty array, never an invented network', () => {
  const e = bySlug(parseEventsPage(LISTING, { now: NOW }), 'ufc-fight-night-september-05-2026');
  assert.deepEqual(e.broadcasts, []);
  assert.equal(e.main_card_start_utc, '2026-09-05T19:00:00.000Z', 'times are still published for it');
});

test('tickets links are captured but never treated as a broadcaster', () => {
  const page = parseEventsPage(LISTING, { now: NOW });
  for (const e of page.events) {
    for (const b of e.broadcasts) {
      assert.ok(!/^tickets?$/i.test(b.provider), `"${b.provider}" is a ticket button, not a carrier`);
    }
  }
  assert.ok(bySlug(page, 'ufc-332').tickets_url.startsWith('https://'));
});

test('unexpected markup yields a closed failure, not an empty schedule', () => {
  for (const bad of ['', '<html><body>nope</body></html>', '<div class="l-listing__item views-row"><p>redesigned</p></div>']) {
    const page = parseEventsPage(bad, { now: NOW });
    assert.equal(page.ok, false, `must fail closed on: ${bad.slice(0, 40)}`);
    assert.equal(page.events.length, 0);
    assert.ok(page.reason, 'a failure must say why');
  }
});

test('one malformed row does not take the other rows with it', () => {
  const broken = '<div class="l-listing__item views-row"><div class="c-card-event--result__headline"><a href="/not-an-event">Junk</a></div></div>';
  const page = parseEventsPage(LISTING.replace('<h1>Events</h1>', `<h1>Events</h1>${broken}`), { now: NOW });
  assert.equal(page.recognised, 4, 'all four real rows still parse');
  assert.equal(page.unrecognised, 1, 'and the junk row is counted, not swallowed');
});

test('a row whose block throws is skipped, not fatal', () => {
  /* parseEventBlock is total by contract: it returns null rather than throwing
   * on anything that is not an event row. */
  assert.equal(parseEventBlock('<div>nothing</div>'), null);
  assert.equal(parseEventBlock(''), null);
});

test('epoch parsing refuses everything that is not a plausible second-precision epoch', () => {
  assert.equal(epochToIso('1789246800'), '2026-09-12T21:00:00.000Z');
  for (const bad of ['', null, undefined, '0', 'abc', '  ', '1789246800000', '-1789246800', '123']) {
    assert.equal(epochToIso(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('the event date is the US Eastern day of the main card, computed with Intl', () => {
  /* UFC 331's main card is 01:00 UTC on Sunday Sep 20, which is Saturday
   * Sep 19 in Eastern — the day UFC itself and our ufc_events both call it. A
   * naive slice of the ISO string would have said the 20th. */
  assert.equal(easternDate('2026-09-20T01:00:00.000Z'), '2026-09-19');
  assert.equal(easternDate('2026-09-12T21:00:00.000Z'), '2026-09-12');
  assert.equal(easternDate(null), null);
  assert.equal(easternDate('not-a-date'), null);
});

test('Eastern date is correct on both sides of a daylight-saving transition', () => {
  /* US DST ended 2026-11-01 at 06:00 UTC. 05:30 UTC on Nov 1 is still Oct 31
   * in EDT (-4); 07:00 UTC is Nov 1 in EST (-5). A hard-coded -5 gets the
   * first one wrong and a hard-coded -4 gets neither edge right. */
  assert.equal(easternDate('2026-11-01T03:30:00.000Z'), '2026-10-31', 'EDT, still Saturday night');
  assert.equal(easternDate('2026-11-01T07:00:00.000Z'), '2026-11-01', 'EST, now Sunday');
  /* And in March, when the clocks go forward. */
  assert.equal(easternDate('2026-03-08T06:30:00.000Z'), '2026-03-08');
  assert.equal(easternDate('2026-03-08T04:30:00.000Z'), '2026-03-07');
});

test('provider names come off the button label and junk labels are rejected', () => {
  assert.equal(providerFromLabel('Watch On Paramount+'), 'Paramount+');
  assert.equal(providerFromLabel('Watch on CBS'), 'CBS');
  assert.equal(providerFromLabel('Watch on UFC Fight Pass'), 'UFC Fight Pass');
  assert.equal(providerFromLabel('Tickets'), null);
  assert.equal(providerFromLabel('Available'), null);
  assert.equal(providerFromLabel(''), null);
});

test('an unknown carrier keeps its name and gets a null type rather than a guessed one', () => {
  assert.equal(providerType('Paramount+'), 'streaming');
  assert.equal(providerType('CBS'), 'tv');
  assert.equal(providerType('Some Future Network'), null);
  assert.equal(providerType(null), null);
});

test('watch URLs are validated and http is upgraded', () => {
  assert.equal(safeWatchUrl('http://www.ufcfightpass.com'), 'https://www.ufcfightpass.com/');
  assert.equal(safeWatchUrl('https://ufc.ac/4v2K4zW'), 'https://ufc.ac/4v2K4zW');
  assert.equal(safeWatchUrl('javascript:alert(1)'), null);
  assert.equal(safeWatchUrl('/relative'), null);
  assert.equal(safeWatchUrl(''), null);
  assert.equal(safeWatchUrl(null), null);
});

test('only UFC.com is fetchable — the Worker is not a proxy', () => {
  assert.equal(isAllowedSourceUrl('https://www.ufc.com/events'), true);
  assert.equal(isAllowedSourceUrl('https://www.ufc.com/event/ufc-332'), true);
  assert.equal(isAllowedSourceUrl('https://evil.example/ufc.com/events'), false);
  assert.equal(isAllowedSourceUrl('http://www.ufc.com/events'), false, 'plaintext is not an authoritative source');
  assert.equal(isAllowedSourceUrl('https://ufc.com.evil.example/'), false);
  assert.equal(isAllowedSourceUrl('not a url'), false);
});

test('the branded name comes off the event page title', () => {
  assert.equal(parseEventTitle(DETAIL), 'Noche UFC: Silva vs Delgado');
  assert.equal(parseEventTitle('<title>UFC 332: Silva vs Wang | UFC</title>'), 'UFC 332: Silva vs Wang');
  assert.equal(parseEventTitle('<title>Page not found | UFC</title>'), null);
  assert.equal(parseEventTitle('<html>no title</html>'), null);
  assert.equal(parseEventTitle(null), null);
});

test('splitListing finds one block per listing item', () => {
  assert.equal(splitListing(LISTING).length, 4);
  assert.equal(splitListing('<p>no items</p>').length, 0);
});
