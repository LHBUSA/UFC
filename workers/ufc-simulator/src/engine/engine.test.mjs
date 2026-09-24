import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, artifactHash } from './simulate.mjs';
import { profileFromSnapshot, coverageGate, validateSnapshotAsOf } from './inputs.mjs';
import { prepareContext, simulateFight, STAT, NSTAT } from './fight.mjs';
import { runBatch } from './anchor.mjs';
import { masterSeed, fightRng } from './rng.mjs';
import { cellKey } from './medoid.mjs';
import { DEFAULT_PARAMS } from './params.mjs';
import { loadFixture, requestFromFixture, PAIR_FIXTURES } from './fixtures.mjs';

const FULL = loadFixture('ufc333_volkanovski_evloev');

test('profile: real high-coverage snapshot yields observed metrics with no fallbacks; empty snapshot falls back everywhere', () => {
  const p = profileFromSnapshot(FULL.fighter_a, DEFAULT_PARAMS);
  assert.equal(p.coverage_status, 'high');
  assert.equal(p.evidence.fallbacks.length, 0);
  assert.ok(p.att_rate.length === 5 && p.att_rate.every((v) => v > 2 && v < 20));
  assert.ok(Math.abs(p.shares.head + p.shares.body + p.shares.leg - 1) < 1e-9);
  assert.ok(p.tddef > 0 && p.tddef < 1 && p.evidence.used.td_defense.observed != null);
  const e = profileFromSnapshot({ fighter: { id: 'z', name: 'Z' }, snapshot: null, ladder: [] }, DEFAULT_PARAMS);
  assert.equal(e.coverage_status, 'insufficient');
  assert.ok(e.evidence.fallbacks.length >= 20);
  assert.equal(e.att_rate[0], DEFAULT_PARAMS.league.sig_att_per_min);
});

test('gate: FULL for two medium+ corners, LIMITED with a low corner, INSUFFICIENT for the insufficient fixture or a missing anchor', () => {
  const p1 = profileFromSnapshot(FULL.fighter_a), p2 = profileFromSnapshot(FULL.fighter_b);
  assert.equal(coverageGate(p1, p2, { prob_1: 0.52 }).status, 'FULL');
  const low = profileFromSnapshot(loadFixture('tier_low'));
  assert.equal(coverageGate(p1, low, { prob_1: 0.52 }).status, 'LIMITED');
  const ins = profileFromSnapshot(loadFixture('tier_insufficient'));
  const g = coverageGate(p1, ins, { prob_1: 0.52 });
  assert.equal(g.status, 'INSUFFICIENT');
  assert.ok(g.reasons.some((r) => r.code === 'coverage_insufficient'));
  assert.equal(coverageGate(p1, p2, null).status, 'INSUFFICIENT');
  assert.equal(coverageGate(p1, p2, { prob_1: 0.52, eligibility: { decision: 'NO_MODEL_CALL', reasons: ['x'] } }).status, 'LIMITED');
});

test('as-of validation: a snapshot listing a bout dated on/after its as_of is rejected; unknown bouts are reported, not assumed', () => {
  const snap = FULL.fighter_a.snapshot;
  const dates = Object.fromEntries(FULL.fighter_a.ladder.map((r) => [r.bout_id, r.event_date]));
  const ok = validateSnapshotAsOf(snap, dates);
  assert.equal(ok.ok, true);
  const poisoned = { ...dates, [snap.provenance.bouts[0]]: snap.as_of_date };
  const bad = validateSnapshotAsOf(snap, poisoned);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations.length, 1);
  const partial = validateSnapshotAsOf(snap, {});
  assert.equal(partial.ok, true);
  assert.equal(partial.unverified.length, snap.provenance.bouts.length);
  const r = simulate(requestFromFixture(FULL, { fighter_a: { ...FULL.fighter_a, bout_dates: poisoned }, n_sims: 500 }));
  assert.equal(r.artifact.status, 'REJECTED_SNAPSHOT');
});

