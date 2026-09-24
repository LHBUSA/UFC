// Orchestrator: inputs -> identity -> gate -> anchor -> 10k distribution ->
// medoid projection -> normalised, hashed artifact.
//
// Pure: no I/O, no clock inside the hashed artifact. The envelope carries the
// wall-clock and runtime for the receipt; the artifact hash covers only
// content.

import { DEFAULT_PARAMS, SIMULATOR_VERSION, SIMULATOR_FAMILY, DNA_DEFINITION_VERSION } from './params.mjs';
import { profileFromSnapshot, validateSnapshotAsOf, coverageGate } from './inputs.mjs';
import { buildIdentity, simulationId, engineSpecSha256, inputsDigest, canonicalOrder } from './fingerprint.mjs';
import { masterSeed } from './rng.mjs';
import { prepareContext } from './fight.mjs';
import { runBatch, calibrateTilt } from './anchor.mjs';
import { summarize } from './aggregate.mjs';
import { modalCell, medoidIndex, extractFight } from './medoid.mjs';
import { roundRead, roundFacts, endingLine, timeWindow } from './narrative.mjs';
import { canonicalJson, round4 } from './canonical.mjs';
import { sha256Hex } from './sha256.mjs';

/**
 * @param {object} req
 * @param {{fighter:object, snapshot:object|null, ladder?:object[], bout_dates?:Record<string,string>}} req.fighter_a
 * @param {{fighter:object, snapshot:object|null, ladder?:object[], bout_dates?:Record<string,string>}} req.fighter_b
 * @param {{model_version:string, model_spec_sha256:string, prob:number, prob_for:string, eligibility?:object}} req.anchor  champion P(prob_for wins)
 * @param {{scheduled_rounds:number, weight_class?:string, is_title?:boolean, is_womens?:boolean}} req.settings
 * @param {number} [req.n_sims]
 * @param {{params?:object, simulator_version?:string, now?:()=>string, runtime?:string}} [opts]
 */
