/* UFC premium account surface — presentation model (owner decisions 2026-10-05).
 *
 * Renders FROM the server verdict (lib/access.ts → UfcAccess); it never decides
 * or widens access. Three jobs that used to share one constant are separate:
 *   LOCAL_ALL_ACCESS_PATH    the native /all-access page on this site (all
 *                            informational All Access navigation)
 *   NETWORK_ALL_ACCESS_URL   propbetedge.ai/pro, reference only
 *   ALL_ACCESS_CHECKOUT_URL  the canonical Stripe link (explicit purchase CTAs only)
 * "Platinum" is presentation for the all_access state. The backend state, the
 * Stripe product and the vendored membership contract are unchanged. */
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL, type Membership, type MembershipState } from "./pbe-membership.js";

export const LOCAL_ALL_ACCESS_PATH = "/all-access";
export const NETWORK_ALL_ACCESS_URL = ALL_ACCESS_URL;
export const ALL_ACCESS_CHECKOUT_URL = ALL_ACCESS_OFFER.checkoutUrl;
export const PLATINUM_TRUTH = "PropBetEdge All Access · 10 sports + Predictions";

export type Designation = { badge: string; eyebrow: string; status: string; truth: string | null; tone: "pro" | "platinum" | "owner" };

/** Member designation per state. FREE has none: a signed-in non-member is never labelled FREE. */
export function designation(state: MembershipState | null | undefined): Designation | null {
  if (state === "sport_pro") return { badge: "UFC PRO MEMBER", eyebrow: "UFC · PRO MEMBER", status: "UFC PRO ACTIVE", truth: "UFC Pro · Fight Intelligence", tone: "pro" };
  if (state === "all_access") return { badge: "◆ PLATINUM", eyebrow: "UFC · PLATINUM MEMBER", status: "PLATINUM ACCESS ACTIVE", truth: PLATINUM_TRUTH, tone: "platinum" };
  if (state === "owner") return { badge: "VERIFIED OWNER", eyebrow: "UFC · VERIFIED OWNER", status: "OWNER ACCESS ACTIVE", truth: null, tone: "owner" };
  return null;
}

/** Short header/badge label; null for non-members (the header shows Sign in instead). */
export function badgeLabel(state: MembershipState | null | undefined): string | null {
  return designation(state)?.badge ?? null;
}

export type ViewInput = {
  signedIn: boolean;
  pro: boolean;
  ledger: string;
  membership: Pick<Membership, "state">;
  /** A UFC account cookie resolved to an account row (identity only, not access). */
  hasAccount: boolean;
};
export type AccountView = "signed_out" | "check" | "signed_in" | "sport_pro" | "all_access" | "owner";

/** One view per verdict. An unreachable billing ledger with a known account is
 *  the access-check state: never sales, never "signed out", never FREE. */
export function accountView(a: ViewInput): AccountView {
  if (!a.signedIn) return a.hasAccount && a.ledger === "unavailable" ? "check" : "signed_out";
  if (!a.pro) return a.ledger === "unavailable" ? "check" : "signed_in";
  const s = a.membership.state;
  return s === "owner" ? "owner" : s === "all_access" ? "all_access" : "sport_pro";
}

/** The header/member link. Platinum members, and network sessions (which have no
 *  UFC account row for /account), go to the local network page; UFC accounts go
 *  to /account. Never off-site. */
export function memberHref(state: MembershipState | null | undefined, source?: string | null): string {
  return state === "all_access" || source === "network" ? LOCAL_ALL_ACCESS_PATH : "/account";
}

export type Capability = { key: string; label: string; sub: string; href: string };

/* What UFC Pro actually unlocks on this site, by live route. Kept to products
 * that exist; nothing here is a promise about a future feature. */
export const UFC_CAPABILITIES: readonly Capability[] = Object.freeze([
  { key: "fight-dna", label: "Fight DNA", sub: "Full fighter profiles", href: "/fighters" },
  { key: "matchup", label: "Matchup DNA", sub: "Head-to-head intelligence", href: "/fight-week" },
  { key: "algo", label: "PBE Algo", sub: "Model fight calls", href: "/algo" },
  { key: "picks", label: "PBE Picks", sub: "Official card", href: "/algo/card" },
  { key: "simulator", label: "Fight Simulator", sub: "PBE Labs", href: "/simulator" },
  { key: "market", label: "Model + Market", sub: "Event market intelligence", href: "/events" },
  { key: "previews", label: "Preview Intelligence", sub: "DNA + market in previews", href: "/news" },
  { key: "track-record", label: "Track Record", sub: "Graded PBE history", href: "/algo/record" },
]);
