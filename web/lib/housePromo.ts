/* First-party PropBetEdge product promotion for articles. Pure: no I/O.
 *
 * Presentation only. Nothing here touches the stored article, its metadata or
 * its NewsArticle structured data: the promo is rendered after the story,
 * never written into it, and never described to search engines as part of it.
 *
 * One product per article: the UFC Intelligence API, the natural next step for
 * a reader of UFC analysis. The headline follows the story type
 * deterministically (no model call). Other PropBetEdge sports appear only as a
 * small text row beneath it. PBE Algo is deliberately not promoted until it is
 * live as a paid product.
 *
 * Destinations are verified live properties (audited 2026-09-14): the UFC
 * Intelligence API product site and the network sports in lib/network.ts. */

import { NETWORK, CURRENT_SPORT } from "@/lib/network";
import { SITE } from "@/lib/site";

export type PromoCopy = { eyebrow: string; headline: string; body: string; cta: string; href: string };

const EYEBROW = "From PropBetEdge · UFC Intelligence API";
/* The API and this site share an intelligence layer; the copy never claims the
 * site runs ON the commercial API (see components/ApiCta.tsx). */
const LAYER = "Built on the same UFC intelligence layer behind this story.";

const BY_TYPE: Record<string, { headline: string; body: string }> = {
  fight_preview: {
    headline: "Put the numbers behind this preview in your product",
    body: `Fighter records, round-level statistics and Fight DNA for UFC bouts, as structured data. ${LAYER}`,
  },
  results: {
    headline: "UFC results and round-level stats, as structured data",
    body: `Results, methods, round-level statistics and fighter histories through one API. ${LAYER}`,
  },
  rankings: {
    headline: "Rankings and fighter records, ready for your product",
    body: `Official rankings snapshots, fighter records and Fight DNA as structured data. ${LAYER}`,
  },
};
const DEFAULT = {
  headline: "Build with UFC data",
  body: `Events, fighters, results, round-level statistics and Fight DNA, delivered as structured data for developers. ${LAYER}`,
};

export function promoFor(storyType: string): PromoCopy {
  const c = BY_TYPE[storyType] || DEFAULT;
  return { eyebrow: EYEBROW, headline: c.headline, body: c.body, cta: "Explore the UFC API", href: SITE.ufcApi };
}

export type NetworkLink = { key: string; label: string; href: string };

/** Live network sports other than this one, in registry order. */
export function networkLinks(): NetworkLink[] {
  return NETWORK.sports.filter((s) => s.key !== CURRENT_SPORT && /^https:\/\//.test(s.href)).map((s) => ({ key: s.key, label: s.label, href: s.href }));
}

/* Click events: first-party, no vendor, no tracking parameters on any URL. */
export const PROMO_DESTINATIONS = new Set(["ufc_api", ...NETWORK.sports.map((s) => s.key)]);
export const PROMO_SLUG = /^[a-z0-9-]{1,160}$/;
