/* PropBetEdge House Promo Engine. Pure: no I/O, no randomness.
 *
 * Presentation only. Nothing here touches the stored article, its metadata or
 * its NewsArticle structured data: the promo renders after the story and is
 * never described to search engines as part of it.
 *
 * How a campaign is chosen, in order:
 *   1. ELIGIBILITY  every campaign has an explicit rule (product state, reader
 *                   entitlement, context). Ineligible campaigns leave the pool,
 *                   so a reader always gets the next eligible campaign, never
 *                   an empty slot.
 *   2. CONTEXT      the article is classified deterministically (TUF/history,
 *                   story type, data-heavy) and each class weights the pool.
 *   3. ROTATION     weighted rendezvous hashing over ROTATION_VERSION + slug +
 *                   campaign. The same article shows the same campaign on
 *                   every request until the version changes; an eligibility
 *                   change moves only the articles it affects.
 *
 * Destinations are verified live (2026-09-14): every local route returns 200
 * index/follow, the UFC Intelligence API product site, and the network sports
 * in lib/network.ts. PBE Algo is eligible only through product state
 * (lib/algo.ts algoCallsActive), never because its route exists. */

import { NETWORK, CURRENT_SPORT, type NetworkSport } from "@/lib/network";
import { SITE } from "@/lib/site";
import { PRO_OFFER } from "@/lib/proOffer";

/** Change to intentionally re-deal every article's campaign. */
export const ROTATION_VERSION = "2026-09-14.1";

type SportKey = Exclude<NetworkSport["key"], "ufc">;
export type CampaignId =
  | "ufc_api" | "pro" | "fight_dna" | "fight_week" | "algo" | "round_by_round" | "tuf" | "store"
  | `network_${SportKey}`;

export type PromoContext = {
  storyType: string;
  slug: string;
  headline: string;
  /** The reader already holds UFC Pro (or is the owner). */
  readerPro: boolean;
  /** PBE Algo is registered live and issuing official calls. */
  algoActive: boolean;
};

export type Campaign = {
  id: CampaignId;
  /** Product key recorded with a click. */
  dest: string;
  eyebrow: string;
  headlines: readonly string[];
  body: string;
  cta: string;
  href: string;
  external: boolean;
  /** Network sport this campaign promotes, so the secondary row can skip it. */
  sport?: SportKey;
  eligible: (ctx: PromoContext) => boolean;
};

const UFC_CAMPAIGNS: Campaign[] = [
  {
    id: "ufc_api", dest: "ufc_api", eyebrow: "From PropBetEdge · UFC Intelligence API",
    headlines: ["Build with UFC data", "Put UFC intelligence inside your product"],
    body: "Events, fighters, results, round-level statistics and Fight DNA as structured data for developers. Built on the same intelligence layer behind this story.",
    cta: "Explore the UFC API", href: SITE.ufcApi, external: true,
    eligible: () => true,
  },
  {
    id: "pro", dest: "pro", eyebrow: "From PropBetEdge · UFC Pro",
    headlines: ["Go deeper on fight night", "Unlock the full PropBetEdge fight intelligence stack"],
    body: `Matchup Fight DNA, round intelligence, market context and the fight-week desk for UFC cards. ${PRO_OFFER.plans.monthly.display}/month or ${PRO_OFFER.plans.weekly.display}/week, cancel anytime.`,
    cta: "See UFC Pro", href: "/pro", external: false,
    eligible: (c) => !c.readerPro,
  },
  {
    id: "fight_dna", dest: "fight_dna", eyebrow: "From PropBetEdge · Fight DNA",
    headlines: ["See the matchup beneath the record", "Understand how these fighters actually differ"],
    body: "Fight DNA rebuilds each fighter's history into versioned measures of pace, striking, grappling and durability, each shown with its sample and confidence.",
    cta: "How Fight DNA works", href: "/learn/fight-dna", external: false,
    eligible: () => true,
  },
  {
    id: "fight_week", dest: "fight_week", eyebrow: "From PropBetEdge · Fight Week",
    headlines: ["Everything that changed before fight night", "Follow the card as it moves"],
    body: "Weigh-ins, withdrawals, replacements and the live state of the card, in one place through fight week.",
    cta: "Open Fight Week", href: "/fight-week", external: false,
    eligible: () => true,
  },
  {
    id: "algo", dest: "algo", eyebrow: "From PropBetEdge · PBE Algo",
    headlines: ["A call on every eligible bout, locked before the fight"],
    body: "PBE Algo win probabilities are locked on the database clock before each fight and graded after it, with the record published in full.",
    cta: "See PBE Algo", href: "/algo", external: false,
    eligible: (c) => c.algoActive,
  },
  {
    id: "round_by_round", dest: "round_by_round", eyebrow: "From PropBetEdge · Round-by-Round",
    headlines: ["See how the rounds actually went", "The fight, round by round"],
    body: "Round-level striking and grappling from UFC's official fight statistics, with each round measured on its own.",
    cta: "Open Round-by-Round", href: "/round-by-round", external: false,
    eligible: () => true,
  },
  {
    id: "tuf", dest: "tuf", eyebrow: "From PropBetEdge · The Ultimate Fighter",
    headlines: ["The Ultimate Fighter, season by season", "Where the TUF alumni went next"],
    body: "Seasons, coaches, finales and alumni careers, built from the fight record.",
    cta: "Explore the TUF archive", href: "/tuf", external: false,
    eligible: () => true,
  },
  {
    id: "store", dest: "store", eyebrow: "From PropBetEdge · Store",
    headlines: ["The PropBetEdge fight store"],
    body: "Original PropBetEdge apparel and gear for fight night.",
    cta: "Shop the store", href: "/store", external: false,
    eligible: () => true,
  },
];

