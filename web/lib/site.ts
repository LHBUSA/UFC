export const SITE = {
  name: "PropBetEdge UFC",
  shortName: "PBE UFC",
  tagline: "Fight Intelligence",
  url: "https://ufc.propbetedge.ai",
  /* Data plane. This is fetched at runtime by lib/dna.ts, lib/wire.ts and the
   * live wire rail, so it is not a link and must never be repointed to a
   * marketing site. The developer product lives in `ufcApi` below. */
  api: "https://ufc-api.propbetedge.ai",
  /* The commercial UFC Intelligence API: a destination for readers, not an
   * endpoint. Kept separate from `api` above and from `network.api`, which is
   * the cross-sport PropSports entry point and still belongs where it is. */
  ufcApi: "https://ufc.proptechusa.ai",
  ufcApiDocs: "https://ufc.proptechusa.ai/docs",
  description:
    "PropBetEdge UFC: live fight-week intelligence, complete card context, fighter dossiers, Fight DNA, official rankings, results, history and a source-disciplined MMA newsroom.",
  parent: "https://propbetedge.ai",
  billingPortal: "https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00",
  network: {
    mlb: "https://mlb.propbetedge.ai",
    nfl: "https://nfl.propbetedge.ai",
    api: "https://propsports.proptechusa.ai",
  },
  brand: {
    mark: "/brand/mark.svg",
    logo: "/brand/logo.svg",
    logoWide: "/brand/logo-wide.svg",
    og: "/opengraph-image",
  },
  logo: {
    mark80: "https://propbetedge.ai/logo/pbe-mark-80.png",
    mark160: "https://propbetedge.ai/logo/pbe-mark-160.png",
    full400: "https://propbetedge.ai/logo/pbe-full-400.png",
    mark240: "https://propbetedge.ai/logo/pbe-mark-240.png",
    full600: "https://propbetedge.ai/logo/pbe-full-600.png",
  },
  publisher: "PropTechUSA.ai",
  desk: "PropBetEdge UFC Desk",
  twitter: "@propbetedge",
  contact: "sales@proptechusa.ai",
} as const;

/* Primary navigation registry. Every route below stays live; `place` decides
 * where the link renders:
 *   primary  the desktop bar and the top of the mobile menu
 *   more     the accessible "More ▾" menu (grouped) and the mobile "More" group
 *   logo     the wordmark already links here (no duplicate text link on desktop)
 *   cta      rendered as the Go Pro button, not as a text link
 * All Access is sold on /pro, the account page, the purchase surfaces and the
 * footer, never from the header bar (owner decision).
 * Removing a link from the bar never removes a route. */
export type NavPlace = "primary" | "more" | "logo" | "cta";
export const NAV: ReadonlyArray<{ href: string; label: string; place?: NavPlace; group?: string; flagship?: boolean }> = [
  { href: "/", label: "Home", place: "logo" },
  { href: "/fight-week", label: "Fight Week", place: "primary" },
  /* The current official PBE Algo picks. Top level on purpose: /algo is the
   * method, /algo/card is the picks, /algo/record is the track record.
   * flagship: the one primary item with its own treatment (signal dot + PRO
   * badge, NavLinks + pbe-flagship.css). PRO, never LIVE: the product holds
   * provisional fight-week calls and locked calls, not live-game odds. */
  { href: "/algo/card", label: "PBE PICKS", place: "primary", flagship: true },
  { href: "/events", label: "Schedule", place: "primary" },
  { href: "/fighters", label: "Fighters", place: "primary" },
  { href: "/rankings", label: "Rankings", place: "primary" },
  { href: "/news", label: "News", place: "primary" },
  { href: "/store", label: "Store", place: "primary" },
  /* Keep time-sensitive fight-week utilities easy to reach without forcing
   * two long labels into the top-level bar. They render first in More and stay
   * fully exposed in the mobile menu. */
  { href: "/weigh-ins", label: "Weigh-Ins", place: "more", group: "Fight Week" },
  { href: "/injuries", label: "Injuries & Withdrawals", place: "more", group: "Fight Week" },
  { href: "/contender-series", label: "DWCS", place: "more", group: "Contender Series" },
  { href: "/tuf", label: "The Ultimate Fighter", place: "more", group: "Contender Series" },
  { href: "/history", label: "History", place: "more", group: "Archive" },
  { href: "/hall-of-fame", label: "Hall of Fame", place: "more", group: "Archive" },
  { href: "/algo", label: "PBE Algo", place: "more", group: "Intelligence" },
  { href: "/model", label: "PBE Model", place: "more", group: "Intelligence" },
  { href: "/round-by-round", label: "Round-by-Round", place: "more", group: "Intelligence" },
  { href: "/referees", label: "Referees", place: "more", group: "Intelligence" },
  { href: "/judges", label: "Judges & Scorecards", place: "more", group: "Intelligence" },
  { href: "/#notable-voices", label: "Notable Voices", place: "more", group: "Intelligence" },
  { href: "/learn/fight-dna", label: "How Fight DNA works", place: "more", group: "Intelligence" },
  /* The parent network, last and alone. Kept out of the primary bar on
   * purpose: "News" there is the UFC newsroom, and a second news link beside it
   * would read as a duplicate. Same-tab: propbetedge.ai is first-party.
   * Literal (not NETWORK.news.href) so scripts/preservation-diff.mjs sees it. */
  { href: "https://propbetedge.ai/", label: "Sports News", place: "more", group: "PropBetEdge" },
  { href: "/pro", label: "Pro", place: "cta" },
] as const;

export const STORY_TYPE_LABEL: Record<string, string> = {
  card_change: "Card change",
  rankings: "Rankings",
  fight_preview: "Fight preview",
  weigh_in: "Weigh-in",
  results: "Results",
  line_move: "Line move",
  external: "Around MMA",
};

export const INK = "#14110d";
export const INK2 = "#1d1914";
export const INK3 = "#2a241c";
export const PAPER = "#f5f1eb";
export const PAPER2 = "#e8e1d4";
export const DIM = "#b8b3a8";
export const FAINT = "#8e8a80";
export const GOLD = "#d4af37";
export const GOLD_BRIGHT = "#e9c75a";
export const CRIMSON = "#c1273d";
