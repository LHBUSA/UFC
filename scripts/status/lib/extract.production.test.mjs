/* status-rules-v2 regression against real production headlines.
 * Run: node --test scripts/status/lib/extract.production.test.mjs
 *
 * Every item in fixtures.production-2026-09.json produced an event in the
 * 30-day dry run of status-rules-v1 (2026-09-14). Most of those events were
 * false: retrospective injuries, disputed claims, speculation, another
 * promotion, the wrong subject. This pins which of them may produce an event
 * at the collector's confidence floor, and that the genuine current
 * availability facts still do. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractStatus } from './extract.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures.production-2026-09.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-09-14T22:00:00Z');
const FLOOR = 0.6;

/* Current, sourced availability facts. Required: a regression here is a real
 * status the tracker would stop showing. */
const REQUIRED = new Map([
  ['Tom Aspinall officially vacates UFC heavyweight title due to ongoing eye injuries', ['Tom Aspinall', 'injury']],
  ['Conor McGregor UFC Return And Injury Updates Following Surgery', ['Conor McGregor', 'injury']],
  ['Why did Valentina Shevchenko vacate the UFC title? Injury explained', ['Valentina Shevchenko', 'injury']],
  ["Injured Ulberg hopes to return 'early next year'", ['Carlos Ulberg', 'injury']],
]);
/* Also genuine, but a stricter rule may drop a duplicate of the same fact. */
const ALLOWED = new Map([
  ...REQUIRED,
  ['Tom Aspinall officially vacates UFC Heavyweight title, reveals devastating new eye injury – ‘Absolutely gutted’', ['Tom Aspinall', 'injury']],
  ['‘Absolutely Gutted’ Tom Aspinall Vacates UFC Heavyweight Title After Devastating Eye Injury Setback', ['Tom Aspinall', 'injury']],
  ['Valentina Shevchenko’s coach reveals injury that forced Shevchenko to vacate flyweight title', ['Valentina Shevchenko', 'injury']],
  ['Valentina Shevchenko update: Coach details injury that led to legend vacating UFC flyweight title', ['Valentina Shevchenko', 'injury']],
  ['Noche UFC Card Update After Another Fight Canceled', ['Rodrigo Vera', 'visa_travel']],
]);

const run = (fx) => extractStatus({
  id: fx.title, url: 'https://example.invalid/x', title: fx.title, summary: fx.summary,
  published_at: '2026-09-10T00:00:00Z', taxonomy: { labels: ['injury'] },
  fighters: fx.fighters.map((name) => ({ id: name, name })), event_id: null, bout_id: null,
  source_name: 'Wire', source_kind: 'news',
}, { now: NOW }).events.filter((e) => e.confidence >= FLOOR);

test('no production false positive survives the collector floor', () => {
  for (const fx of FIXTURES) {
    const events = run(fx);
    if (!ALLOWED.has(fx.title)) {
      assert.deepEqual(events.map((e) => `${e.fighter_name} ${e.status_type}`), [], `must not emit: ${fx.title} (v1 emitted ${fx.was})`);
      continue;
    }
    const [who, type] = ALLOWED.get(fx.title);
    for (const e of events) assert.deepEqual([e.fighter_name, e.status_type], [who, type], fx.title);
  }
});

test('genuine current availability facts are still emitted', () => {
  for (const [title, [who, type]] of REQUIRED) {
    const fx = FIXTURES.find((f) => f.title === title);
    assert.ok(fx, `fixture present: ${title}`);
    const events = run(fx);
    assert.equal(events.length, 1, title);
    assert.deepEqual([events[0].fighter_name, events[0].status_type], [who, type]);
  }
});

test('specific cases the owner named', () => {
  const byTitle = (re) => FIXTURES.filter((f) => re.test(f.title));
  for (const fx of byTitle(/Jean Silva reveals injuries/)) assert.deepEqual(run(fx), [], 'Jean Silva disclosed injuries after winning; not unavailable');
  for (const fx of byTitle(/Chimaev/)) assert.deepEqual(run(fx), [], `Chimaev: speculation is not a status (${fx.title})`);
  for (const fx of byTitle(/Tsarukyan/)) assert.deepEqual(run(fx), [], `Tsarukyan is on UFC 331 (${fx.title})`);
  for (const fx of byTitle(/Makhachev|Cong At UFC 332|Brandon Moreno|Mike Perry|Hokit/)) assert.deepEqual(run(fx), [], `wrong subject or out of scope (${fx.title})`);
});
