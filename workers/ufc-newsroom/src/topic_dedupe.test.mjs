import assert from 'node:assert/strict';
import test from 'node:test';
import { externalTopicsMatch } from '../../../scripts/news/write_articles.mjs';

test('different headlines about the same bout are one newsroom topic', () => {
  assert.equal(externalTopicsMatch(
    { bout_id: 'ortega-moicano', event_id: 'ufc-331', fighter_ids: ['ortega', 'moicano'] },
    { bout_id: 'ortega-moicano', event_id: 'ufc-331', fighter_ids: ['moicano', 'ortega'] },
  ), true);
});

test('same event and fighter pair dedupes when a source lacks the bout link', () => {
  assert.equal(externalTopicsMatch(
    { bout_id: null, event_id: 'ufc-331', fighter_ids: ['ortega', 'moicano'] },
    { bout_id: null, event_id: 'ufc-331', fighter_ids: ['moicano', 'ortega', 'replacement'] },
  ), true);
});

test('one shared fighter does not collapse unrelated news', () => {
  assert.equal(externalTopicsMatch(
    { bout_id: null, event_id: 'ufc-331', fighter_ids: ['ortega', 'moicano'] },
    { bout_id: null, event_id: 'ufc-331', fighter_ids: ['ortega', 'new-opponent'] },
  ), false);
});

test('same fighters at a different event remain a separate story', () => {
  assert.equal(externalTopicsMatch(
    { bout_id: null, event_id: 'ufc-331', fighter_ids: ['ortega', 'moicano'] },
    { bout_id: null, event_id: 'ufc-332', fighter_ids: ['ortega', 'moicano'] },
  ), false);
});
