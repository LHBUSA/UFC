// PBE Algo eligibility contract.
//
// ELIGIBILITY_VERSION is stored with every card evaluation. Pure and I/O-free:
// the same module runs in the Node scripts and bundled in the Cloudflare
// scheduler, so a dry run and production cannot classify a bout differently.
//
// A bout receives an official model call only when EVERY rule passes. Every
// failing rule is reported, in precedence order, so "NO MODEL CALL" always
// carries its exact deterministic reasons. Nothing here reads a result, a
// closing line or anything dated after the lock.
//
// Thresholds are taken from pbe-fight-model-v1's walk-forward out-of-sample
// evidence (n=7,056, 2013-2026; see docs/model/ALGO_ELIGIBILITY.md):
//   debut corner            53.3% hit, Brier 0.2482      -> no call
//   fewer than 20 features  55.1% hit, Brier 0.2449      -> no call
//   pick probability < 55%  50.8-55.2% hit               -> no call
//   eligible remainder      64.1% hit on 61.9% mean confidence, Brier 0.2288
//   HIGH (>=70%, both >=3 prior bouts, >=31 features)  81.7% on 73.9%, n=191
// The cut points were chosen on that same out-of-sample set, so the live
// record is what validates them; they are deliberately coarse.

export const ELIGIBILITY_VERSION = 'pbe-algo-eligibility-v1';

export const RULES = Object.freeze({
  minPriorBoutsPerCorner: 1,
  minFeaturesAvailable: 20,
  minPickProbability: 0.55,
  high: Object.freeze({ minPickProbability: 0.70, minPriorBoutsPerCorner: 3, minFeaturesAvailable: 31 }),
  // PBE ELITE is reserved and NOT published: it activates only once live graded
  // evidence (not the backtest) supports it. Recorded here so every evaluation
  // carries the flag and the tier can be measured before it is ever advertised.
  eliteCandidate: Object.freeze({ minPickProbability: 0.75, minPriorBoutsPerCorner: 5, minFeaturesAvailable: 31, maxMarketDisagreementPts: 15, maxRegenerationDriftPts: 1 }),
  lockMinLeadHours: 6,
});

/** Reason codes in precedence order. The first failing code is the headline. */
export const REASONS = Object.freeze({
  EVENT_OUT_OF_SCOPE: 'Not a UFC event in PBE Algo scope (Contender Series and non-UFC cards are not called).',
  BOUT_NOT_SCHEDULED: 'Bout is cancelled, replaced, already fought or has no scheduled status.',
  IDENTITY_UNRESOLVED: 'A corner\'s fighter identity is missing, duplicated, under alias review or its record does not reconcile.',
  MODEL_VERSION_UNAVAILABLE: 'No registered live model version matches the scoring artifact.',
  FEATURES_NOT_ASSEMBLED: 'The pre-fight feature vector for this bout could not be assembled.',
  STALE_FIGHTER_DATA: 'A corner\'s most recent completed bout is not yet reflected in its pre-fight Fight DNA.',
  DEBUT_CORNER: 'A corner has no prior UFC bout; the model has no fighter-specific evidence.',
  INSUFFICIENT_FEATURES: 'Fewer than 20 of 33 pre-fight features are available.',
  LOW_CONFIDENCE: 'Model probability for the pick is below 55%: too close to call.',
  LOCK_WINDOW_CLOSED: 'The pre-fight lock window has closed; a call can no longer be locked before the event.',
});
const ORDER = Object.keys(REASONS);

const CONTENDER = /contender series|\bdwcs\b/i;
const SCHEDULED = new Set(['announced', 'scheduled', 'confirmed']);

export function confidenceLabel(pickProbability, row) {
  const p = pickProbability;
  const minPrior = row?.min_prior_bouts ?? 0;
  const avail = row?.available_count ?? 0;
  if (p >= RULES.high.minPickProbability && minPrior >= RULES.high.minPriorBoutsPerCorner && avail >= RULES.high.minFeaturesAvailable) return 'HIGH';
  if (p >= 0.60) return 'MEDIUM';
  return 'LEAN';
}

/**
 * @param {object} input
 * @param {{name:string, event_date:string}} input.event
 * @param {{status:string|null, has_result:boolean, fighter_a_id:string|null, fighter_b_id:string|null}} input.bout
 * @param {{fighter_exists:boolean, open_alias_review:boolean, record_reconciles:boolean, stale:boolean}[]} input.corners  two entries
 * @param {object|null} input.row      assembled feature row (min_prior_bouts, available_count) or null
 * @param {number|null} input.pickProbability  max(p, 1-p) from the registered model, or null
 * @param {boolean} input.modelLive
 * @param {string}  input.nowIso
 * @param {number|null} [input.marketDisagreementPts]  |PBE pick prob - de-vigged market prob| * 100, benchmark only
 * @param {number|null} [input.regenerationDriftPts]
 */
export function evaluateBout(input) {
  const failed = new Set();
  const { event, bout, corners, row } = input;

  if (!event || CONTENDER.test(event.name || '') || !/^UFC\b/i.test(event.name || '')) failed.add('EVENT_OUT_OF_SCOPE');
  if (bout.has_result || !SCHEDULED.has(String(bout.status || '').toLowerCase())) failed.add('BOUT_NOT_SCHEDULED');
  if (!bout.fighter_a_id || !bout.fighter_b_id || bout.fighter_a_id === bout.fighter_b_id
    || !corners || corners.length !== 2
    || corners.some((c) => !c.fighter_exists || c.open_alias_review || !c.record_reconciles)) failed.add('IDENTITY_UNRESOLVED');
  if (!input.modelLive) failed.add('MODEL_VERSION_UNAVAILABLE');
  if (!row) failed.add('FEATURES_NOT_ASSEMBLED');
  if (corners?.some((c) => c.stale)) failed.add('STALE_FIGHTER_DATA');
  if (row && row.min_prior_bouts < RULES.minPriorBoutsPerCorner) failed.add('DEBUT_CORNER');
  if (row && row.available_count < RULES.minFeaturesAvailable) failed.add('INSUFFICIENT_FEATURES');
  if (input.pickProbability != null && input.pickProbability < RULES.minPickProbability) failed.add('LOW_CONFIDENCE');
  if (event?.event_date) {
    const cutoff = Date.parse(`${event.event_date}T00:00:00Z`) - RULES.lockMinLeadHours * 3600e3;
    if (Date.parse(input.nowIso) >= cutoff) failed.add('LOCK_WINDOW_CLOSED');
  }

  const reasons = ORDER.filter((k) => failed.has(k));
  const eligible = reasons.length === 0 && input.pickProbability != null;
  const e = RULES.eliteCandidate;
  const eliteCandidate = eligible
    && input.pickProbability >= e.minPickProbability
    && row.min_prior_bouts >= e.minPriorBoutsPerCorner
    && row.available_count >= e.minFeaturesAvailable
    && (input.marketDisagreementPts == null || input.marketDisagreementPts <= e.maxMarketDisagreementPts)
    && (input.regenerationDriftPts != null && input.regenerationDriftPts <= e.maxRegenerationDriftPts);

  return {
    eligibility_version: ELIGIBILITY_VERSION,
    decision: eligible ? 'ELIGIBLE' : 'NO_MODEL_CALL',
    reasons,
    reason_text: reasons.map((k) => REASONS[k]),
    confidence: eligible ? confidenceLabel(input.pickProbability, row) : null,
    elite_candidate: Boolean(eliteCandidate),
  };
}
