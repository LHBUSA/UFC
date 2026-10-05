/* PropBetEdge "All Access first" commercial hierarchy, as UFC applies it.
 *
 * All Access is the PRIMARY offer on every purchase surface; UFC Pro is the
 * single-sport alternative beneath an "ONLY WANT UFC?" seam. This module is
 * the one place that decides WHAT the hero says for a membership state, so the
 * TSX (components/Membership.tsx) only lays it out and the tests can pin the
 * decision without a DOM:
 *
 *   free        ALL ACCESS hero, then the UFC Pro plan
 *   sport_pro   UPGRADE TO ALL ACCESS hero, no UFC purchase
 *   all_access  nothing to sell: null
 *   owner       nothing to sell: null
 *
 * Every commercial fact (price, promo, checkout link) comes from the shared
 * membership contract (lib/pbe-membership.js); nothing is restated here.
 *
 * What the membership CONTAINS comes from the vendored network registry
 * (lib/family.json, generated from LHBUSA/propbetedge-workers
 * shared/network/pbe-network.js): its sports are counted as sports, its
 * products (PropBetEdge Predictions) are shown as included intelligence and
 * are never counted as a sport. */
import { ALL_ACCESS_OFFER, STATES, type Membership, type MembershipState } from "./pbe-membership.js";
import { LOCAL_ALL_ACCESS_PATH } from "./accountSurface.ts";
import family from "./family.json" with { type: "json" };

type FamilyEntry = { key: string; label: string; name: string; url: string };
const FAMILY = family as { sports: FamilyEntry[]; products: FamilyEntry[] };

/** A sport's customer label: the short league label, or the product name when
 *  the registry names the product rather than the league (F1 Intelligence). */
function sportLabel(s: FamilyEntry): string {
  return s.name.startsWith("PropBetEdge ") ? s.label : s.name;
}

/** Every sport All Access includes today, in registry order. Products are not sports. */
export const ALL_ACCESS_SPORTS: ReadonlyArray<{ key: string; label: string }> = Object.freeze(FAMILY.sports.map((s) => ({ key: s.key, label: sportLabel(s) })));
export const ALL_ACCESS_SPORT_COUNT = ALL_ACCESS_SPORTS.length;
export const ALL_ACCESS_SPORTS_LINE = ALL_ACCESS_SPORTS.map((s) => s.label).join(" · ");

const PREDICTIONS_ENTRY = FAMILY.products.find((p) => p.key === "predictions");
if (!PREDICTIONS_ENTRY) throw new Error("lib/family.json: PropBetEdge Predictions product missing");
/** Included intelligence product. Counted separately from the sports, never "free". */
export const ALL_ACCESS_PREDICTIONS = Object.freeze({
  key: PREDICTIONS_ENTRY.key,
  name: PREDICTIONS_ENTRY.name,
  url: PREDICTIONS_ENTRY.url,
  blurb: "Independent, source-backed forecasts with model probability, market comparison and a scored record.",
});

export const ALL_ACCESS_VALUE_LINE = `${ALL_ACCESS_SPORT_COUNT} sports + ${ALL_ACCESS_PREDICTIONS.name}.`;
export const ALL_ACCESS_SECONDARY = "One membership across the PropBetEdge intelligence network.";
export const ALL_ACCESS_UPGRADE_LINE = `Add the entire PropBetEdge network — ${ALL_ACCESS_SPORT_COUNT} sports plus ${ALL_ACCESS_PREDICTIONS.name} — under one membership.`;
export const ALL_ACCESS_FUTURE_LINE = "Future PropBetEdge Pro sports join All Access at launch.";
export const ALL_ACCESS_MINI_LINE = `${ALL_ACCESS_SPORT_COUNT} sports + Predictions →`;
export const ALL_ACCESS_ACTIVE_LINE = `${ALL_ACCESS_SPORT_COUNT} sports + Predictions included`;
/** What the network contains, honestly scoped: features vary by sport. */
export const ALL_ACCESS_CAPABILITIES: ReadonlyArray<{ key: string; name: string; note: string }> = Object.freeze([
  { key: "picks", name: "PBE Picks", note: "Official qualified calls" },
  { key: "dna", name: "Player / Team DNA", note: "Proprietary performance intelligence" },
  { key: "pbecast", name: "PBEcast", note: "Live intelligence surfaces" },
  { key: "model", name: "Model + Market", note: "Probability, fair line and market context" },
  { key: "research", name: "Simulation + Research", note: "Advanced sport-specific intelligence" },
  { key: "records", name: "Track Records", note: "Permanent graded evidence" },
]);
export const ALL_ACCESS_CAPABILITIES_NOTE = "Where supported — features vary by sport.";
export const ALL_ACCESS_BADGE = "BEST VALUE · MOST COMPLETE";
export const ALL_ACCESS_EYEBROW = "PROPBETEDGE NETWORK";
export const ALL_ACCESS_DIVIDER = "ONLY WANT UFC?";

