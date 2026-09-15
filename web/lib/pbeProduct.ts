/* PBE product facts for customer-facing copy. Pure: no I/O, no environment.
 *
 * /model, /algo, /algo/card, /algo/record and the Pro surfaces quote these
 * instead of typing numbers into prose, so a rule change cannot leave one page
 * describing an old model. The rule and cadence values mirror the production
 * contracts and are pinned by lib/algo.test.mjs against the modules production
 * actually runs:
 *   ALGO_RULES          scripts/model/eligibility.mjs (RULES + confidenceLabel)
 *   FIGHT_WEEK_WINDOWS  scripts/odds/fight_week_cadence.mjs (FIGHT_WEEK_BANDS)
 *   MODEL_FACTS         lib/generated/model-v1.json (the release artifact)
 * Nothing here decides anything: it only describes what production decides. */

import artifact from "@/lib/generated/model-v1.json";

export const ALGO_RULES = {
  minPriorBoutsPerCorner: 1,
  minFeaturesAvailable: 20,
  minPickProbability: 0.55,
  medium: { minPickProbability: 0.6 },
  high: { minPickProbability: 0.7, minPriorBoutsPerCorner: 3, minFeaturesAvailable: 31 },
} as const;

/** Market windows a fight-week snapshot stays CURRENT for, by time to the lock deadline. */
export const FIGHT_WEEK_WINDOWS = [
  { band: "T-7d", captureEveryMinutes: 720, currentMinutes: 730 },
  { band: "T-72h", captureEveryMinutes: 360, currentMinutes: 370 },
  { band: "T-24h", captureEveryMinutes: 60, currentMinutes: 60 },
] as const;

/** Source families a model input may come from. Anything market-shaped would be a sportsbook input. */
const MARKET_SHAPED = /market|odds|price|book|line|vig|implied/i;

export const MODEL_FACTS = {
  modelVersion: artifact.model.model_version,
  featureVersion: artifact.model.feature_version,
  /** "PBE Fight Model V1" from "pbe-fight-model-v1". */
  displayName: `PBE Fight Model ${artifact.model.model_version.replace(/^pbe-fight-model-/, "").toUpperCase()}`,
  featureCount: artifact.features.length,
  sportsbookInputs: artifact.features.filter((f) => MARKET_SHAPED.test(`${f.key} ${f.family} ${f.source}`)).length,
  trainingBouts: artifact.model.training_bouts,
  trainingWindowStart: artifact.model.training_window_start,
  trainingWindowEnd: artifact.model.training_window_end,
  specSha256: artifact.model.spec_sha256,
  outOfSampleFights: artifact.evidence.out_of_sample.n,
  outOfSampleFirst: artifact.evidence.out_of_sample.first_event,
  outOfSampleLast: artifact.evidence.out_of_sample.last_event,
} as const;

const pct0 = (p: number) => `${Math.round(p * 100)}%`;

export const RULE_TEXT = {
  minPick: pct0(ALGO_RULES.minPickProbability),
  minFeatures: `${ALGO_RULES.minFeaturesAvailable} of ${MODEL_FACTS.featureCount}`,
  confidence: `Lean below ${pct0(ALGO_RULES.medium.minPickProbability)}, Medium from ${pct0(ALGO_RULES.medium.minPickProbability)}, High from ${pct0(ALGO_RULES.high.minPickProbability)} only when both fighters have at least ${ALGO_RULES.high.minPriorBoutsPerCorner} prior UFC bouts and at least ${ALGO_RULES.high.minFeaturesAvailable} of ${MODEL_FACTS.featureCount} features are available. Thin samples are capped at Medium however large the probability.`,
  windows: FIGHT_WEEK_WINDOWS.map((w) => `${w.band === "T-7d" ? "until 72 hours before lock" : w.band === "T-72h" ? "until the final day" : "in the final 24 hours"}: current for ${w.currentMinutes >= 120 ? `${Math.floor(w.currentMinutes / 60)}h${w.currentMinutes % 60 ? ` ${w.currentMinutes % 60}m` : ""}` : `${w.currentMinutes} minutes`}`).join("; "),
} as const;

/* ---- illustrative explainer ----------------------------------------------
 * Invented prices, computed with the production definitions (implied
 * probability from American odds; proportional de-vig). Never a live pick. */
export const ILLUSTRATIVE = { pickOdds: -130, opponentOdds: 108, modelProbability: 0.64 } as const;

export const impliedFromAmerican = (price: number): number => (price > 0 ? 100 / (price + 100) : -price / (-price + 100));

export function illustrativeEdge(x: { pickOdds: number; opponentOdds: number; modelProbability: number } = ILLUSTRATIVE) {
  const rawPick = impliedFromAmerican(x.pickOdds);
  const rawOpponent = impliedFromAmerican(x.opponentOdds);
  const overround = rawPick + rawOpponent;
  const devigPick = rawPick / overround;
  return { ...x, rawPick, rawOpponent, overround, devigPick, edgePts: (x.modelProbability - devigPick) * 100 };
}
