import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const p = path.join(ROOT, 'supabase', 'migrations', '20260910231000_combat_direct_public_sources.sql');
const SQL = fs.readFileSync(p, 'utf8');

test('Wikipedia is the enabled direct-source career lane', () => {
  assert.match(SQL, /\('wikipedia_en'/);
  assert.match(SQL, /'approved_ingest'/);
  assert.match(SQL, /'approved'/);
  assert.match(SQL, /Direct MediaWiki Action API source/);
});

test('UFCalendar is explicitly disabled as a downstream aggregator', () => {
  assert.match(SQL, /where source_key = 'ufcalendar'/);
  assert.match(SQL, /access_mode = 'blocked'/);
  assert.match(SQL, /Downstream aggregation of sources PropBetEdge can ingest directly/);
});

test('product-policy blocking does not masquerade as a legal conclusion', () => {
  const vendorSection = SQL.slice(SQL.indexOf('-- UFCalendar'), SQL.indexOf('commit;'));
  assert.match(vendorSection, /rights_state = 'unknown'/);
  assert.doesNotMatch(vendorSection, /rights_state = 'prohibited'/);
});

test('direct-source migration contains no fight data writes', () => {
  assert.doesNotMatch(SQL, /insert\s+into\s+public\.combat_(fighters|events|bouts|bout_results|round_stats)/i);
});