export function simulate(req, opts = {}) {
  const params = opts.params || DEFAULT_PARAMS;
  const simulatorVersion = opts.simulator_version || SIMULATOR_VERSION;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const nSims = req.n_sims || 10000;
  const R = req.settings?.scheduled_rounds;
  if (!(R >= 1 && R <= params.max_rounds)) throw new Error('settings.scheduled_rounds must be 1..5');

  // Canonical corners by UUID.
  const [id1] = canonicalOrder(req.fighter_a.fighter.id, req.fighter_b.fighter.id);
  const in1 = req.fighter_a.fighter.id === id1 ? req.fighter_a : req.fighter_b;
  const in2 = in1 === req.fighter_a ? req.fighter_b : req.fighter_a;
  const inputOrder = req.fighter_a.fighter.id === id1 ? 'a_is_fighter_1' : 'b_is_fighter_1';

  // Exclusive as-of check on both snapshots (dates from the ladder rows plus anything the caller resolved).
  const datesOf = (inp) => {
    const m = new Map();
    for (const row of inp.ladder || []) if (row?.bout_id && row?.event_date) m.set(row.bout_id, row.event_date);
    for (const [k, v] of Object.entries(inp.bout_dates || {})) m.set(k, v); // caller-resolved dates win
    return m;
  };
  const asOfChecks = [validateSnapshotAsOf(in1.snapshot, datesOf(in1)), validateSnapshotAsOf(in2.snapshot, datesOf(in2))];
  const rejected = asOfChecks.map((c, i) => ({ fighter: i === 0 ? 'fighter_1' : 'fighter_2', ...c })).filter((c) => c.violations.length);
  if (rejected.length) {
    return { input_order: inputOrder, artifact: { status: 'REJECTED_SNAPSHOT', simulator_version: simulatorVersion, reasons: rejected.map((r) => ({ fighter: r.fighter, code: 'snapshot_contains_bout_on_or_after_as_of', violations: r.violations })), message: 'A Fight DNA snapshot contains a bout dated on or after its as-of date. Resolve the prior valid snapshot and retry.' }, envelope: envelope(opts, t0) };
  }

  const p1 = profileFromSnapshot(in1, params);
  const p2 = profileFromSnapshot(in2, params);

  // Champion anchor mapped to corner 1.
  let anchorProb1 = null;
  if (req.anchor && Number.isFinite(req.anchor.prob)) {
    if (req.anchor.prob_for === id1) anchorProb1 = req.anchor.prob;
    else if (req.anchor.prob_for === in2.fighter.id) anchorProb1 = 1 - req.anchor.prob;
  }
  const anchorIn = anchorProb1 == null ? null : { prob_1: anchorProb1, eligibility: req.anchor.eligibility || null };

  const engineSpec = engineSpecSha256(params, simulatorVersion);
  const identity = buildIdentity({
    simulator_version: simulatorVersion, engine_spec_sha256: engineSpec,
    model_version: req.anchor?.model_version || null, model_spec_sha256: req.anchor?.model_spec_sha256 || null,
    fighter_1_id: id1, fighter_1_as_of: p1.as_of, fighter_2_id: in2.fighter.id, fighter_2_as_of: p2.as_of,
    scheduled_rounds: R, scenario: req.settings, n_sims: nSims,
  });
  const simId = simulationId(identity);
  const inputsSha = inputsDigest({ f1: { snapshot: in1.snapshot, fighter: in1.fighter, td_defense: p1.evidence.used.td_defense }, f2: { snapshot: in2.snapshot, fighter: in2.fighter, td_defense: p2.evidence.used.td_defense }, anchor: anchorProb1 == null ? null : round4(anchorProb1) });

  const fighters = {
    fighter_1: fighterCard(p1), fighter_2: fighterCard(p2),
  };
  const coverage = {
    fighter_1: coverageCard(p1), fighter_2: coverageCard(p2),
  };
  const gate = coverageGate(p1, p2, anchorIn, params);
  const receipt = {
    simulation_id: simId, simulator_family: SIMULATOR_FAMILY, simulator_version: simulatorVersion, engine_spec_sha256: engineSpec,
    model_version: identity.model_version, model_spec_sha256: identity.model_spec_sha256,
    dna_definition_version: DNA_DEFINITION_VERSION, generated_from_as_of: { fighter_1: p1.as_of, fighter_2: p2.as_of, data_through: p1.as_of && p2.as_of ? (p1.as_of < p2.as_of ? p1.as_of : p2.as_of) : null },
    scheduled_rounds: R, scenario: identity.scenario, n_sims: nSims, inputs_sha256: inputsSha,
  };

  if (gate.status === 'INSUFFICIENT') {
    const artifact = { status: 'INSUFFICIENT_DATA', ...receipt, fighters, coverage: { ...coverage, gate: gate.status, reasons: gate.reasons, message: gate.message }, probabilities: null, methods: null, finish_distribution: null, canonical_projection: null, evidence: evidenceBlock(p1, p2), anchor: anchorIn ? { champion_probability: round4(anchorIn.prob_1) } : null };
    return finish(artifact, opts, t0, inputOrder);
  }

  // Simulation.
  const ctx = prepareContext(p1, p2, R, params);
  const seed = masterSeed(simId);
  const pre = runBatch(ctx, seed, nSims, 0);
  const preP1 = pre.p1();
  const cal = calibrateTilt(ctx, seed, anchorIn.prob_1, params);
  const final = cal.tilt === 0 ? pre : runBatch(ctx, seed, nSims, cal.tilt);
  const postP1 = final.p1();
  const anchor = {
    pre_anchor_probability: round4(preP1), champion_probability: round4(anchorIn.prob_1), post_anchor_probability: round4(postP1),
    tilt_applied: cal.tilt, status: cal.status, residual: round4(postP1 - anchorIn.prob_1),
    residual_within_tolerance: Math.abs(postP1 - anchorIn.prob_1) <= params.tilt.residual_tolerance,
    max_tilt: params.tilt.max_tilt, iterations: cal.iterations, calibration_sims: cal.calibration_sims, trace: cal.trace,
    eligibility: anchorIn.eligibility,
  };
  const summary = summarize(final);

  // Official projection: winner = distribution leader, then modal cell for that winner, then medoid.
  const leader = summary.probabilities.fighter_1_win >= summary.probabilities.fighter_2_win ? 1 : 2;
  const cell = modalCell(final, leader);
  const med = medoidIndex(final, cell, params.gate.medoid_min_cell);
  const fight = extractFight(final, med.index);
  const names = [p1.name, p2.name];
  const precision = gate.status === 'FULL' ? 'time' : 'round';
  const ending = endingLine(fight, names, precision);
  const projection = {
    winner: fight.winner === 1 ? 'fighter_1' : 'fighter_2', winner_id: fight.winner === 1 ? p1.id : p2.id, winner_name: names[fight.winner - 1],
    method: fight.method, round: fight.method === 'DEC' ? null : fight.end_round,
    time_window: fight.method === 'DEC' || precision === 'round' ? null : { bucket: timeWindow(fight.end_time_sec, params.round_seconds), elapsed_sec: fight.end_time_sec },
    precision,
    selection: { rule: 'winner_then_method_then_modal_round_then_medoid', cell: cell.key, cell_share: round4(cell.share), cell_size: cell.count, method_conditional: round4(cell.method_conditional), medoid_fight_index: med.index, medoid_distance: med.distance, fallback: med.fallback, top_cells: cell.cells.slice(0, 6) },
    rounds: fight.rounds.map((rd, i) => ({ ...rd, facts: roundFacts(rd, names), read: roundRead(rd, names, i === fight.rounds.length - 1 ? ending : null) })),
    ending_line: ending,
  };

  const artifact = {
    status: gate.status === 'FULL' ? 'OFFICIAL' : 'LIMITED',
    ...receipt,
    fighters,
    probabilities: summary.probabilities,
    methods: summary.methods,
    finish_distribution: summary.finish_distribution,
    finish_time: summary.finish_time,
    distribution: { fight_totals: summary.fight_totals, per_round: summary.per_round },
    canonical_projection: projection,
    anchor,
    coverage: { ...coverage, gate: gate.status, reasons: gate.reasons, message: gate.message },
    confidence: { tier: gate.status, calibration: 'uncalibrated_priors', note: 'Engine parameters are documented priors until Phase 3 walk-forward calibration registers pbe-fight-simulator-v1.0.' },
    evidence: evidenceBlock(p1, p2),
  };
  return finish(artifact, opts, t0, inputOrder);
}

