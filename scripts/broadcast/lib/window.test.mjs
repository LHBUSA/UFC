/* The cadence gate: how often a 30-minute cron actually reaches UFC.com. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWindow, CADENCE } from './window.mjs';

const MAIN = '2026-10-04T00:00:00.000Z';
const FIRST = '2026-10-03T20:00:00.000Z';
const at = (iso) => Date.parse(iso);

test('no stored schedule is idle, not an error', () => {
  const p = planWindow({ now: at('2026-09-12T12:00:00Z') });
  assert.equal(p.mode, 'idle');
  assert.equal(p.minEveryMinutes, CADENCE.idle);
  assert.equal(p.skip, false, 'with no last run there is nothing to skip against');
});

test('a card a month out refreshes every 12 hours', () => {
  const p = planWindow({ nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-09-04T00:00:00Z') });
  assert.equal(p.mode, 'idle');
  assert.equal(p.minEveryMinutes, 720);
});

test('fight week refreshes every 6 hours', () => {
  const p = planWindow({ nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-09-29T00:00:00Z') });
  assert.equal(p.mode, 'week');
  assert.equal(p.minEveryMinutes, 360);
});

test('inside 24 hours it refreshes hourly', () => {
  const p = planWindow({ nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-10-03T06:00:00Z') });
  assert.equal(p.mode, 'near');
  assert.equal(p.minEveryMinutes, 60);
});

test('event day refreshes every wake', () => {
  const p = planWindow({ nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-10-03T19:00:00Z') });
  assert.equal(p.mode, 'day');
  assert.equal(p.minEveryMinutes, 30);
});

test('once the first segment has started the card is live and stays live through the tail', () => {
  const during = planWindow({ nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-10-03T22:30:00Z') });
  assert.equal(during.mode, 'live');
  const late = planWindow({ nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-10-04T04:00:00Z') });
  assert.equal(late.mode, 'live', 'still inside the five-hour tail');
});

test('after the tail the pass backs off instead of hammering a finished card', () => {
  const p = planWindow({ nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-10-04T12:00:00Z') });
  assert.equal(p.mode, 'idle');
  assert.equal(p.minEveryMinutes, 720);
  assert.match(p.reason, /finished/);
});

test('the cadence gate skips a wake that is too soon, and says by how much', () => {
  const p = planWindow({
    nextStartIso: FIRST, mainCardIso: MAIN,
    now: at('2026-09-29T00:00:00Z'), lastRunAt: '2026-09-28T22:00:00Z',
  });
  assert.equal(p.skip, true, '2h since the last pass, minimum 6h in fight week');
  assert.match(p.reason, /minimum 360m/);
});

test('the cadence gate lets a due wake through', () => {
  const p = planWindow({
    nextStartIso: FIRST, mainCardIso: MAIN,
    now: at('2026-09-29T00:00:00Z'), lastRunAt: '2026-09-28T16:00:00Z',
  });
  assert.equal(p.skip, false, '8h since the last pass, minimum 6h');
});

test('event day lets a 30-minute-old run through but not a 10-minute-old one', () => {
  const base = { nextStartIso: FIRST, mainCardIso: MAIN, now: at('2026-10-03T19:00:00Z') };
  assert.equal(planWindow({ ...base, lastRunAt: '2026-10-03T18:29:00Z' }).skip, false);
  assert.equal(planWindow({ ...base, lastRunAt: '2026-10-03T18:50:00Z' }).skip, true);
});

test('a last-run timestamp in the future is treated as "just ran", not as overdue', () => {
  const p = planWindow({
    nextStartIso: FIRST, mainCardIso: MAIN,
    now: at('2026-10-03T19:00:00Z'), lastRunAt: '2026-10-03T20:00:00Z',
  });
  assert.equal(p.skip, true);
  assert.match(p.reason, /future/);
});

test('a stored card with an unparseable time falls back to idle rather than throwing', () => {
  const p = planWindow({ nextStartIso: 'nonsense', mainCardIso: 'nonsense', now: at('2026-10-03T19:00:00Z') });
  assert.equal(p.mode, 'idle');
  assert.equal(p.hoursOut, null);
});

test('a card with only a main card time still schedules correctly', () => {
  const p = planWindow({ nextStartIso: null, mainCardIso: MAIN, now: at('2026-10-03T19:00:00Z') });
  assert.equal(p.mode, 'day');
});
