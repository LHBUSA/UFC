/* Weigh-in arithmetic. Run: node --test scripts/weighins/lib/weights.test.mjs
 *
 * The first block is the one that matters. A fabricated delta is a specific,
 * checkable claim about a named athlete — "missed by 2.5 lb" — and it is wrong
 * whenever the limit was assumed rather than known. Everything else here is
 * coverage; that block is the promise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  resolveLimit, allowanceFor, evaluateWeight, fingerprintOf, projectCurrent,
  summaryLine, DIVISION_LIMIT_LBS, UNSUPPORTED_CLASSES, SOURCE_RANK,
} from './weights.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/* ================= NEVER INFER A CONTRACTED LIMIT ================= */

test('a catchweight bout yields no limit, no matter what else is known', () => {
  const r = resolveLimit({ weightClass: 'CATCHWEIGHT', isTitle: false });
  assert.equal(r.limit_basis, 'unsupported');
  assert.equal(r.contracted_limit_lbs, null);
  assert.equal(r.allowance_lbs, null);
  assert.equal(r.applicable_limit_lbs, null);
  assert.match(r.reason, /must be sourced/, 'and it says why, so a page can explain the gap');
});

test('an open-weight or unknown division yields no limit', () => {
  for (const wc of ['OPEN', 'SUPER_HEAVYWEIGHT', null, undefined, 'NONSENSE']) {
    assert.equal(resolveLimit({ weightClass: wc, isTitle: false }).limit_basis, 'unsupported', `${wc} must not produce a limit`);
  }
});

test('an unknown title status yields no limit, because the allowance depends on it', () => {
  /* The subtle one. The division is standard and the temptation is to assume
   * non-title, which is right most of the time and silently wrong by a pound
   * on every championship bout. */
  const r = resolveLimit({ weightClass: 'LIGHTWEIGHT', isTitle: undefined });
  assert.equal(r.limit_basis, 'unsupported');
  assert.equal(r.applicable_limit_lbs, null);
  assert.match(r.reason, /title status unknown/);
});

test('over_by is never produced without both operands', () => {
  /* A delta is arithmetic. Arithmetic with a missing operand is not a smaller
   * number, it is no number. */
  assert.equal(evaluateWeight({ officialWeightLbs: 158.5, applicableLimitLbs: null }).over_by_lbs, null);
  assert.equal(evaluateWeight({ officialWeightLbs: null, applicableLimitLbs: 156 }).over_by_lbs, null);
  assert.equal(evaluateWeight({ officialWeightLbs: null, applicableLimitLbs: null }).over_by_lbs, null);
});

test('a reported miss with no published weight is recorded as a miss with nothing invented', () => {
  const r = evaluateWeight({ officialWeightLbs: null, reportedMiss: true });
  assert.equal(r.result, 'missed_unmeasured', 'the miss is real');
  assert.equal(r.over_by_lbs, null, 'the arithmetic is not available');
  assert.equal(summaryLine({ fighter_name: 'Jane Doe', result: 'missed', official_weight_lbs: null, over_by_lbs: null }),
    'Jane Doe — MISSED WEIGHT (weight not published)');
});

test('a weight with no limit to judge it against is neither made nor missed', () => {
  /* Calling it "made" would be an assertion we cannot support; calling it
   * "missed" would be worse. */
  const r = evaluateWeight({ officialWeightLbs: 165.5, applicableLimitLbs: null });
  assert.equal(r.result, 'unjudged');
  assert.equal(r.over_by_lbs, null);
});

/* ================= title / non-title / catchweight ================= */

test('the non-title allowance is one pound, and a championship gets none', () => {
  const title = resolveLimit({ weightClass: 'LIGHTWEIGHT', isTitle: true });
  assert.equal(title.contracted_limit_lbs, 155);
  assert.equal(title.allowance_lbs, 0);
  assert.equal(title.applicable_limit_lbs, 155, 'a championship must be made on the number');

  const nonTitle = resolveLimit({ weightClass: 'LIGHTWEIGHT', isTitle: false });
  assert.equal(nonTitle.applicable_limit_lbs, 156);
  assert.equal(nonTitle.limit_basis, 'division_rule');
});

test('155.5 makes a non-title lightweight bout and misses the title version', () => {
  /* The exact pound that separates the two, which is why title status cannot
   * be assumed. */
  const nonTitle = evaluateWeight({ officialWeightLbs: 155.5, applicableLimitLbs: 156 });
  assert.equal(nonTitle.result, 'made');
  assert.equal(nonTitle.over_by_lbs, null);

  const title = evaluateWeight({ officialWeightLbs: 155.5, applicableLimitLbs: 155 });
  assert.equal(title.result, 'missed');
  assert.equal(title.over_by_lbs, 0.5);
});

