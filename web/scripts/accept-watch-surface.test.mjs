import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWatchSurface, checkStaticWiring, siteDaysUntil } from './accept-watch-surface.mjs';

/* Thursday of a generic fight week; the card is Saturday. */
const NOW = Date.parse('2026-11-12T15:00:00Z');
const page = (heroAttrs, inner) => `<html><body><section class="hero"><div class="hero-feature" ${heroAttrs}><a class="poster">card</a>${inner}</div></div></section><section class="sec">rest</section></body></html>`;
const STRIP = '<div class="hero-watch" data-watch-surface="strip"><div class="strip" data-watch-state="strip"><time datetime="2026-11-15T00:00:00Z">8:00 PM ET</time><a>Watch on Paramount+</a></div></div>';
const UNAVAILABLE = '<div class="hero-watch" data-watch-surface="unavailable"><div data-watch-state="unavailable" role="status"><span>Start times &amp; broadcast · X</span><p>Schedule verification temporarily unavailable</p></div></div>';
const PENDING = '<div class="hero-watch" data-watch-surface="pending"><div data-watch-state="pending"><p>Start times to be announced</p></div></div>';

test('fight week + WatchStrip passes', () => {
  const v = checkWatchSurface(page('data-watch-surface="strip" data-event-date="2026-11-14"', STRIP), { now: NOW });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.applies, true);
});

test('fight week + explicit unavailable state passes', () => {
  assert.equal(checkWatchSurface(page('data-watch-surface="unavailable" data-event-date="2026-11-14"', UNAVAILABLE), { now: NOW }).ok, true);
});

test('fight week + times-to-be-announced state passes', () => {
  assert.equal(checkWatchSurface(page('data-watch-surface="pending" data-event-date="2026-11-14"', PENDING), { now: NOW }).ok, true);
});

test('fight week with NEITHER fails — the 2026-10-03 incident shape', () => {
  const v = checkWatchSurface(page('data-watch-surface="none" data-event-date="2026-11-14"', ''), { now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /neither/);
  /* A pre-gate deploy (no markers at all) fails too, using the API date. */
  const old = checkWatchSurface('<div class="hero-feature"><a class="poster">card</a></div></section>', { now: NOW, nextEvent: { event_date: '2026-11-14' } });
  assert.equal(old.ok, false);
  /* An empty strip shell is not a strip. */
  const shell = checkWatchSurface(page('data-watch-surface="strip" data-event-date="2026-11-14"', '<div class="hero-watch"><div data-watch-state="strip"></div></div>'), { now: NOW });
  assert.equal(shell.ok, false);
});

test('outside fight week the gate does not apply', () => {
  const v = checkWatchSurface(page('data-watch-surface="none" data-event-date="2026-12-12"', ''), { now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.applies, false);
});

test('a closed broadcast window does not apply', () => {
  const after = Date.parse('2026-11-15T06:00:00Z');
  assert.equal(checkWatchSurface(page('data-watch-surface="finished" data-event-date="2026-11-14"', ''), { now: after }).applies, false);
  assert.equal(checkWatchSurface(page('data-event-date="2026-11-14"', ''), { now: after, nextEvent: { event_date: '2026-11-14', main_card_start_utc: '2026-11-15T00:00:00Z' } }).applies, false);
});

test('site clock: fight night stays day 0 until 05:00 UTC', () => {
  assert.equal(siteDaysUntil('2026-11-14', Date.parse('2026-11-15T04:30:00Z')), 0);
  assert.equal(siteDaysUntil('2026-11-14', Date.parse('2026-11-15T05:30:00Z')), -1);
});

test('the source wiring the gate depends on is in place', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  assert.deepEqual(checkStaticWiring(root), []);
});
