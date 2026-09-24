/* Types for lib/pbe-membership.js, the byte-identical copy of the shared
 * PropBetEdge membership contract (propbetedge-workers shared/membership).
 * Never edit the .js here: change the canonical source first, then copy. */

export type MembershipState = "free" | "sport_pro" | "all_access" | "owner";
export type AccessSource = "sport" | "all_access" | "owner";
export type SportKey = "mlb" | "nfl" | "nba" | "nhl" | "wnba" | "ufc";

/** The browser-safe object a session/account endpoint returns. */
export type Membership = {
  contract: string;
  sport: string;
  state: MembershipState;
  label: string;
  entitled: boolean;
  access_source: AccessSource | null;
  product_key: string | null;
  plan: string | null;
  email: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  manage_url: string;
  network_url: string;
  show_purchase_cta: boolean;
  show_all_access_upgrade: boolean;
  show_manage: boolean;
};

export type DeriveMembershipInput = {
  sport: string;
  entitled?: boolean;
  accessSource?: string | null;
  productKey?: string | null;
  plan?: string | null;
  email?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
};

export type NetworkEntry = { key: SportKey; label: string; name: string; url: string };

export const CONTRACT_VERSION: string;
export const SPORT_LABELS: Readonly<Record<SportKey, string>>;
export const ALL_ACCESS_URL: string;
export const MANAGE_URL: string;
export const ALL_ACCESS_OFFER: Readonly<{
  name: string;
  productKey: string;
  price: string;
  priceUsd: number;
  tagline: string;
  promoCode: string;
  promoLine: string;
  checkoutUrl: string;
  learnUrl: string;
}>;
export const NETWORK: ReadonlyArray<NetworkEntry>;
export const STATES: ReadonlyArray<MembershipState>;

export function deriveMembership(input?: DeriveMembershipInput): Membership;
export function membershipLabel(state: MembershipState | string, sport?: string | null): string;
export function readMembership(value: unknown, sport: string): Membership;
export function planText(m: Membership | null | undefined): string;
export function membershipBadgeHtml(m: Membership | null | undefined): string;
export function manageLinkHtml(m: Membership | null | undefined, label?: string): string;
export function allAccessCardHtml(m: Membership | null | undefined, opts?: { compact?: boolean }): string;
export function networkLinksHtml(currentSport?: string | null): string;
export function accountPanelHtml(m: Membership | null | undefined, opts?: { sport?: string }): string;
