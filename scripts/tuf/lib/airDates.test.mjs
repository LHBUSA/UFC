import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAirDate } from './airDates.mjs';

const independent = (date) => ({ date, family: 'wikipedia', url: 'https://en.wikipedia.org/wiki/The_Ultimate_Fighter_1', retrieved: '2026-09-13', cites: 'IMDb' });

test('network listing + independent source on the same day resolves the air date', () => {
  const r = resolveAirDate({ listing_date: '2005-01-17', display_date: '2005-01-18', independent: independent('2005-01-17') });
  assert.equal(r.air_date, '2005-01-17');
  assert.equal(r.air_date_resolution.basis, 'network_listing + independent_source');
  assert.equal(r.air_date_resolution.network_listing_date, '2005-01-17');
  assert.equal(r.air_date_resolution.network_display_date, '2005-01-18', 'the +1 display date is kept, not overwritten');
  assert.match(r.air_date_resolution.date_conflict_note, /\+1 day/);
});

test('a disagreement leaves the air date unresolved and says why', () => {
  const r = resolveAirDate({ listing_date: '2026-05-25', independent: independent('2025-08-23') });
  assert.equal(r.air_date, null);
  assert.equal(r.air_date_resolution.status, 'unresolved');
  assert.match(r.air_date_resolution.why, /disagree/);
});

test('a listing date alone is never promoted to an air date', () => {
  const r = resolveAirDate({ listing_date: '2005-01-17' });
  assert.equal(r.air_date, null);
  assert.equal(r.air_date_resolution.why, 'no independent source date');
});

test('an independent date alone is not enough either', () => {
  assert.equal(resolveAirDate({ listing_date: null, independent: independent('2005-01-17') }).air_date, null);
});

test('the display date can never stand in for the listing date', () => {
  const r = resolveAirDate({ listing_date: null, display_date: '2005-01-18', independent: independent('2005-01-18') });
  assert.equal(r.air_date, null);
});

test('no dates at all records nothing', () => {
  assert.deepEqual(resolveAirDate({ listing_date: null }), { air_date: null, air_date_resolution: null });
});
