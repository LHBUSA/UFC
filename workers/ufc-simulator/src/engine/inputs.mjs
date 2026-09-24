// Fighter profiles from Fight DNA snapshot rows (definition_version 1) and the
// per-bout ladder rows, plus the coverage gate.
//
// Rules:
//   - Nothing is invented. A missing metric is shrunk toward the documented
//     league prior with an explicit weight and the fallback is RECORDED in
//     `evidence.fallbacks`; enough fallbacks and the gate refuses.
//   - Snapshot semantics are exclusive: a snapshot dated D may not contain a
//     bout dated >= D. `validateSnapshotAsOf` enforces that for every bout
//     whose date the caller knows, and reports the ones it cannot verify.

import { DEFAULT_PARAMS, TIER_RANK } from './params.mjs';
import { clamp } from './canonical.mjs';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function metricObj(snapshot, key) {
  const m = snapshot?.metrics?.[key];
  if (!m || typeof m !== 'object') return null;
  return { value: num(m.value), confidence: m.confidence || 'insufficient', sample_bouts: num(m.sample_bouts) || 0, sample_rounds: num(m.sample_rounds) || 0, sample_seconds: num(m.sample_seconds) || 0 };
}

/** Shrink an observed rate toward a prior: weight of evidence in rounds (300 s) vs `shrinkRounds` of prior. */
function shrink(observed, prior, evidenceRounds, shrinkRounds) {
  if (observed == null) return { used: prior, weight: 0 };
  const w = evidenceRounds / (evidenceRounds + shrinkRounds);
  return { used: w * observed + (1 - w) * prior, weight: w };
}

/**
 * Build the numeric profile the engine consumes.
 * @param {{fighter:object, snapshot:object|null, ladder:object[]}} input
 * @param {object} params
 */
