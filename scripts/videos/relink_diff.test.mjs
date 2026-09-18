/* node --test scripts/videos/relink_diff.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffRow, project, stable, ageBand, BUCKETS } from './relink_diff.mjs';
import { parseCliOptions, main } from './ingest_youtube.mjs';

const row = (over = {}, sm = {}) => ({
  event_id: 'ev-1', bout_id: 'b-1', article_id: null, fighter_ids: ['f-1', 'f-2'], resolver_confidence: 'high', link_status: 'published', video_type: 'weigh_in',
  source_metadata: { language: 'en', linked_at: '2026-09-01T00:00:00Z', linking: { event: { key: 'ufc 331', kind: 'number', method: 'unique_key', in_title: true }, fighters: [], bout: null, article_candidates: 0 }, classification: { evidence: [{ video_type: 'weigh_in', source: 'title', match: 'Weigh-In' }] }, ...sm },
  ...over,
});

test('a stable row produces no diff; linked_at alone and jsonb key order are not drift', () => {
  const stored = row();
  assert.deepEqual(diffRow(stored, row()), { fields: [], buckets: [], risk: 'none', removed_fighters: [], added_fighters: [] });
  const restamped = row({}, { linked_at: '2026-09-18T15:00:00Z', linking: { article_candidates: 0, bout: null, fighters: [], event: { in_title: true, method: 'unique_key', kind: 'number', key: 'ufc 331', linked_at: '2026-09-18T15:00:00Z' } } });
  assert.deepEqual(diffRow(stored, restamped).fields, [], 'timestamps and key order are ignored at every depth');
  assert.equal(stable({ b: 1, a: { linked_at: 'x', z: 2 } }), stable({ a: { z: 2, linked_at: 'y' }, b: 1 }));
  assert.deepEqual(diffRow(row({ fighter_ids: ['f-2', 'f-1'] }), row()).fields, [], 'fighter order is not a change');
});

test('event changes: gained, lost and changed are told apart, and lost/changed are HIGH', () => {
  assert.deepEqual(diffRow(row({ event_id: null }), row()).buckets, [BUCKETS.A]);
  assert.equal(diffRow(row({ event_id: null }), row()).risk, 'medium');
  const lost = diffRow(row(), row({ event_id: null }));
  assert.deepEqual([lost.buckets, lost.risk], [[BUCKETS.B], 'high']);
  const changed = diffRow(row(), row({ event_id: 'ev-2026' }));
  assert.deepEqual([changed.buckets, changed.risk], [[BUCKETS.C], 'high']);
});

test('bout changes are detected and HIGH when a canonical link disappears or moves', () => {
  assert.deepEqual(diffRow(row({ bout_id: null }), row()).buckets, [BUCKETS.D]);
  assert.equal(diffRow(row(), row({ bout_id: null })).risk, 'high');
  assert.deepEqual(diffRow(row(), row({ bout_id: 'b-9' })).buckets, [BUCKETS.F]);
});

test('fighter-set changes: gained is medium, a removed or replaced fighter is HIGH, and the names are reported', () => {
  const gained = diffRow(row(), row({ fighter_ids: ['f-1', 'f-2', 'f-3'] }));
  assert.deepEqual([gained.buckets, gained.risk, gained.added_fighters], [[BUCKETS.G], 'medium', ['f-3']]);
  const lost = diffRow(row(), row({ fighter_ids: ['f-1'] }));
  assert.deepEqual([lost.buckets, lost.risk, lost.removed_fighters], [[BUCKETS.H], 'high', ['f-2']]);
  const swapped = diffRow(row(), row({ fighter_ids: ['f-1', 'f-9'] }));
  assert.deepEqual([swapped.buckets, swapped.risk], [[BUCKETS.I], 'high']);
});

test('status, confidence, article and review changes are classified; any link_status move is HIGH', () => {
  assert.equal(diffRow(row(), row({ link_status: 'review' }, { review_reason: 'ambiguous_surname' })).risk, 'high');
  assert.equal(diffRow(row({ link_status: 'review' }), row()).risk, 'high', 'publishing something the resolver once doubted');
  assert.deepEqual(diffRow(row(), row({ resolver_confidence: 'medium' })).buckets, [BUCKETS.K]);
  assert.equal(diffRow(row(), row({ resolver_confidence: 'medium' })).risk, 'medium');
  assert.deepEqual(diffRow(row(), row({ article_id: 'a-1' })).buckets, [BUCKETS.J]);
});

test('metadata-only changes are LOW and never claim an identity bucket', () => {
  const evidence = diffRow(row(), row({}, { linking: { event: { key: 'ufc 331', kind: 'number', method: 'unique_key', in_title: true }, fighters: [], bout: null, article_candidates: 3 } }));
  assert.deepEqual([evidence.fields, evidence.buckets, evidence.risk], [['linking'], [BUCKETS.P], 'low']);
  const tuf = diffRow(row({}, { tuf: { season: 'tuf-1', evidence: { rule: 'a' } } }), row({}, { tuf: { season: 'tuf-1', evidence: { rule: 'b' } } }));
  assert.deepEqual([tuf.buckets, tuf.risk], [[BUCKETS.O], 'low']);
  const lang = diffRow(row({}, { language: null }), row());
  assert.deepEqual([lang.buckets, lang.risk], [[BUCKETS.P], 'low']);
  const cls = diffRow(row(), row({ video_type: 'faceoff' }, { classification: { evidence: [] } }));
  assert.deepEqual([cls.buckets, cls.risk], [[BUCKETS.N], 'medium'], 'a type change moves the card between stages: visible, so not low');
  /* An identity change is never also reported as "only". */
  const both = diffRow(row(), row({ event_id: null }, { tuf: { season: 'x' } }));
  assert.ok(!both.buckets.includes(BUCKETS.O) && !both.buckets.includes(BUCKETS.P));
});

