import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260910235900_combat_career_graph.sql');
const LAYERS = path.join(ROOT, 'supabase', 'migrations', '20260910235910_combat_expansion_layers.sql');
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const LAYER_SQL = fs.readFileSync(LAYERS, 'utf8');

function sourceRow(key) {
  const marker = `('${key}',`;
  const i = SQL.indexOf(marker);
  assert.notEqual(i, -1, `missing source seed ${key}`);
  return SQL.slice(i, SQL.indexOf('\n', i));
}

test('combat overlay never mutates the canonical UFC tables', () => {
  for (const text of [SQL, LAYER_SQL]) {
    assert.equal(/alter\s+table\s+public\.ufc_/i.test(text), false);
    assert.equal(/insert\s+into\s+public\.ufc_/i.test(text), false);
    assert.equal(/update\s+public\.ufc_/i.test(text), false);
    assert.equal(/delete\s+from\s+public\.ufc_/i.test(text), false);
  }
});

test('unreviewed MMA sources are fail-closed', () => {
  for (const key of [
    'sherdog', 'tapology', 'fightmatrix', 'mma_decisions', 'fight_forensics',
    'ufcalendar', 'sportsdataio', 'sportradar', 'promotion_official', 'ufc_official', 'athletic_commission',
  ]) {
    const row = sourceRow(key);
    assert.match(row, /'review_required'/);
    assert.match(row, /false, false/);
  }
});

test('Combat Registry is explicitly blocked without a written agreement', () => {
  const row = sourceRow('combat_registry');
  assert.match(row, /'blocked', 'prohibited', false, false/);
});

test('only explicit approved sources start fact-enabled', () => {
  assert.match(sourceRow('ufc_canonical'), /'approved_ingest', 'internal', true, true/);
  assert.match(sourceRow('wikidata'), /'approved_ingest', 'approved', true, true/);
  assert.match(sourceRow('ufcstats'), /'identity_only', 'reference_only', false, true/);
  assert.match(sourceRow('espn'), /'identity_only', 'reference_only', false, true/);
});

test('canonical fact tables are guarded by source policy', () => {
  for (const table of ['combat_promotions', 'combat_rulesets', 'combat_events', 'combat_bouts', 'combat_bout_results', 'combat_round_stats']) {
    assert.match(SQL, new RegExp(`create trigger ${table}_source_guard`, 'i'));
  }
  for (const table of [
    'combat_ingest_packets', 'combat_bout_officials', 'combat_scorecards', 'combat_weigh_ins',
    'combat_titles', 'combat_title_bouts', 'combat_rankings', 'combat_status_events', 'combat_awards',
  ]) {
    assert.match(LAYER_SQL, new RegExp(`create trigger ${table}_source_guard`, 'i'));
  }
  assert.match(SQL, /v_mode <> 'approved_ingest'/);
});

test('career view keeps UFC and external scope explicit', () => {
  assert.match(SQL, /'ufc'::text as source_scope/);
  assert.match(SQL, /'combat'::text as source_scope/);
  assert.match(SQL, /ufc_appearances/);
  assert.match(SQL, /external_appearances/);
});