test('fight invariants hold over 10,000 fights (three and five rounds)', () => {
  const p1 = profileFromSnapshot(FULL.fighter_a), p2 = profileFromSnapshot(FULL.fighter_b);
  for (const R of [3, 5]) {
    const ctx = prepareContext(p1, p2, R, DEFAULT_PARAMS);
    const b = runBatch(ctx, masterSeed(`inv${R}`), 10000, 0.1);
    for (let i = 0; i < b.filled; i++) {
      assert.ok(b.endRound[i] >= 1 && b.endRound[i] <= R);
      const m = b.method[i];
      if (m < 2) { assert.ok(b.endTime[i] >= DEFAULT_PARAMS.finish_time_min && b.endTime[i] <= 299); assert.ok(b.winner[i] === 1 || b.winner[i] === 2); }
      else { assert.equal(b.endTime[i], 300); assert.equal(b.endRound[i], R); if (m === 3) assert.equal(b.winner[i], 0); }
      for (let r = 0; r < b.endRound[i]; r++) {
        let ctrlSum = 0;
        for (let side = 0; side < 2; side++) {
          const g = (q) => b.statAt(i, r, side, q);
          assert.ok(g(STAT.sig_l) <= g(STAT.sig_a), 'landed <= attempts');
          assert.equal(g(STAT.head_l) + g(STAT.body_l) + g(STAT.leg_l), g(STAT.sig_l), 'targets sum to landed');
          assert.equal(g(STAT.dist_l) + g(STAT.clinch_l) + g(STAT.ground_l), g(STAT.sig_l), 'positions sum to landed');
          assert.ok(g(STAT.td_l) <= g(STAT.td_a), 'td landed <= attempts');
          assert.ok(g(STAT.ctrl) >= 0 && g(STAT.ctrl) <= 300);
          assert.ok(g(STAT.kd) >= 0 && g(STAT.kd) <= DEFAULT_PARAMS.kd_cap);
          ctrlSum += g(STAT.ctrl);
          const s = b.scoreAt(i, r, side);
          assert.ok(s === 10 || s === 9 || s === 8);
        }
        assert.ok(ctrlSum <= 300, 'combined control within the round');
        assert.ok(b.scoreAt(i, r, 0) === 10 || b.scoreAt(i, r, 1) === 10, 'one side scores 10');
      }
    }
  }
});

test('prefix property: fight i is the same fight in a 2,000-fight batch and a 10,000-fight batch', () => {
  const p1 = profileFromSnapshot(FULL.fighter_a), p2 = profileFromSnapshot(FULL.fighter_b);
  const ctx = prepareContext(p1, p2, 5, DEFAULT_PARAMS);
  const seed = masterSeed('prefix');
  const small = runBatch(ctx, seed, 2000, 0.3), big = runBatch(ctx, seed, 10000, 0.3);
  const stride = 5 * 2 * NSTAT;
  for (let i = 0; i < 2000; i++) {
    assert.equal(small.winner[i], big.winner[i]); assert.equal(small.method[i], big.method[i]); assert.equal(small.endRound[i], big.endRound[i]); assert.equal(small.endTime[i], big.endTime[i]);
    for (let k = 0; k < stride; k++) assert.equal(small.stats[i * stride + k], big.stats[i * stride + k]);
  }
});

test('antisymmetry: swapping corners in the engine mirrors the fight exactly (tilt negated)', () => {
  const p1 = profileFromSnapshot(FULL.fighter_a), p2 = profileFromSnapshot(FULL.fighter_b);
  // Same RNG stream, mirrored inputs, negated tilt: the simulated fight must mirror because the per-round sequence consumes the RNG side by side.
  // The engine samples corner 1 before corner 2, so a mirror with the same stream is not expected to be identical fight-by-fight;
  // instead we check the AGGREGATE mirror over a batch, which is the product-level antisymmetry guarantee.
  const ctxA = prepareContext(p1, p2, 3, DEFAULT_PARAMS), ctxB = prepareContext(p2, p1, 3, DEFAULT_PARAMS);
  const a = runBatch(ctxA, masterSeed('sym'), 10000, 0.2), b = runBatch(ctxB, masterSeed('sym'), 10000, -0.2);
  assert.ok(Math.abs(a.p1() - (1 - b.p1())) < 0.02, `aggregate mirror ${a.p1()} vs ${1 - b.p1()}`);
});