test('project() reads stored and proposed rows identically; ageBand uses the publish date', () => {
  assert.deepEqual(Object.keys(project(row())).sort(), ['article_id', 'bout_id', 'classification_evidence', 'event_id', 'fighter_ids', 'language', 'link_status', 'linking', 'resolver_confidence', 'review', 'review_reason', 'tuf', 'video_type']);
  const now = '2026-09-18T00:00:00Z';
  assert.deepEqual(['2026-09-15T00:00:00Z', '2026-09-01T00:00:00Z', '2026-07-01T00:00:00Z', '2017-12-01T00:00:00Z', null].map((d) => ageBand(d, now)), ['0-7d', '8-30d', '31-90d', '>90d', 'unknown']);
});

test('--explain is read-only by construction, and --ids is intact', async () => {
  const o = parseCliOptions(['--relink', '--dry-run', '--explain', '--explain-out', 'x.json', '--ids', 'a,b']);
  assert.deepEqual([o.relink, o.dry, o.explain, o.explainOut, [...o.ids]], [true, true, true, 'x.json', ['a', 'b']]);
  assert.deepEqual([parseCliOptions(['--relink']).explain, parseCliOptions(['--relink']).ids], [false, null], 'default behaviour is unchanged');
  /* Without --dry-run the run is refused before it reads or writes anything. */
  await assert.rejects(() => main({ SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' }, { relink: true, explain: true, dry: false }), /requires --dry-run/);
  /* The single upsert in the ingest sits behind the DRY guard. */
  const src = readFileSync(new URL('./ingest_youtube.mjs', import.meta.url), 'utf8');
  /* Two write calls: the per-channel upsert (feed / backfill / --ids) behind the DRY guard, and the full-relink
   * upsert that only runs after the whole plan has passed the destructive-change guard. */
  assert.equal([...src.matchAll(/sb\.(upsert|insert|update|delete|patch)\(/g)].length, 2, 'two write calls in the ingest');
  assert.ok(src.indexOf('full relink refused') < src.lastIndexOf('sb.upsert('), 'the full-relink write comes after the refusal');
  assert.ok(src.indexOf("if (DRY) { console.log(`  would upsert") < src.indexOf('sb.upsert(') && src.indexOf('sb.upsert(') - src.indexOf("if (DRY) { console.log(`  would upsert") < 400, 'and it follows the dry-run `continue`');
  assert.doesNotMatch(readFileSync(new URL('./relink_diff.mjs', import.meta.url), 'utf8'), /\bfetch\(|Supabase|writeFile/, 'the diff module does no I/O');
  assert.doesNotMatch(readFileSync(new URL('./relink_drift_report.mjs', import.meta.url), 'utf8'), /sb\.(upsert|insert|update|delete|patch)\(/, 'the receipt script only selects');
});

test('the order of fighter evidence is not drift; a changed method or a different fighter still is', async () => {
  const { normLinking } = await import('./relink_diff.mjs');
  const f = (id, method = 'full_name_event_card') => ({ fighter_id: id, alias: id, method, in_title: true });
  const a = row({}, { linking: { event: null, fighters: [f('f-2'), f('f-1')], bout: null, article_candidates: 0, surnames_withheld: [{ alias: 'b', fighter_id: 'x2' }, { alias: 'a', fighter_id: 'x1' }] } });
  const b = row({}, { linking: { event: null, fighters: [f('f-1'), f('f-2')], bout: null, article_candidates: 0, surnames_withheld: [{ alias: 'a', fighter_id: 'x1' }, { alias: 'b', fighter_id: 'x2' }] } });
  assert.deepEqual(diffRow(a, b).fields, [], 'same fighters, same evidence, different order');
  assert.deepEqual(diffRow(a, row({}, { linking: { ...b.source_metadata.linking, fighters: [f('f-1'), f('f-2', 'full_name_unique')] } })).fields, ['linking'], 'a method change is still seen');
  assert.deepEqual(diffRow(a, row({}, { linking: { ...b.source_metadata.linking, fighters: [f('f-1'), f('f-3')] } })).fields, ['linking'], 'and so is a different fighter');
  assert.equal(normLinking(null), null);
  assert.deepEqual(a.source_metadata.linking.fighters.map((x) => x.fighter_id), ['f-2', 'f-1'], 'the input is not mutated');
});