/** States that are never sold anything: no hero, no CTA, no Stripe link. */
export const NO_HERO_STATES: ReadonlySet<MembershipState> = new Set<MembershipState>(["all_access", "owner"]);

export type AllAccessHeroModel = {
  state: MembershipState;
  upgrade: boolean;
  title: "ALL ACCESS" | "UPGRADE TO ALL ACCESS";
  eyebrow: string;
  badge: string;
  price: string;
  amount: string;
  cadence: string;
  valueLine: string;
  secondary: string;
  sports: ReadonlyArray<{ key: string; label: string; owned: boolean }>;
  sportsLine: string;
  sportCount: number;
  predictions: typeof ALL_ACCESS_PREDICTIONS;
  capabilities: typeof ALL_ACCESS_CAPABILITIES;
  capabilitiesNote: string;
  futureLine: string;
  miniLine: string;
  promoLine: string;
  promoCode: string;
  checkoutUrl: string;
  learnUrl: string;
  ctaLabel: "GET ALL ACCESS";
  learnLabel: "WHAT'S INCLUDED";
};

export function membershipState(m: Membership | null | undefined): MembershipState {
  return m && STATES.includes(m.state) ? m.state : "free";
}

/** True when the reader can still be sold the network umbrella. */
export function shouldRenderAllAccessHero(m: Membership | null | undefined): boolean {
  return !NO_HERO_STATES.has(membershipState(m));
}

/** The hero's content for a membership, or null when there is nothing to sell. */
export function allAccessHeroModel(m: Membership | null | undefined): AllAccessHeroModel | null {
  const state = membershipState(m);
  if (NO_HERO_STATES.has(state)) return null;
  const upgrade = state === "sport_pro";
  const [amount, cadence] = String(ALL_ACCESS_OFFER.price).split("/");
  return {
    state,
    upgrade,
    title: upgrade ? "UPGRADE TO ALL ACCESS" : "ALL ACCESS",
    eyebrow: ALL_ACCESS_EYEBROW,
    badge: ALL_ACCESS_BADGE,
    price: ALL_ACCESS_OFFER.price,
    amount,
    cadence,
    valueLine: ALL_ACCESS_VALUE_LINE,
    /* A UFC Pro member already owns UFC: lead with what the network ADDS. */
    secondary: upgrade ? ALL_ACCESS_UPGRADE_LINE : ALL_ACCESS_SECONDARY,
    sports: ALL_ACCESS_SPORTS.map((s) => ({ ...s, owned: upgrade && s.key === "ufc" })),
    sportsLine: ALL_ACCESS_SPORTS_LINE,
    sportCount: ALL_ACCESS_SPORT_COUNT,
    predictions: ALL_ACCESS_PREDICTIONS,
    capabilities: ALL_ACCESS_CAPABILITIES,
    capabilitiesNote: ALL_ACCESS_CAPABILITIES_NOTE,
    futureLine: ALL_ACCESS_FUTURE_LINE,
    miniLine: ALL_ACCESS_MINI_LINE,
    promoLine: ALL_ACCESS_OFFER.promoLine,
    promoCode: ALL_ACCESS_OFFER.promoCode,
    checkoutUrl: ALL_ACCESS_OFFER.checkoutUrl,
    learnUrl: LOCAL_ALL_ACCESS_PATH,
    ctaLabel: "GET ALL ACCESS",
    learnLabel: "WHAT'S INCLUDED",
  };
}

/** The promo line split around the code so the code can be typeset as a chip. */
export function promoParts(model: Pick<AllAccessHeroModel, "promoLine" | "promoCode">): { before: string; code: string; after: string } {
  const i = model.promoLine.indexOf(model.promoCode);
  if (i < 0) return { before: model.promoLine, code: "", after: "" };
  return { before: model.promoLine.slice(0, i), code: model.promoCode, after: model.promoLine.slice(i + model.promoCode.length) };
}
