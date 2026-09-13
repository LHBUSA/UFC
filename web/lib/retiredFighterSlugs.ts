/* Fighter URLs retired by an audited identity merge.
 *
 * A fighter slug ends in the source id it was built from (lib/slug.ts). When
 * two ufc_fighters rows are proven to be one person and merged, the canonical
 * row keeps its ESPN-keyed slug and the duplicate's UFC Stats-keyed URL stops
 * being a page of its own. The fighter page does call permanentRedirect() for
 * a non-canonical slug, but app/loading.tsx makes every page stream, so by then
 * the response is already a 200 and Next can only emit a client-side
 * meta-refresh. A config redirect runs before rendering and is a real 308 —
 * the same reason retired judge slugs redirect from next.config.
 *
 * One entry per fighter merge recorded in ufc_identity_reconciliations. The
 * source matches any name prefix, so an old link with a since-corrected name
 * still lands on the canonical profile. */

export type RetiredFighterSlug = { retiredSourceId: string; canonicalSlug: string; reconciliation: string };

export const RETIRED_FIGHTER_SLUGS: ReadonlyArray<RetiredFighterSlug> = [
  { retiredSourceId: "1eff7bc0f815b270", canonicalSlug: "yorgan-de-castro-4423213", reconciliation: "dwcs-split-identities-2026-09-13" },
  { retiredSourceId: "e530df53922f413e", canonicalSlug: "luis-pajuelo-5144312", reconciliation: "dwcs-split-identities-2026-09-13" },
];

/** The path-to-regexp constraint for a retired id: the whole slug, name optional. */
export const retiredSlugPattern = (id: string): string => `(?:[a-z0-9-]*-)?${id}`;

export function retiredFighterSlugRedirects() {
  return RETIRED_FIGHTER_SLUGS.flatMap((r) => [
    { source: `/fighters/:slug(${retiredSlugPattern(r.retiredSourceId)})`, destination: `/fighters/${r.canonicalSlug}`, permanent: true },
  ]);
}
