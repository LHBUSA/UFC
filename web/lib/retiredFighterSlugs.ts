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
 * One entry per fighter merge recorded in ufc_identity_reconciliations, and one
 * per source-id attachment that changed a fighter's slug: a slug is keyed on the
 * ESPN athlete id once one exists, so attaching a proven ESPN id retires the
 * UFC Stats-keyed URL the same way a merge does. The source matches any name
 * prefix, so an old link with a since-corrected name still lands on the
 * canonical profile. */

export type RetiredFighterSlug = { retiredSourceId: string; canonicalSlug: string; reconciliation: string };

export const RETIRED_FIGHTER_SLUGS: ReadonlyArray<RetiredFighterSlug> = [
  { retiredSourceId: "1eff7bc0f815b270", canonicalSlug: "yorgan-de-castro-4423213", reconciliation: "dwcs-split-identities-2026-09-13" },
  { retiredSourceId: "e530df53922f413e", canonicalSlug: "luis-pajuelo-5144312", reconciliation: "dwcs-split-identities-2026-09-13" },
  /* TUF 2 contestants: ESPN athlete ids attached through their exact finale bouts (no merge). */
  { retiredSourceId: "79899ecf62020f6d", canonicalSlug: "joe-stevenson-2335672", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "6da99156486ed6c2", canonicalSlug: "joshua-burkman-2354104", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "4908c5ee68a50ee5", canonicalSlug: "brad-imes-2335606", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "030f08370fd1c2bb", canonicalSlug: "kerry-schall-2354537", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "ccd1299e0345e0ce", canonicalSlug: "melvin-guillard-2335800", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "b7d524c77c27389b", canonicalSlug: "marcus-davis-2335804", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "2067a177a2842fbf", canonicalSlug: "sammy-morgan-2335817", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "ee779c43a8926d52", canonicalSlug: "rashad-evans-2335465", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "93ce4ac89e3d7652", canonicalSlug: "luke-cummo-2335799", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "b9d0fd83bb8a147a", canonicalSlug: "keith-jardine-2335469", reconciliation: "tuf2-espn-athlete-ids-2026-09-13" },
  /* TUF 1 contestants: ESPN athlete ids attached through their exact finale bouts (no merge). */
  { retiredSourceId: "aee8eecfc4bfb1e7", canonicalSlug: "bobby-southworth-2431311", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "dd37fd509af89f15", canonicalSlug: "josh-koscheck-2335664", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "82e7929bf6c2b689", canonicalSlug: "diego-sanchez-2335671", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "84a067c46306a737", canonicalSlug: "sam-hoger-2335605", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "fcffee71cff5530e", canonicalSlug: "forrest-griffin-2335522", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "cb139171ed1b69fe", canonicalSlug: "kenny-florian-2335675", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "fdfef29ba17ee525", canonicalSlug: "alex-schoenauer-2335745", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "ff2c606c8bc365e3", canonicalSlug: "josh-rafferty-2556812", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "52cae54377b433b7", canonicalSlug: "nate-quarry-2335773", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "d43a048a880efdff", canonicalSlug: "chris-leben-2335513", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "c6a33ff198aaaeeb", canonicalSlug: "stephan-bonnar-2335525", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "9fe85152f351e737", canonicalSlug: "mike-swick-2335819", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "265589bdd93e7ce5", canonicalSlug: "lodune-sincaid-2431312", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "e361e5c858af6ff1", canonicalSlug: "alex-karalexis-2335822", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "29f935654825331b", canonicalSlug: "chris-sanford-2488455", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
  { retiredSourceId: "f0264252e191da22", canonicalSlug: "jason-thacker-2431252", reconciliation: "tuf1-espn-athlete-ids-2026-09-13" },
];

/** The path-to-regexp constraint for a retired id: the whole slug, name optional. */
export const retiredSlugPattern = (id: string): string => `(?:[a-z0-9-]*-)?${id}`;

export function retiredFighterSlugRedirects() {
  return RETIRED_FIGHTER_SLUGS.flatMap((r) => [
    { source: `/fighters/:slug(${retiredSlugPattern(r.retiredSourceId)})`, destination: `/fighters/${r.canonicalSlug}`, permanent: true },
  ]);
}
