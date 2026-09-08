/* Weigh-in arithmetic, and the rule that governs all of it.
 *
 *   NEVER INFER A CONTRACTED LIMIT.
 *
 * A weight class is not a limit. A lightweight TITLE fight is 155 lb; a
 * non-title lightweight bout is 156 because of the one-pound allowance; a
 * catchweight is whatever two camps agreed and is often never published.
 * Deriving "over by 2.5" from a division name alone produces a number that is
 * wrong exactly when it matters most — a named athlete shown as missing by a
 * pound they did not miss by, on a page people bet against.
 *
 * So a limit is only ever produced when every input it needs is present:
 *
 *   sourced         the source stated the contracted limit in words. Best.
 *   division_rule   a standard division AND a known title status. The closed
 *                   table below and nothing else.
 *   unsupported     catchweight, open weight, unknown division, or a bout we
 *                   could not resolve. A FIRST-CLASS ANSWER, not a failure.
 *
 * When the basis is unsupported, over_by_lbs is null and stays null. A source
 * that says "missed weight" without a figure gives result='missed' with every
 * numeric field empty: the miss is real, the arithmetic is not available, and
 * the page says which.
 */

/** Division limits in pounds. Championship weight; the allowance is separate. */
export const DIVISION_LIMIT_LBS = {
  STRAWWEIGHT: 115,
  FLYWEIGHT: 125,
  BANTAMWEIGHT: 135,
  FEATHERWEIGHT: 145,
  LIGHTWEIGHT: 155,
  WELTERWEIGHT: 170,
  MIDDLEWEIGHT: 185,
  LIGHT_HEAVYWEIGHT: 205,
  HEAVYWEIGHT: 265,
};

/* Divisions whose name carries no limit at all. CATCHWEIGHT is the whole
 * reason this module refuses to guess: the agreed figure lives in the matchmaking
 * announcement, not in the word "catchweight". */
export const UNSUPPORTED_CLASSES = new Set(['CATCHWEIGHT', 'OPEN']);

/**
 * The non-title allowance, in pounds.
 *
 * One pound for a non-title bout in a standard division. Zero for a title
 * fight — a championship must be made on the number. Zero at heavyweight too:
 * 265 is a ceiling rather than a division target, and there is nothing to be
 * allowed above it.
 */
export function allowanceFor(weightClass, isTitle) {
  if (isTitle) return 0;
  if (weightClass === 'HEAVYWEIGHT') return 0;
  return 1;
}

/**
 * Work out the applicable limit for a bout, or say it cannot be worked out.
 *
 * `sourcedLimitLbs` wins whenever a source published the contracted figure —
 * a catchweight bout with a stated 165 lb limit is fully supported even though
 * its division name is not.
 *
 * Returns `{ contracted_limit_lbs, allowance_lbs, applicable_limit_lbs,
 * limit_basis, reason }`. `reason` is carried into provenance so a null limit
 * can be explained on the page rather than merely rendered as a gap.
 */
export function resolveLimit({ weightClass, isTitle, sourcedLimitLbs = null } = {}) {
  if (sourcedLimitLbs != null && Number.isFinite(Number(sourcedLimitLbs))) {
    const limit = Number(sourcedLimitLbs);
    return {
      contracted_limit_lbs: limit,
      /* A sourced figure is the figure. Adding an allowance on top of a number
       * somebody published would invent a limit nobody agreed to. */
      allowance_lbs: 0,
      applicable_limit_lbs: limit,
      limit_basis: 'sourced',
      reason: 'the source stated the contracted limit',
    };
  }

  const unsupported = (reason) => ({
    contracted_limit_lbs: null,
    allowance_lbs: null,
    applicable_limit_lbs: null,
    limit_basis: 'unsupported',
    reason,
  });

  if (!weightClass) return unsupported('no weight class on the bout');
  if (UNSUPPORTED_CLASSES.has(weightClass)) {
    return unsupported(`${weightClass.toLowerCase()} bouts carry no division limit; the agreed figure must be sourced`);
  }
  const base = DIVISION_LIMIT_LBS[weightClass];
  if (base == null) return unsupported(`no limit on file for ${weightClass}`);
  /* is_title is NOT NULL in the schema, so an undefined here means the caller
   * did not resolve the bout at all — which is exactly when guessing is worst. */
  if (typeof isTitle !== 'boolean') return unsupported('title status unknown, and the allowance depends on it');

  const allowance = allowanceFor(weightClass, isTitle);
  return {
    contracted_limit_lbs: base,
    allowance_lbs: allowance,
    applicable_limit_lbs: base + allowance,
    limit_basis: 'division_rule',
    reason: isTitle
      ? `${weightClass.toLowerCase()} championship: no allowance`
      : `${weightClass.toLowerCase()} non-title: ${allowance} lb allowance`,
  };
}

/** Round to one decimal the way a scale reads, avoiding float dust. */
const lb = (n) => Math.round(Number(n) * 10) / 10;

