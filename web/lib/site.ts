export const SITE = {
  name: "PropBetEdge UFC",
  shortName: "PBE UFC",
  tagline: "Fight Intelligence",
  url: "https://ufc.propbetedge.ai",
  api: "https://ufc-api.propbetedge.ai",
  description:
    "PropBetEdge UFC: live fight-week intelligence, complete card context, fighter dossiers, Fight DNA, official rankings, results, history and a source-disciplined MMA newsroom.",
  parent: "https://propbetedge.ai",
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
  pricing: {
    monthly: "$14.99/mo",
    cardPass: "$5.99/card",
  },
  checkout: {
    monthly: "https://buy.stripe.com/cNi00j0nQfKSbRX9ID7wA0r",
    cardPass: "https://buy.stripe.com/eVqaEX1rUbuC09f5sn7wA0s",
  },
  publisher: "PropTechUSA.ai",
  desk: "PropBetEdge UFC Desk",
  twitter: "@propbetedge",
  contact: "sales@localhomebuyersusa.com",
} as const;

export const NAV = [
  { href: "/", label: "Home" },
  { href: "/events", label: "Schedule" },
  { href: "/fighters", label: "Fighters" },
  { href: "/rankings", label: "Rankings" },
  { href: "/history", label: "History" },
  { href: "/news", label: "News" },
  { href: "/pro", label: "Pro" },
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