const NETWORK_CAMPAIGNS: Campaign[] = NETWORK.sports
  .filter((s): s is NetworkSport & { key: SportKey } => s.key !== CURRENT_SPORT && /^https:\/\//.test(s.href))
  .map((s) => ({
    id: `network_${s.key}` as CampaignId, dest: s.key, sport: s.key,
    eyebrow: "From the PropBetEdge network",
    headlines: [`${s.name} from PropBetEdge`],
    body: `${s.blurb.replace(/\.?$/, ".")} The same data-first approach, built for the ${s.label}.`,
    cta: `Visit PropBetEdge ${s.label}`, href: s.href, external: false,
    eligible: () => true,
  }));

export const CAMPAIGNS: readonly Campaign[] = [...UFC_CAMPAIGNS, ...NETWORK_CAMPAIGNS];

export type StoryClass = "preview" | "results" | "rankings" | "fight_week" | "tuf" | "data" | "general";

const TUF = /\b(the ultimate fighter|tuf|hall of fame|history|historic|legacy|all-time|all time)\b/i;
const DATA = /\b(data|stats?|statistic(s|al)?|numbers|analytics|metrics?)\b/i;

export function classifyStory(ctx: Pick<PromoContext, "storyType" | "slug" | "headline">): StoryClass {
  const text = `${ctx.headline} ${ctx.slug.replace(/-/g, " ")}`;
  if (TUF.test(text)) return "tuf";
  switch (ctx.storyType) {
    case "fight_preview": return "preview";
    case "results": return "results";
    case "rankings": return "rankings";
    case "weigh_in": case "card_change": return "fight_week";
    default: return DATA.test(text) ? "data" : "general";
  }
}

const NET = 1; // each network sport: an occasional guest, never the house campaign
const WEIGHTS: Record<StoryClass, Partial<Record<CampaignId, number>>> = {
  preview: { pro: 30, fight_dna: 25, algo: 25, fight_week: 20, ufc_api: 15, store: 3 },
  results: { round_by_round: 35, fight_dna: 25, pro: 20, ufc_api: 15, store: 3 },
  rankings: { fight_dna: 35, ufc_api: 30, pro: 25, store: 3 },
  fight_week: { fight_week: 40, pro: 30, ufc_api: 20, store: 3 },
  tuf: { tuf: 45, fight_dna: 25, ufc_api: 20, store: 3 },
  data: { ufc_api: 50, fight_dna: 20, pro: 15, round_by_round: 8, store: 2 },
  general: { ufc_api: 20, pro: 20, fight_dna: 20, fight_week: 15, round_by_round: 8, tuf: 5, store: 4 },
};

export function weightsFor(cls: StoryClass): Map<CampaignId, number> {
  const w = new Map<CampaignId, number>(Object.entries(WEIGHTS[cls]) as Array<[CampaignId, number]>);
  for (const c of NETWORK_CAMPAIGNS) w.set(c.id, NET);
  return w;
}

/** FNV-1a 32-bit with a murmur3 finaliser, as a fraction in (0, 1). Stable
 *  across runtimes; slugs that share long suffixes still spread evenly. */
export function stableFraction(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = Math.imul((h ^ (h >>> 16)) >>> 0, 0x85ebca6b) >>> 0;
  h = Math.imul((h ^ (h >>> 13)) >>> 0, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h + 0.5) / 0x100000000;
}

export type PromoSelection = {
  campaign: Campaign;
  headline: string;
  storyClass: StoryClass;
  rotationVersion: string;
  network: Array<{ key: string; label: string; href: string }>;
};

/**
 * Weighted rendezvous hashing: every eligible campaign draws a stable score for
 * this article, u^(1/weight), and the highest score wins. Removing a campaign
 * (a Pro reader, a product going dark) moves only the articles that campaign
 * had won; adding one (PBE Algo going live) takes only the articles it now
 * outscores. Everyone else keeps their campaign.
 */
export function selectPromo(ctx: PromoContext, version = ROTATION_VERSION): PromoSelection {
  const storyClass = classifyStory(ctx);
  const draw = (weights: Map<CampaignId, number>) => {
    let best: Campaign | null = null, bestScore = -1;
    for (const c of CAMPAIGNS) {
      const w = weights.get(c.id) ?? 0;
      if (w <= 0 || !c.eligible(ctx)) continue;
      const score = Math.pow(stableFraction(`${version}|${ctx.slug}|${c.id}`), 1 / w);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  };
  // A class whose every campaign is ineligible for this reader falls back to
  // the general pool rather than rendering nothing.
  const campaign = draw(weightsFor(storyClass)) ?? draw(weightsFor("general")) ?? CAMPAIGNS[0];
  const headline = campaign.headlines[Math.floor(stableFraction(`${version}|${ctx.slug}|headline|${campaign.id}`) * campaign.headlines.length)];
  const network = NETWORK.sports
    .filter((s) => s.key !== CURRENT_SPORT && s.key !== campaign.sport && /^https:\/\//.test(s.href))
    .map((s) => ({ key: s.key, label: s.label, href: s.href }));
  return { campaign, headline, storyClass, rotationVersion: version, network };
}

/* Click/impression events: first-party, no vendor, no tracking parameters. */
export const PROMO_CAMPAIGN_IDS = new Set<string>(CAMPAIGNS.map((c) => c.id));
export const PROMO_DESTINATIONS = new Set<string>([...CAMPAIGNS.map((c) => c.dest), ...NETWORK.sports.map((s) => s.key)]);
export const PROMO_SLUG = /^[a-z0-9-]{1,160}$/;