test('heavyweight has no allowance, title or not', () => {
  assert.equal(allowanceFor('HEAVYWEIGHT', false), 0, '265 is a ceiling, not a division target');
  assert.equal(allowanceFor('HEAVYWEIGHT', true), 0);
  assert.equal(resolveLimit({ weightClass: 'HEAVYWEIGHT', isTitle: false }).applicable_limit_lbs, 265);
});

test('a sourced limit wins, and is used exactly as published', () => {
  /* A catchweight with a stated figure is fully supported even though its
   * division name is not — and no allowance is added on top, because that
   * would invent a limit nobody agreed to. */
  const r = resolveLimit({ weightClass: 'CATCHWEIGHT', isTitle: false, sourcedLimitLbs: 165 });
  assert.equal(r.limit_basis, 'sourced');
  assert.equal(r.applicable_limit_lbs, 165);
  assert.equal(r.allowance_lbs, 0);
  assert.equal(evaluateWeight({ officialWeightLbs: 166, applicableLimitLbs: r.applicable_limit_lbs }).over_by_lbs, 1);
});

test('every standard division has a limit and every limit is plausible', () => {
  for (const [wc, lbs] of Object.entries(DIVISION_LIMIT_LBS)) {
    assert.ok(lbs > 100 && lbs <= 265, `${wc} limit ${lbs} is out of range`);
    assert.ok(!UNSUPPORTED_CLASSES.has(wc), `${wc} cannot be both a division and unsupported`);
    assert.equal(resolveLimit({ weightClass: wc, isTitle: true }).limit_basis, 'division_rule');
  }
});

/* ================= made / missed ================= */

test('on the limit is made, a tenth over is missed', () => {
  assert.equal(evaluateWeight({ officialWeightLbs: 156, applicableLimitLbs: 156 }).result, 'made');
  const over = evaluateWeight({ officialWeightLbs: 156.1, applicableLimitLbs: 156 });
  assert.equal(over.result, 'missed');
  assert.equal(over.over_by_lbs, 0.1, 'and float dust must not turn 0.1 into 0.09999999999999432');
});

test('the delta is exact at the awkward decimals a scale actually produces', () => {
  assert.equal(evaluateWeight({ officialWeightLbs: 158.5, applicableLimitLbs: 156 }).over_by_lbs, 2.5);
  assert.equal(evaluateWeight({ officialWeightLbs: 126.5, applicableLimitLbs: 126 }).over_by_lbs, 0.5);
  assert.equal(evaluateWeight({ officialWeightLbs: 205.2, applicableLimitLbs: 205 }).over_by_lbs, 0.2);
});

/* ================= idempotent replay ================= */

test('the same reading fingerprints identically however many times it is read', () => {
  const row = {
    event_id: 'e1', fighter_id: 'f1', attempt_number: 1,
    official_weight_lbs: 155.5, result: 'made', source_url: 'https://www.ufc.com/weigh-ins',
  };
  const a = fingerprintOf(row, sha256);
  const b = fingerprintOf({ ...row, detected_at: '2026-09-11T09:41:00Z' }, sha256);
  assert.equal(a, b, 'detection time must not be part of identity, or every pass looks like news');
  assert.equal(fingerprintOf({ ...row, official_weight_lbs: 155.5000001 }, sha256), a, 'nor float dust');
  assert.equal(fingerprintOf({ ...row, source_url: 'https://www.ufc.com/weigh-ins?utm=x#top' }, sha256), a,
    'tracking parameters are not identity');
});

test('a different reading, attempt, result or publisher is a different record', () => {
  const base = { event_id: 'e1', fighter_id: 'f1', attempt_number: 1, official_weight_lbs: 155.5, result: 'made', source_url: 'https://a.invalid/x' };
  const fp = fingerprintOf(base, sha256);
  for (const [label, patch] of Object.entries({
    'a corrected weight': { official_weight_lbs: 155.0 },
    'a second attempt': { attempt_number: 2 },
    'a different verdict': { result: 'missed' },
    'a second publisher': { source_url: 'https://b.invalid/y' },
    'a different fighter': { fighter_id: 'f2' },
    'a different event': { event_id: 'e2' },
  })) {
    assert.notEqual(fingerprintOf({ ...base, ...patch }, sha256), fp, `${label} must be its own record`);
  }
});