/**
 * Decide made/missed and the delta, from a reading and a limit.
 *
 * `over_by_lbs` is null unless BOTH the weight and a supported limit exist.
 * That is the whole contract: a delta is arithmetic, and arithmetic with a
 * missing operand is not a smaller number, it is no number.
 *
 * A reported miss with no figure is honoured — `reportedMiss` lets a source
 * that says "missed weight" set the result without inventing the measurement.
 */
export function evaluateWeight({ officialWeightLbs = null, applicableLimitLbs = null, reportedMiss = false } = {}) {
  const weight = officialWeightLbs == null ? null : lb(officialWeightLbs);
  const limit = applicableLimitLbs == null ? null : lb(applicableLimitLbs);

  if (weight == null) {
    /* No scale reading. A source may still assert a miss, and that assertion
     * is worth storing — but the schema forbids result='missed' without a
     * weight, so this is reported to the caller as an unmeasured miss. */
    return { result: reportedMiss ? 'missed_unmeasured' : 'pending', over_by_lbs: null };
  }
  if (limit == null) {
    /* We have a number and nothing to judge it against. Storing it as 'made'
     * would be an assertion; storing it as 'missed' would be worse. */
    return { result: reportedMiss ? 'missed' : 'unjudged', over_by_lbs: null, weight };
  }
  const over = lb(weight - limit);
  return { result: over > 0 ? 'missed' : 'made', over_by_lbs: over > 0 ? over : null, weight };
}

/**
 * Stable idempotency key for one reading.
 *
 * The live pass re-reads the same page every few minutes during a weigh-in
 * window, so the same reading arrives many times with a new detected_at. What
 * identifies a reading is the fighter, the event, which trip to the scale it
 * was, what the scale said and what the source concluded — plus the source
 * URL, so two publishers reporting the same number remain two pieces of
 * evidence rather than collapsing into one.
 *
 * detected_at is deliberately absent: including it would make every pass look
 * like new information, which is the exact bug the status collector had.
 */
export function fingerprintOf(row, sha256) {
  return sha256([
    row.event_id,
    row.fighter_id,
    `attempt:${row.attempt_number ?? 1}`,
    row.official_weight_lbs == null ? 'no-weight' : String(lb(row.official_weight_lbs)),
    row.result,
    String(row.source_url || '').replace(/[?#].*$/, ''),
  ].join('|'));
}

/**
 * Which stored readings are the current projection, and which were corrected.
 *
 * Latest authoritative correction wins; everything it replaced stays readable.
 * Ordering is by attempt first — a second trip to the scale supersedes the
 * first regardless of when each was detected — then by source authority, then
 * by time. Two sources disagreeing at the same authority is resolved by
 * recency and BOTH rows are kept, which is what lets the page say a correction
 * happened rather than silently swapping a number.
 */
export const SOURCE_RANK = { official: 3, commission: 2, news: 1, manual: 2 };

export function projectCurrent(rows) {
  const byFighter = new Map();
  for (const r of rows) {
    const key = `${r.event_id}|${r.fighter_id}`;
    const prev = byFighter.get(key);
    if (!prev || outranks(r, prev)) byFighter.set(key, r);
  }
  return [...byFighter.values()];
}

function outranks(a, b) {
  const attemptA = a.attempt_number ?? 1;
  const attemptB = b.attempt_number ?? 1;
  if (attemptA !== attemptB) return attemptA > attemptB;
  const rankA = SOURCE_RANK[a.source_kind] ?? 0;
  const rankB = SOURCE_RANK[b.source_kind] ?? 0;
  if (rankA !== rankB) return rankA > rankB;
  return time(a) > time(b);
}

const time = (r) => Date.parse(r.source_published_at || r.weighed_at || r.detected_at || 0) || 0;

/**
 * The deterministic one-line summary of a reading.
 *
 * "Fighter X — 158.5 lb — MISSED by 2.5 lb" is built from stored fields and
 * nothing else. No model is involved and none should be: this sentence must be
 * reproducible from the row six months later, and an article about a scale
 * reading is a different product with a different cadence.
 */
export function summaryLine(row) {
  const who = row.fighter_name || 'Fighter';
  if (row.result === 'pending') return `${who} — has not weighed in yet`;
  if (row.result === 'withdrawn') return `${who} — withdrew before the scale`;
  if (row.result === 'cancelled') return `${who} — bout cancelled before the scale`;

  const weight = row.official_weight_lbs == null ? null : `${lb(row.official_weight_lbs)} lb`;
  if (row.result === 'missed') {
    if (weight && row.over_by_lbs != null) return `${who} — ${weight} — MISSED by ${lb(row.over_by_lbs)} lb`;
    if (weight) return `${who} — ${weight} — MISSED (contracted limit not published)`;
    return `${who} — MISSED WEIGHT (weight not published)`;
  }
  if (row.result === 'made') {
    return weight ? `${who} — ${weight} — made weight` : `${who} — made weight`;
  }
  return `${who} — weigh-in result not recorded yet`;
}
