/* First-party PropBetEdge house promotion for articles. Pure: no I/O.
 *
 * Presentation only. Nothing here touches the stored article, its metadata or
 * its NewsArticle structured data: promos are rendered around the body, never
 * written into it, and never described to search engines as part of the story.
 *
 * Ceiling per article: one contextual inline module and one network module at
 * the end. Selection is deterministic (story type + length), with no model call.
 *
 * Destinations are the verified live properties only (audited 2026-09-14):
 * the UFC Intelligence API product site and the network sports in lib/network.ts.
 * PBE Algo is deliberately not a campaign until it is live as a paid product. */

import { NETWORK, CURRENT_SPORT } from "@/lib/network";
import { SITE } from "@/lib/site";

export type PromoCampaign = "ufc_api";
export type PromoPlacement = "inline" | "end";

/** Below this, a story is short: no inline module, end module only. */
export const INLINE_MIN_WORDS = 700;
/** Editorial the reader has already had before an inline module may appear. */
export const INLINE_MIN_WORDS_BEFORE = 250;

/* Stories whose substance is fight data (previews, results, rankings) are the
 * natural home for "build with UFC data". News, card changes, weigh-ins and
 * Around MMA items get the end module only: an API pitch in the middle of an
 * injury story is an ad, not context. */
const API_STORY_TYPES = new Set(["fight_preview", "results", "rankings"]);

export const PROMO_COPY = {
  ufc_api: {
    eyebrow: "From PropBetEdge",
    title: "Build with UFC data",
    body: "Fighter records, events, results, round-level statistics and Fight DNA, delivered as structured MMA data for developers.",
    cta: "Explore the UFC API",
    href: SITE.ufcApi,
  },
} as const;

export function wordCount(md: string): number {
  const t = (md || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

export function inlineCampaign(storyType: string, bodyMd: string): PromoCampaign | null {
  if (!API_STORY_TYPES.has(storyType)) return null;
  if (wordCount(bodyMd) < INLINE_MIN_WORDS) return null;
  return "ufc_api";
}

const textWords = (html: string) => wordCount(html.replace(/<[^>]+>/g, " "));

/**
 * The block index the inline module renders BEFORE, or null to skip it.
 *
 * After meaningful editorial: at least INLINE_MIN_WORDS_BEFORE words and 35% of
 * the body already read, directly after a paragraph (never after a heading,
 * list, table or quote), with at least two blocks still to come, and never
 * adjacent to a slot an intelligence module already occupies. If no slot
 * satisfies all of that, the article simply does not get an inline module.
 */
export function inlineSlot(blocks: string[], occupied: ReadonlySet<number> = new Set()): number | null {
  const total = blocks.reduce((s, b) => s + textWords(b), 0);
  const need = Math.max(INLINE_MIN_WORDS_BEFORE, Math.ceil(total * 0.35));
  let before = 0;
  for (let i = 1; i < blocks.length; i += 1) {
    before += textWords(blocks[i - 1]);
    if (before < need) continue;
    if (blocks.length - i < 2) return null;
    if (!/^<p>/.test(blocks[i - 1])) continue;
    if (occupied.has(i) || occupied.has(i - 1) || occupied.has(i + 1)) continue;
    return i;
  }
  return null;
}

export type NetworkLink = { key: string; label: string; name: string; href: string };

/** Live network sports other than this one, in registry order. */
export function networkLinks(): NetworkLink[] {
  return NETWORK.sports.filter((s) => s.key !== CURRENT_SPORT && /^https:\/\//.test(s.href)).map((s) => ({ key: s.key, label: s.label, name: s.name, href: s.href }));
}

/* Click events: first-party, no vendor, no tracking parameters on any URL. */
export const PROMO_DESTINATIONS = new Set(["ufc_api", ...NETWORK.sports.map((s) => s.key), "propbetedge"]);
export const PROMO_SLUG = /^[a-z0-9-]{1,160}$/;