export function profileFromSnapshot(input, params = DEFAULT_PARAMS) {
  const { fighter, snapshot, ladder = [] } = input;
  const L = params.league;
  const fallbacks = [];
  const used = {};
  const take = (key, prior, unitRounds = null) => {
    const m = metricObj(snapshot, key);
    const rounds = unitRounds ?? (m ? m.sample_seconds / 300 : 0);
    if (!m || m.value == null) {
      fallbacks.push({ metric: key, reason: m ? 'null_value' : 'missing', prior });
      used[key] = { observed: null, prior, weight: 0, used: prior, confidence: m?.confidence || 'insufficient' };
      return prior;
    }
    const s = shrink(m.value, prior, rounds, params.shrink_rounds);
    used[key] = { observed: m.value, prior, weight: Math.round(s.weight * 1e4) / 1e4, used: s.used, confidence: m.confidence, sample_rounds: m.sample_rounds, sample_bouts: m.sample_bouts };
    return s.used;
  };

  // Striking
  const sig_landed = take('sig_landed_per_min', L.sig_landed_per_min);
  const accuracy = clamp(take('sig_accuracy', L.sig_accuracy), 0.15, 0.85);
  const defense = clamp(take('sig_defense', L.sig_defense), 0.15, 0.9);
  const absorbed = take('sig_absorbed_per_min', L.sig_landed_per_min);
  const kd15 = take('knockdowns_per_15', L.kd_per_15);
  const kdabs15 = take('knockdowns_absorbed_per_15', L.kd_per_15);
  const shares3 = normalizeShares([take('head_attack_share', L.head_share), take('body_attack_share', L.body_share), take('leg_attack_share', L.leg_share)], [L.head_share, L.body_share, L.leg_share]);
  const pos3 = normalizeShares([take('distance_attack_share', L.distance_share), take('clinch_attack_share', L.clinch_share), take('ground_attack_share', L.ground_share)], [L.distance_share, L.clinch_share, L.ground_share]);

  // Overall attempts per minute: from the fighter's own accuracy when both exist, else the prior.
  const sigLandedObs = metricObj(snapshot, 'sig_landed_per_min');
  const attOverall = sigLandedObs?.value != null && accuracy > 0 ? sig_landed / accuracy : L.sig_att_per_min;

  // Pace by round from round_profile, falling back to the retention chain.
  const ret2 = clamp(take('pace_retention_r2_vs_r1', L.pace_retention_r2), 0.6, 1.3);
  const ret3 = clamp(take('pace_retention_r3_vs_r1', L.pace_retention_r3), 0.5, 1.3);
  const champDelta = take('championship_round_delta', L.championship_delta); // per-minute delta of attempts in R4-5 vs R1-3
  const drift = take('defensive_drift_r3_vs_r1', L.defensive_drift); // absorbed per-minute increase R3 vs R1
  const att_rate = [];
  const roundProfile = snapshot?.round_profile?.rounds || {};
  for (let r = 1; r <= params.max_rounds; r++) {
    const rp = roundProfile[String(r)];
    const obs = num(rp?.sig_att_per_min?.value);
    const rounds = num(rp?.rounds) || 0;
    const chain = r === 1 ? attOverall : r === 2 ? attOverall * ret2 : r === 3 ? attOverall * ret3 : attOverall * ret3 * clamp(1 + champDelta / Math.max(1, attOverall), 0.6, 1.4);
    if (obs != null && rounds >= 2) {
      const s = shrink(obs, chain, rounds, params.shrink_rounds);
      att_rate.push(s.used);
    } else {
      if (r <= 3) fallbacks.push({ metric: `r${r}_sig_attempts_per_min`, reason: obs == null ? 'missing' : 'below_min_rounds', prior: chain });
      att_rate.push(chain);
    }
  }
  const driftRel = clamp(drift / Math.max(1, absorbed), -params.drift_cap, params.drift_cap);

  // Grappling
  const td15 = take('td_attempts_per_15', L.td_att_per_15);
  const tdacc = clamp(take('td_accuracy', L.td_accuracy), 0.05, 0.95);
  const ctrlPerTd = clamp(take('control_seconds_per_td', L.control_sec_per_td), 10, 280);
  const ctrlShare = clamp(take('control_share', L.control_sec_per_round / 300), 0, 0.9);
  const sub15 = take('sub_attempts_per_15', L.sub_att_per_15);

  // Takedown defence from the ladder (opponent totals of prior bouts), the same construction the model uses.
  let oppTdL = 0, oppTdA = 0, ladderRows = 0;
  for (const row of ladder) {
    const t = row?.raw_stats?.opp_totals;
    if (!t) continue;
    ladderRows++;
    oppTdL += num(t.td_l) || 0;
    oppTdA += num(t.td_a) || 0;
  }
  let tddef;
  if (oppTdA >= 3) {
    const s = shrink(1 - oppTdL / oppTdA, L.td_defense, ladderRows, params.shrink_bouts);
    tddef = clamp(s.used, 0.05, 0.98);
    used.td_defense = { observed: 1 - oppTdL / oppTdA, prior: L.td_defense, weight: s.weight, used: tddef, sample_bouts: ladderRows, opp_td_attempts: oppTdA };
  } else {
    tddef = L.td_defense;
    fallbacks.push({ metric: 'td_defense', reason: 'fewer_than_3_opponent_attempts', prior: L.td_defense });
    used.td_defense = { observed: null, prior: L.td_defense, weight: 0, used: tddef, sample_bouts: ladderRows };
  }

  // Finish propensity and durability from the record, shrunk on bouts.
  const rec = snapshot?.provenance?.record || {};
  const apps = num(rec.appearances) || 0;
  const wins = num(rec.w) || 0;
  const fb = snapshot?.finish_profile?.finished_by || {};
  const koLosses = num(fb.ko_tko) || 0;
  const subLosses = num(fb.submission) || 0;
  const koRateM = metricObj(snapshot, 'ko_finish_rate');
  const subRateM = metricObj(snapshot, 'submission_finish_rate');
  const koWinsObs = koRateM?.value != null ? koRateM.value * apps : null; // ko_finish_rate = KO wins / appearances
  const subWinsObs = subRateM?.value != null ? subRateM.value * apps : null;
  const rate = (count, prior) => {
    if (count == null || apps === 0) return { used: prior, weight: 0 };
    const w = apps / (apps + params.shrink_bouts);
    return { used: w * (count / apps) + (1 - w) * prior, weight: w };
  };
  const koWin = rate(koWinsObs, L.ko_win_rate); const subWin = rate(subWinsObs, L.sub_win_rate);
  const koLoss = rate(apps ? koLosses : null, L.ko_loss_rate); const subLoss = rate(apps ? subLosses : null, L.sub_loss_rate);
  if (koWinsObs == null) fallbacks.push({ metric: 'ko_finish_rate', reason: 'missing', prior: L.ko_win_rate });
  if (subWinsObs == null) fallbacks.push({ metric: 'submission_finish_rate', reason: 'missing', prior: L.sub_win_rate });
  used.ko_win_rate = { observed: koWinsObs == null ? null : koWinsObs / Math.max(1, apps), prior: L.ko_win_rate, used: koWin.used, weight: koWin.weight, appearances: apps };
  used.sub_win_rate = { observed: subWinsObs == null ? null : subWinsObs / Math.max(1, apps), prior: L.sub_win_rate, used: subWin.used, weight: subWin.weight, appearances: apps };
  used.ko_loss_rate = { observed: apps ? koLosses / apps : null, prior: L.ko_loss_rate, used: koLoss.used, weight: koLoss.weight, appearances: apps };
  used.sub_loss_rate = { observed: apps ? subLosses / apps : null, prior: L.sub_loss_rate, used: subLoss.used, weight: subLoss.weight, appearances: apps };

  const requiredKeys = ['sig_landed_per_min', 'sig_accuracy', 'sig_defense', 'sig_absorbed_per_min', 'knockdowns_per_15', 'knockdowns_absorbed_per_15', 'head_attack_share', 'body_attack_share', 'leg_attack_share', 'distance_attack_share', 'clinch_attack_share', 'ground_attack_share', 'td_attempts_per_15', 'td_accuracy', 'control_seconds_per_td', 'control_share', 'sub_attempts_per_15', 'pace_retention_r2_vs_r1', 'pace_retention_r3_vs_r1', 'ko_finish_rate', 'submission_finish_rate'];
  const availableCount = requiredKeys.filter((k) => used[k]?.observed != null).length;

  return {
    id: fighter.id,
    name: fighter.name,
    stance: fighter.stance || null,
    reach_in: num(fighter.reach_in), height_in: num(fighter.height_in),
    as_of: snapshot?.as_of_date || null,
    coverage_status: snapshot?.coverage_status || 'insufficient',
    sample: {
      bouts: num(snapshot?.sample_bouts) || 0, completed_bouts: num(snapshot?.sample_completed_bouts) || 0,
      stat_bouts: num(snapshot?.sample_stat_bouts) || 0, rounds: num(snapshot?.sample_rounds) || 0, seconds: num(snapshot?.sample_seconds) || 0,
      appearances: apps, wins,
    },
    availability: { required: requiredKeys.length, observed: availableCount, ratio: Math.round((availableCount / requiredKeys.length) * 1e4) / 1e4 },
    // Engine-facing numbers.
    att_rate, accuracy, defense, drift_rel: driftRel,
    shares: { head: shares3[0], body: shares3[1], leg: shares3[2] },
    positions: { distance: pos3[0], clinch: pos3[1], ground: pos3[2] },
    td15, tdacc, tddef, ctrl_per_td: ctrlPerTd, ctrl_share: ctrlShare, sub15, kd15, kdabs15,
    ko_win: koWin.used, sub_win: subWin.used, ko_loss: koLoss.used, sub_loss: subLoss.used,
    ret2, ret3,
    evidence: { used, fallbacks, snapshot_provenance: snapshot?.provenance?.builder || null, definition_version: snapshot?.definition_version ?? null },
  };
}

