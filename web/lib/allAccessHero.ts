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
 * membership contract (lib/pbe-membership.js); nothing is restated here. */
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL, STATES, type Membership, type MembershipState } from "./pbe-membership.js";

export const ALL_ACCESS_SPORTS_LINE = "MLB · NFL · NBA · NHL · WNBA · UFC · Tennis";
export const ALL_ACCESS_SPORTS_NEXT = "plus every Pro sport added next.";
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
  tagline: string;
  sportsLine: string;
  sportsNext: string;
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
    tagline: ALL_ACCESS_OFFER.tagline,
    sportsLine: ALL_ACCESS_SPORTS_LINE,
    sportsNext: ALL_ACCESS_SPORTS_NEXT,
    promoLine: ALL_ACCESS_OFFER.promoLine,
    promoCode: ALL_ACCESS_OFFER.promoCode,
    checkoutUrl: ALL_ACCESS_OFFER.checkoutUrl,
    learnUrl: ALL_ACCESS_URL,
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
