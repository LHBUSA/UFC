/* Component fixtures for the PBE MODEL card.
 *
 * DEV AND TEST ONLY. Nothing in `app/` imports this file, and nothing here is
 * ever rendered to a reader.
 *
 * Why it exists: the card has a market row and an edge row that no real bout
 * can currently populate, because no completed fight in the database carries a
 * price recorded before it started. An illustrative example of those rows was
 * briefly on the public page, badged as a specimen. That was a mistake worth
 * naming: a page whose entire argument is "we never show you an invented
 * number" is not the place to show an invented number, however carefully it is
 * labelled. The layout still needs an example to be developed and tested
 * against, so the example lives here, where the only audience is a test runner.
 *
 * The numbers are the ones from the original design brief, kept so the card's
 * populated state stays comparable to the spec it was drawn from.
 */

export const SPECIMEN = {
  a: { name: "Fighter A", prob: 0.618 },
  b: { name: "Fighter B", prob: 0.382 },
  marketImpliedA: 0.554,
  marketBooks: 7,
  sample: { minPriorBouts: 9, minStatBouts: 8, featuresAvailable: 33, featuresTotal: 33 },
  // 61.8 - 55.4, in percentage points, on the picked corner.
  expectedEdgePts: 6.4,
};

/** The mirror case: the market makes the model's pick the underdog, so the
 *  edge is negative. Present because a sign error here would be invisible in
 *  the specimen above, where both numbers favour the same corner. */
export const SPECIMEN_UNDERDOG = {
  a: { name: "Fighter A", prob: 0.382 },
  b: { name: "Fighter B", prob: 0.618 },
  marketImpliedA: 0.554,
  marketBooks: 7,
  expectedEdgePts: 61.8 - (100 - 55.4),
};

/** No price at all. The card must say so rather than render a placeholder. */
export const SPECIMEN_NO_MARKET = {
  a: { name: "Fighter A", prob: 0.618 },
  b: { name: "Fighter B", prob: 0.382 },
  marketImpliedA: null,
  marketBooks: null,
};