function normalizeShares(vals, priors) {
  let out = vals.map((v, i) => (v == null || !(v >= 0) ? priors[i] : v));
  const sum = out.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return priors.slice();
  return out.map((v) => v / sum);
}

/**
 * Exclusive as-of check. `boutDates` maps bout_id -> event_date for every bout the caller can resolve.
 * A snapshot dated D is rejected when any listed bout has event_date >= D.
 */
export function validateSnapshotAsOf(snapshot, boutDates = new Map()) {
  if (!snapshot) return { ok: false, violations: [], unverified: [], reason: 'no_snapshot' };
  const asOf = snapshot.as_of_date;
  const bouts = Array.isArray(snapshot?.provenance?.bouts) ? snapshot.provenance.bouts : [];
  const violations = [];
  const unverified = [];
  for (const id of bouts) {
    const d = boutDates instanceof Map ? boutDates.get(id) : boutDates?.[id];
    if (!d) { unverified.push(id); continue; }
    if (String(d) >= String(asOf)) violations.push({ bout_id: id, event_date: d });
  }
  return { ok: violations.length === 0, violations, unverified, reason: violations.length ? 'bout_on_or_after_as_of' : null };
}

/** Coverage gate: FULL / LIMITED / INSUFFICIENT with reasons. */
export function coverageGate(p1, p2, anchor, params = DEFAULT_PARAMS) {
  const g = params.gate;
  const reasons = [];
  const tiers = [p1, p2].map((p) => TIER_RANK[p.coverage_status] ?? 0);
  for (const [i, p] of [p1, p2].entries()) {
    const label = i === 0 ? 'fighter_1' : 'fighter_2';
    if (!p.as_of) reasons.push({ code: 'no_snapshot', fighter: label });
    if ((TIER_RANK[p.coverage_status] ?? 0) < TIER_RANK[g.limited_min_tier]) reasons.push({ code: 'coverage_insufficient', fighter: label, coverage_status: p.coverage_status });
    if (p.sample.stat_bouts < g.min_stat_bouts) reasons.push({ code: 'no_stat_bouts', fighter: label, stat_bouts: p.sample.stat_bouts });
    if (p.availability.ratio < g.min_metric_availability) reasons.push({ code: 'metric_availability_low', fighter: label, ratio: p.availability.ratio });
  }
  if (anchor == null || !(anchor.prob_1 > 0 && anchor.prob_1 < 1)) reasons.push({ code: 'anchor_missing' });
  if (reasons.length) return { status: 'INSUFFICIENT', reasons, message: 'Not enough Fight DNA to produce a defensible simulation.' };
  const limited = [];
  if (Math.min(...tiers) < TIER_RANK[g.full_min_tier]) limited.push({ code: 'coverage_low', fighters: [p1, p2].filter((p) => TIER_RANK[p.coverage_status] < TIER_RANK[g.full_min_tier]).map((p) => p.id) });
  if (anchor.eligibility && anchor.eligibility.decision && anchor.eligibility.decision !== 'ELIGIBLE') limited.push({ code: 'anchor_not_eligible', reasons: anchor.eligibility.reasons || [] });
  const fbTotal = p1.evidence.fallbacks.length + p2.evidence.fallbacks.length;
  if (fbTotal > 6) limited.push({ code: 'many_fallbacks', count: fbTotal });
  if (limited.length) return { status: 'LIMITED', reasons: limited, message: 'Limited simulation: one corner has thin Fight DNA. Round-level precision is reduced.' };
  return { status: 'FULL', reasons: [], message: null };
}