/* ================= corrections and projection ================= */

test('a correction wins the projection and the original is still there', () => {
  const first = { id: 'w1', event_id: 'e1', fighter_id: 'f1', attempt_number: 1, official_weight_lbs: 158.0, result: 'missed', source_kind: 'news', source_published_at: '2026-09-11T09:12:00Z' };
  const corrected = { id: 'w2', event_id: 'e1', fighter_id: 'f1', attempt_number: 1, official_weight_lbs: 158.5, result: 'missed', source_kind: 'official', source_published_at: '2026-09-11T09:20:00Z', supersedes_id: 'w1' };
  const current = projectCurrent([first, corrected]);
  assert.equal(current.length, 1, 'one fighter, one current reading');
  assert.equal(current[0].id, 'w2');
  assert.equal(current[0].official_weight_lbs, 158.5);
  /* Both rows remain in the input; nothing was mutated or dropped. */
  assert.equal(first.official_weight_lbs, 158.0, 'the earlier reading is untouched and still answerable');
});

test('a second trip to the scale supersedes the first regardless of clock skew', () => {
  const first = { id: 'w1', event_id: 'e1', fighter_id: 'f1', attempt_number: 1, official_weight_lbs: 158.5, result: 'missed', source_kind: 'official', source_published_at: '2026-09-11T09:20:00Z' };
  const second = { id: 'w2', event_id: 'e1', fighter_id: 'f1', attempt_number: 2, official_weight_lbs: 156.0, result: 'made', source_kind: 'news', source_published_at: '2026-09-11T09:15:00Z' };
  const current = projectCurrent([first, second]);
  assert.equal(current[0].attempt_number, 2, 'the later attempt is the result even if its report is stamped earlier');
  assert.equal(current[0].result, 'made');
});

test('an official source outranks a wire report at the same attempt', () => {
  const wire = { id: 'w1', event_id: 'e1', fighter_id: 'f1', attempt_number: 1, official_weight_lbs: 158.0, result: 'missed', source_kind: 'news', source_published_at: '2026-09-11T09:20:00Z' };
  const official = { id: 'w2', event_id: 'e1', fighter_id: 'f1', attempt_number: 1, official_weight_lbs: 158.5, result: 'missed', source_kind: 'official', source_published_at: '2026-09-11T09:12:00Z' };
  assert.equal(projectCurrent([wire, official])[0].source_kind, 'official');
  assert.ok(SOURCE_RANK.official > SOURCE_RANK.news);
  assert.ok(SOURCE_RANK.commission > SOURCE_RANK.news);
});

test('events are kept separate', () => {
  const rows = [
    { id: 'a', event_id: 'e1', fighter_id: 'f1', attempt_number: 1, result: 'made', official_weight_lbs: 156, source_kind: 'official', source_published_at: '2026-09-11T09:00:00Z' },
    { id: 'b', event_id: 'e2', fighter_id: 'f1', attempt_number: 1, result: 'missed', official_weight_lbs: 158, source_kind: 'official', source_published_at: '2026-10-11T09:00:00Z' },
  ];
  const current = projectCurrent(rows);
  assert.equal(current.length, 2, 'the same fighter at two events is two current readings, not one');
});

/* ================= the deterministic sentence ================= */

test('the summary line is built from stored fields and never from a model', () => {
  assert.equal(
    summaryLine({ fighter_name: 'Jane Doe', result: 'missed', official_weight_lbs: 158.5, over_by_lbs: 2.5 }),
    'Jane Doe — 158.5 lb — MISSED by 2.5 lb',
  );
  assert.equal(
    summaryLine({ fighter_name: 'Jane Doe', result: 'made', official_weight_lbs: 155.5 }),
    'Jane Doe — 155.5 lb — made weight',
  );
  assert.equal(
    summaryLine({ fighter_name: 'Jane Doe', result: 'missed', official_weight_lbs: 158.5, over_by_lbs: null }),
    'Jane Doe — 158.5 lb — MISSED (contracted limit not published)',
    'a miss without a supported limit says so rather than omitting the caveat',
  );
  assert.equal(summaryLine({ fighter_name: 'Jane Doe', result: 'pending' }), 'Jane Doe — has not weighed in yet');
  assert.equal(summaryLine({ fighter_name: 'Jane Doe', result: 'withdrawn' }), 'Jane Doe — withdrew before the scale');
});
