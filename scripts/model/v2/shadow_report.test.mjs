// node --test scripts/model/v2/shadow_report.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, bootstrap, ece, GATE } from './shadow_report.mjs';

const pol = (prior, five, v1pub, v2p) => ({ sample: { min_prior_bouts: prior }, context: { five_round_non_title: five }, v1: { publish_v1_rule: v1pub }, v2: { publish_v1_rule_55: v2p >= 0.55, publish_primary_60: v2p >= 0.6, publish_variant_tiers: v2p >= 0.65 } });
function synth(n, v2Better) {
  let s = 3;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, (_, i) => {
    const truth = 0.3 + 0.4 * rnd();
    const y = rnd() < truth ? 1 : 0;
    const v1 = Math.min(0.95, Math.max(0.05, truth + (rnd() - 0.5) * 0.3));
    const v2 = v2Better ? Math.min(0.95, Math.max(0.05, truth + (rnd() - 0.5) * 0.05)) : v1;
    return { event_id: `e${Math.floor(i / 10)}`, fighter_a_id: 'a', v1, v2, y, policy: pol(1 + (i % 9), i % 13 === 0, Math.max(v1, 1 - v1) >= 0.55, Math.max(v2, 1 - v2)), market: null };
  });
}

test('fewer than 150 pairs is INSUFFICIENT whatever the numbers say', () => {
  const r = evaluate(synth(149, true));
  assert.match(r.verdict, /INSUFFICIENT EVIDENCE \(149\/150/);
  assert.equal(r.gate.pairs.pass, false);
});

test('a clearly better V2 shows negative paired dBrier with the CI below zero; identical models show zero', () => {
  const better = evaluate(synth(600, true));
  assert.ok(better.overall.d_brier.mean < 0);
  assert.ok(better.overall.d_brier.ci95[1] < 0);
  assert.equal(better.gate.d_brier_negative.pass, true);
  const same = evaluate(synth(300, false));
  assert.equal(same.overall.d_brier.mean, 0);
  assert.equal(same.gate.d_brier_negative.pass, false, 'a tie never passes');
});

test('policy coverage counts each frozen rule separately and reports slices', () => {
  const r = evaluate(synth(200, true));
  assert.equal(r.policies.length, 4);
  assert.ok(r.policies.every((p) => p.published <= 200));
  assert.ok(r.policies[2].published <= r.policies[1].published, '60% publishes no more than 55%');
  assert.deepEqual(Object.keys(r.slices.by_prior_bouts), ['1-2', '3-5', '6+']);
  assert.ok(r.slices.five_round_non_title.n > 0);
  assert.equal(GATE.min_pairs, 150);
  assert.equal(GATE.max_ece, 0.03);
});

test('bootstrap is deterministic and ece is 0 for perfectly calibrated bins', () => {
  const rows = synth(100, true);
  assert.deepEqual(bootstrap(rows, (r) => r.v2 - r.v1), bootstrap(rows, (r) => r.v2 - r.v1));
  assert.equal(ece([{ v: 0.5, y: 1 }, { v: 0.5, y: 0 }], 'v'), 0);
});
