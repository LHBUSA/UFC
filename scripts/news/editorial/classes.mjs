/**
 * Publication classes and depth policy.
 *
 * THE PROBLEM THIS FIXES
 *
 * An audit of the 32 published articles found the thinness is not spread out.
 * It is one story type. Every article under 450 words is `external` - a
 * source-driven item rendered as "Publisher is reporting X, read the original,
 * here is our table view" plus two record sentences. Median 78 words. The 26
 * fight previews median 1,091 words and are fine.
 *
 * So the fix is not "write longer". It is that a 78-word sourced update was
 * never an article, and giving it a standalone indexable URL was the mistake.
 * A wire item is a real, useful editorial object; it just is not a page.
 *
 * The classes below make that distinction structural rather than a matter of
 * whoever is writing that day.
 */

/** @typedef {'wire'|'brief'|'feature'|'deep_dive'} PublicationClass */

export const CLASSES = ['wire', 'brief', 'feature', 'deep_dive'];

/**
 * Word budgets per class.
 *
 * `min` is a floor, not a target. Nothing may be padded to reach it; a packet
 * that cannot support the floor from verified facts falls back to a lower class
 * or to review. That direction is the whole point - the failure mode being
 * designed out is filler, and a floor without a fallback produces filler.
 */
export const CLASS_BUDGET = {
  wire: { min: 40, max: 250, indexable: false, standalone: false },
  brief: { min: 500, max: 800, indexable: true, standalone: true },
  feature: { min: 900, max: 1500, indexable: true, standalone: true },
  deep_dive: { min: 1400, max: 2200, indexable: true, standalone: true },
};

/**
 * The absolute floor for anything that gets an indexed standalone URL.
 *
 * Below this a page is not an article, whatever it is labelled. The one
 * documented exception is a primary-source announcement whose value is
 * timeliness rather than analysis - a promotion confirming a booking, say -
 * which must set `editorialException` explicitly and say why.
 */
export const INDEXED_FLOOR_WORDS = 450;

/**
 * Depth targets by story type. These are the editorial brief, expressed as
 * numbers so a gate can check them.
 *
 * `class` is the class a story of this type is expected to reach when the
 * packet supports it. It is an expectation, never an instruction to inflate.
 */
export const STORY_DEPTH = {
  main_event_preview: { min: 1200, max: 1800, class: 'deep_dive' },
  main_card_preview: { min: 900, max: 1400, class: 'feature' },
  prelim_preview: { min: 650, max: 1000, class: 'brief' },
  full_event_preview: { min: 1600, max: 2400, class: 'deep_dive' },
  results: { min: 1200, max: 1800, class: 'deep_dive' },
  injury_withdrawal: { min: 650, max: 1100, class: 'brief' },
  weigh_in_miss: { min: 600, max: 1000, class: 'brief' },
  rankings: { min: 800, max: 1400, class: 'feature' },
  scorecard_analysis: { min: 900, max: 1500, class: 'feature' },
  referee_analysis: { min: 800, max: 1400, class: 'feature' },
  news_brief: { min: 500, max: 800, class: 'brief' },
  /* Not a target. A wire item has no depth ambition; it has a ceiling. */
  wire: { min: 40, max: 250, class: 'wire' },
};

/**
 * How much evidence a class needs before it may be attempted.
 *
 * This is the gate that stops a thin packet becoming a long article. Each
 * requirement is a count of DISTINCT evidence families present in the V4
 * packet - not a count of sentences, and not a count of facts, because ten
 * facts from one table is still one angle.
 */
export const CLASS_EVIDENCE_REQUIREMENT = {
  wire: { families: 1, facts: 2 },
  brief: { families: 3, facts: 10 },
  feature: { families: 5, facts: 18 },
  deep_dive: { families: 6, facts: 28 },
};

/**
 * Decide what a story may become, given the evidence actually present.
 *
 * Returns the highest class the packet can support, never higher than the
 * story type's own expectation. The asymmetry is deliberate: evidence can pull
 * a story DOWN from its expected class, and never pushes it up past it. A
 * prelim preview with unusually rich data is still a prelim preview.
 *
 * @param {string} storyType key of STORY_DEPTH
 * @param {{families: string[], factCount: number}} evidence
 */
export function resolveClass(storyType, evidence) {
  const expectation = STORY_DEPTH[storyType] ?? STORY_DEPTH.news_brief;
  const families = new Set(evidence.families || []).size;
  const facts = evidence.factCount || 0;

  const order = ['deep_dive', 'feature', 'brief', 'wire'];
  const ceiling = order.indexOf(expectation.class);

  for (let i = Math.max(0, ceiling); i < order.length; i++) {
    const cls = order[i];
    const need = CLASS_EVIDENCE_REQUIREMENT[cls];
    if (families >= need.families && facts >= need.facts) {
      return {
        publication_class: cls,
        expected_class: expectation.class,
        downgraded: cls !== expectation.class,
        reason: cls === expectation.class
          ? null
          : `packet carries ${families} evidence families and ${facts} facts; ${expectation.class} needs ${CLASS_EVIDENCE_REQUIREMENT[expectation.class].families} and ${CLASS_EVIDENCE_REQUIREMENT[expectation.class].facts}`,
        budget: CLASS_BUDGET[cls],
        depth: cls === expectation.class ? expectation : STORY_DEPTH[cls] ?? CLASS_BUDGET[cls],
      };
    }
  }
  return {
    publication_class: 'wire',
    expected_class: expectation.class,
    downgraded: true,
    reason: `packet carries ${families} evidence families and ${facts} facts; not enough for any standalone class`,
    budget: CLASS_BUDGET.wire,
    depth: STORY_DEPTH.wire,
  };
}

/**
 * Is this class allowed a standalone indexable /news/[slug] page?
 *
 * Wire is not. That is the single most important line in this file: it is what
 * stops three sentences becoming a page, and it is checked by the renderer, by
 * the sitemap builder and by a test, so it cannot be forgotten in one of them.
 */
export function isIndexable(publicationClass, wordCount, { editorialException = null } = {}) {
  const budget = CLASS_BUDGET[publicationClass];
  if (!budget || !budget.indexable) return { indexable: false, reason: `${publicationClass} items are not standalone pages` };
  if (wordCount < INDEXED_FLOOR_WORDS) {
    if (editorialException) return { indexable: true, reason: `below the ${INDEXED_FLOOR_WORDS}-word floor under a documented exception: ${editorialException}` };
    return { indexable: false, reason: `${wordCount} words is below the ${INDEXED_FLOOR_WORDS}-word floor for an indexed page` };
  }
  return { indexable: true, reason: null };
}

/** Where a wire item belongs instead of a page of its own. */
export const WIRE_SURFACES = ['fight_week', 'live_wire', 'event_timeline', 'related_news'];
