/* Append-only correction semantics.
 *
 * THE BUG THIS EXISTS TO PREVENT EVER RETURNING
 *
 * A checkpoint is captured once per (bout, checkpoint). A row written outside
 * its window is therefore not merely wrong -- it permanently SUPPRESSES the
 * genuine capture, and the table is append-only so it cannot be edited away.
 * That happened: 13 rows were written labelled t_minus_24h roughly 52 hours
 * before the fight.
 *
 * The fix is that a correction is another ROW, and idempotence reads the
 * EFFECTIVE ledger rather than the raw one. The two properties below are what
 * make that work, and breaking either one silently restores the suppression:
 *
 *   1. an invalidated row must not count as captured
 *   2. the invalidated row must still be readable, because a ledger that
 *      forgets its own mistakes is not an audit record
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionLedger, buildCorrectionRow, CORRECTION_VERSION } from '../../../scripts/ledger/capture_fight_state.mjs';

const BOUT = 'b1';
const bad = {
  id: 'row-bad', bout_id: BOUT, event_id: 'e1', checkpoint: 't_minus_24h',
  captured_at: '2026-09-10T13:55:00Z', scheduled_start: '2026-09-12T18:00:00Z', event_date: '2026-09-12',
  provenance: { builder: 'ufc-fight-state@1' },
};
const good = {
  id: 'row-good', bout_id: BOUT, event_id: 'e1', checkpoint: 't_minus_72h',
  captured_at: '2026-09-09T18:00:00Z', provenance: { builder: 'ufc-fight-state@1' },
};

test('an uncorrected ledger is entirely effective', () => {
  const p = partitionLedger([bad, good]);
  assert.equal(p.effective.length, 2);
  assert.equal(p.invalidated.length, 0);
  assert.equal(p.corrections.length, 0);
});

test('a correction removes its target from the effective ledger but not from the raw one', () => {
  const correction = { id: 'row-corr', ...buildCorrectionRow(bad, { reason: 'premature checkpoint replay outside capture window' }) };
  const raw = [bad, good, correction];
  const p = partitionLedger(raw);

  assert.equal(p.effective.length, 1, 'only the good capture is authoritative');
  assert.equal(p.effective[0].id, 'row-good');
  assert.equal(p.invalidated.length, 1, 'the bad row is still present, marked invalidated');
  assert.equal(p.invalidated[0].id, 'row-bad');
  assert.equal(p.corrections.length, 1);
  assert.ok(p.invalidatedIds.has('row-bad'));

  /* The property that actually matters: the suppressing key is gone. */
  const have = new Set(p.effective.map((r) => `${r.bout_id}:${r.checkpoint}`));
  assert.equal(have.has(`${BOUT}:t_minus_24h`), false,
    'an invalidated checkpoint must NOT count as already captured, or the genuine capture stays suppressed for ever');
  assert.equal(have.has(`${BOUT}:t_minus_72h`), true, 'a valid capture is unaffected');
});

test('a correction row is never itself a capture', () => {
  const correction = { id: 'row-corr', ...buildCorrectionRow(bad, { reason: 'x' }) };
  const p = partitionLedger([correction]);
  assert.equal(p.effective.length, 0, 'a correction must not become an authoritative checkpoint');
  assert.equal(correction.checkpoint, 'ad_hoc',
    'corrections ride ad_hoc, which is exempt from the once-only rule, so a correction can never suppress anything');
});

test('a correction carries the audit trail a reader needs', () => {
  const c = buildCorrectionRow(bad, { reason: 'premature checkpoint replay outside capture window' }).provenance.correction;
  assert.equal(c.invalidates_ledger_id, 'row-bad');
  assert.equal(c.invalidates_checkpoint, 't_minus_24h');
  assert.equal(c.invalidates_captured_at, '2026-09-10T13:55:00Z');
  assert.equal(c.correction_version, CORRECTION_VERSION);
  assert.ok(c.reason.length > 0, 'a correction must say why');
  assert.ok(c.corrected_at, 'and when');
});

test('corrections do not cascade: correcting one row leaves other bouts alone', () => {
  const otherBout = { ...bad, id: 'row-other', bout_id: 'b2' };
  const correction = { id: 'row-corr', ...buildCorrectionRow(bad, { reason: 'x' }) };
  const p = partitionLedger([bad, otherBout, correction]);
  const have = new Set(p.effective.map((r) => `${r.bout_id}:${r.checkpoint}`));
  assert.equal(have.has('b1:t_minus_24h'), false);
  assert.equal(have.has('b2:t_minus_24h'), true, 'a correction names one row and invalidates only that row');
});