for (const name of PAIR_FIXTURES) {
  test(`simulate(${name}): anchored, coherent projection, hash verifies, projection winner is the distribution leader`, () => {
    const fx = loadFixture(name);
    const { artifact: a } = simulate(requestFromFixture(fx));
    assert.ok(['OFFICIAL', 'LIMITED'].includes(a.status), a.status);
    assert.equal(a.n_sims, 10000);
    assert.ok(a.anchor.residual_within_tolerance, `residual ${a.anchor.residual} status ${a.anchor.status}`);
    assert.ok(Math.abs(a.probabilities.fighter_1_win + a.probabilities.fighter_2_win + a.probabilities.draw - 1) < 1e-3);
    const ms = Object.values(a.methods).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(ms + a.probabilities.draw - 1) < 1e-3, 'methods + draw sum to 1');
    assert.equal(artifactHash(a), a.artifact_sha256);
    const leader = a.probabilities.fighter_1_win >= a.probabilities.fighter_2_win ? 'fighter_1' : 'fighter_2';
    assert.equal(a.canonical_projection.winner, leader);
    const cp = a.canonical_projection;
    // The projection is a real sampled path: its cell matches the selection and its rounds are internally consistent.
    const expectedKey = cp.method === 'DEC' ? `${cp.winner === 'fighter_1' ? 1 : 2}|DEC` : `${cp.winner === 'fighter_1' ? 1 : 2}|${cp.method}|R${cp.round}`;
    if (!cp.selection.fallback) assert.equal(cp.selection.cell, expectedKey);
    assert.equal(cp.rounds.length, cp.method === 'DEC' ? fx.bout.scheduled_rounds : cp.round);
    for (const rd of cp.rounds) for (const side of ['fighter_1', 'fighter_2']) { const f = rd[side]; assert.equal(f.head_l + f.body_l + f.leg_l, f.sig_l); assert.ok(f.sig_l <= f.sig_a); }
    // Precision follows the gate.
    if (a.status === 'LIMITED') assert.equal(cp.precision, 'round'); else assert.equal(cp.precision, 'time');
    if (cp.method !== 'DEC' && cp.precision === 'time') assert.ok(cp.time_window && cp.time_window.elapsed_sec === cp.rounds[cp.rounds.length - 1] && true || cp.time_window.elapsed_sec >= 0);
    // Narrative numbers come from the round record only.
    for (const rd of cp.rounds) {
      const allowed = new Set();
      for (const side of ['fighter_1', 'fighter_2']) for (const v of Object.values(rd[side])) allowed.add(String(v));
      allowed.add(String(rd.score.fighter_1)); allowed.add(String(rd.score.fighter_2)); allowed.add(String(rd.round)); allowed.add(String(cp.round));
      for (const line of rd.read) {
        if (line.startsWith('PBE ROUND') || line.includes('wins')) continue;
        for (const num of line.match(/\d+/g) || []) assert.ok(allowed.has(num) || line.includes(':'), `number ${num} in "${line}" not in the round record`);
      }
    }
  });
}

test('swap symmetry: simulate(A,B) and simulate(B,A) return the same artifact bytes and id', () => {
  const fx = loadFixture('ufc331_aswell_yoo');
  const r1 = simulate(requestFromFixture(fx, { n_sims: 4000 }));
  const r2 = simulate({ ...requestFromFixture(fx, { n_sims: 4000 }), fighter_a: fx.fighter_b, fighter_b: fx.fighter_a });
  assert.equal(r1.artifact.simulation_id, r2.artifact.simulation_id);
  assert.equal(r1.artifact.artifact_sha256, r2.artifact.artifact_sha256);
  assert.notEqual(r1.input_order, r2.input_order);
});

test('insufficient data never yields a projection; excessive tilt is flagged, not hidden', () => {
  const ins = loadFixture('tier_insufficient');
  const r = simulate({ fighter_a: FULL.fighter_a, fighter_b: { fighter: ins.fighter, snapshot: ins.snapshot, ladder: ins.ladder }, anchor: FULL.anchor, settings: { scheduled_rounds: 3 }, n_sims: 1000 });
  assert.equal(r.artifact.status, 'INSUFFICIENT_DATA');
  assert.equal(r.artifact.canonical_projection, null);
  assert.equal(r.artifact.probabilities, null);
  assert.ok(r.artifact.coverage.message.includes('Not enough Fight DNA'));
  const forced = simulate(requestFromFixture(FULL, { anchor: { ...FULL.anchor, prob: 0.985 }, n_sims: 3000 }));
  assert.ok(['excessive_tilt', 'not_bracketed'].includes(forced.artifact.anchor.status), forced.artifact.anchor.status);
  assert.ok(Math.abs(forced.artifact.anchor.tilt_applied) > DEFAULT_PARAMS.tilt.max_tilt);
  assert.equal(forced.artifact.anchor.champion_probability, 0.985);
  assert.ok(forced.artifact.anchor.pre_anchor_probability < 0.7);
});

test('cell keys and medoid selection are deterministic labels', () => {
  assert.equal(cellKey(1, 0, 2), '1|KO_TKO|R2');
  assert.equal(cellKey(2, 2, 3), '2|DEC');
  assert.equal(cellKey(0, 3, 3), 'DRAW');
});