function fighterCard(p) {
  return { id: p.id, name: p.name, stance: p.stance, reach_in: p.reach_in, height_in: p.height_in, snapshot_as_of: p.as_of, coverage_status: p.coverage_status };
}
function coverageCard(p) {
  return { coverage_status: p.coverage_status, sample_bouts: p.sample.bouts, sample_stat_bouts: p.sample.stat_bouts, sample_rounds: p.sample.rounds, sample_seconds: p.sample.seconds, metric_availability: p.availability, fallbacks: p.evidence.fallbacks.length };
}
function evidenceBlock(p1, p2) {
  const pack = (p) => ({
    id: p.id, snapshot_as_of: p.as_of, builder: p.evidence.snapshot_provenance, definition_version: p.evidence.definition_version,
    metrics: Object.fromEntries(Object.entries(p.evidence.used).map(([k, v]) => [k, { observed: round4(v.observed), used: round4(v.used), prior: round4(v.prior), weight: round4(v.weight), confidence: v.confidence || null, sample_bouts: v.sample_bouts ?? null, sample_rounds: v.sample_rounds ?? null }])),
    fallbacks: p.evidence.fallbacks.map((f) => ({ metric: f.metric, reason: f.reason, prior: round4(f.prior) })),
    round_pace_used: p.att_rate.map(round4),
  });
  return { fighter_1: pack(p1), fighter_2: pack(p2), damage_proxy: 'cumulative significant strikes absorbed plus knockdowns taken (no licensed damage measure exists)', position_share_basis: 'attack share by position from significant strike counts (no position-time data exists)' };
}
function envelope(opts, t0) {
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { generated_at: (opts.now || (() => new Date().toISOString()))(), runtime: opts.runtime || 'unknown', elapsed_ms: Math.round(t1 - t0) };
}
function finish(artifact, opts, t0, inputOrder) {
  const body = canonicalJson(artifact);
  const hashed = { ...artifact, artifact_sha256: sha256Hex(body) };
  // input_order is presentation only (which caller corner is fighter_1); it stays outside the hashed artifact.
  return { artifact: hashed, envelope: envelope(opts, t0), input_order: inputOrder };
}

export function artifactHash(artifact) {
  const { artifact_sha256, ...rest } = artifact;
  return sha256Hex(canonicalJson(rest));
}
