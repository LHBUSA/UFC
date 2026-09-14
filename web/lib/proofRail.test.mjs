/* Homepage Live Intelligence Proof Rail.  Run: npm run test:proof-rail */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./algo.test-hooks.mjs', import.meta.url);
const { buildProofRail, compactCount, shortCardName } = await import('./proofRail.ts');

const NOW = Date.parse('2026-09-14T22:00:00Z');
const bout = (a, b) => ({ fighter_a: { id: a }, fighter_b: { id: b } });
const card = Array.from({ length: 13 }, (_, i) => bout(`a${i}`, `b${i}`));
const counts = { fighters: 3177, events: 899, bouts: 9425, rounds: 42817 };
const base = (over = {}) => ({
  next: { name: 'UFC 331: Van vs. Pantoja 2', event_date: '2026-09-19', slug: 'ufc-331-van-vs-pantoja-2-2026-09-19' },
  liveBouts: card, dnaReady: new Set(card.flatMap((b) => [b.fighter_a.id, b.fighter_b.id])), counts,
  earliestEventDate: '1993-11-12', freshness: { finished_at: '2026-09-14T21:48:01Z', status: 'success' }, now: NOW, ...over,
});
const cell = (rail, key) => rail.cells.find((c) => c.key === key);

test('normal fight week: current card -> current intelligence -> historical depth', () => {
  const r = buildProofRail(base());
  assert.deepEqual(r.cells.map((c) => c.key), ['card', 'dna', 'archive', 'rounds']);
  assert.deepEqual(r.cells.map((c) => c.unit), ['bouts', undefined, 'events', undefined]);
  assert.deepEqual([cell(r, 'card').value, cell(r, 'card').sub], ['13', 'UFC 331 · full card tracked']);
  assert.deepEqual([cell(r, 'dna').value, cell(r, 'dna').sub], ['26 / 26', 'Current-card profiles ready']);
  assert.deepEqual([cell(r, 'archive').value, cell(r, 'archive').sub], ['899', 'Fight archive · 1993 → today']);
  assert.deepEqual([cell(r, 'rounds').value, cell(r, 'rounds').sub], ['42K+', 'Source-linked round-stat rows']);
  assert.equal(r.line, '3,177 fighter identities · 9,425 bouts indexed · Data checked 12 min ago');
});

test('values come from inputs, never constants', () => {
  const r = buildProofRail(base({ next: { name: 'UFC Fight Night: Rosas Jr. vs. Barcelos', event_date: '2026-09-26', slug: 'x' }, liveBouts: card.slice(0, 11), earliestEventDate: '1994-03-11' }));
  assert.equal(cell(r, 'card').value, '11'); assert.equal(cell(r, 'card').unit, 'bouts');
  assert.equal(cell(r, 'card').sub, 'UFC Fight Night · Sep 26 · full card tracked');
  assert.equal(cell(r, 'dna').value, '22 / 22');
  assert.match(cell(r, 'archive').sub, /1994/);
  const src = readFileSync(new URL('./proofRail.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /UFC 331|\b13 bouts|\b899\b|1993/);
});

test('incomplete Fight DNA coverage is reported as it is', () => {
  const ready = new Set(['a0', 'b0', 'a1', 'b1', 'a2']);
  assert.equal(cell(buildProofRail(base({ dnaReady: ready })), 'dna').value, '5 / 26');
  const failed = buildProofRail(base({ dnaReady: null }));
  assert.deepEqual([cell(failed, 'dna').value, cell(failed, 'dna').sub], ['26', 'Current-card dossiers'], 'a failed read never becomes "0 ready"');
});

test('no upcoming card', () => {
  const r = buildProofRail(base({ next: null, liveBouts: [], dnaReady: new Set() }));
  assert.deepEqual([cell(r, 'card').value, cell(r, 'card').sub], ['Between cards', 'Next UFC card not yet scheduled']);
  assert.deepEqual([cell(r, 'dna').value, cell(r, 'dna').sub], ['3,177', 'Fighter identities indexed']);
  assert.ok(!/fighter identities/.test(r.line), 'no duplicate fighter count when the cell already shows it');
  const forming = buildProofRail(base({ liveBouts: [], dnaReady: new Set() }));
  assert.deepEqual([cell(forming, 'card').value, cell(forming, 'card').sub], ['Card forming', 'UFC 331 · bouts not yet announced']);
});

test('zero/null count failure never prints a fake number', () => {
  const r = buildProofRail(base({ counts: { fighters: null, events: 0, bouts: null, rounds: null }, earliestEventDate: null, next: null, liveBouts: [] }));
  assert.equal(cell(r, 'archive').value, '—'); assert.equal(cell(r, 'archive').unavailable, true);
  assert.equal(cell(r, 'rounds').value, '—');
  assert.equal(cell(r, 'dna').value, '—');
  assert.equal(r.line, null);
});

test('freshness phrase only for a recent successful ingest run', () => {
  assert.match(buildProofRail(base({ freshness: { finished_at: '2026-09-12T00:00:00Z', status: 'success' } })).line, /live data layer$/);
  assert.match(buildProofRail(base({ freshness: { finished_at: null, status: 'running' } })).line, /live data layer$/);
  assert.match(buildProofRail(base({ freshness: { finished_at: '2026-09-14T21:00:00Z', status: 'failed' } })).line, /live data layer$/);
});

test('compact counts round down so "+" is always true', () => {
  assert.equal(compactCount(42999), '42K+');
  assert.equal(compactCount(9425), '9,425');
  assert.equal(compactCount(1_299_999), '1.2M+');
  assert.equal(shortCardName('UFC 331: Van vs. Pantoja 2', '2026-09-19'), 'UFC 331');
});

test('homepage reuses loaded data: no new count query, no client polling', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.equal((page.match(/getCounts\(\)/g) || []).length, 1);
  assert.doesNotMatch(page, /HERO_STATS/);
  assert.match(page, /buildProofRail\(/);
  const rail = readFileSync(new URL('./proofRail.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(rail, /fetch\(|setInterval|useEffect/);
});
