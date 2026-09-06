export const SITE = {
  name: "PropBetEdge UFC",
  shortName: "PBE UFC",
  tagline: "Fight Intelligence",
  url: "https://ufc.propbetedge.ai",
  description:
    "PropBetEdge UFC: every card, every fighter, every round. Live fight cards with main card and prelims, fighter profiles with fight history and round stats, official rankings by division, A-vs-B tale of the tape, and a newsroom written from the data.",
  parent: "https://propbetedge.ai",
  network: {
    mlb: "https://propbetedge.ai",
    nfl: "https://nfl.propbetedge.ai",
    api: "https://propsports.proptechusa.ai",
  },
  /* Local vector brand system (public/brand) plus the parent raster marks. */
  brand: {
    mark: "/brand/mark.svg",
    logo: "/brand/logo.svg",
    logoWide: "/brand/logo-wide.svg",
    og: "/opengraph-image",
  },
  logo: {
    mark160: "https://propbetedge.ai/logo/pbe-mark-160.png",
    mark240: "https://propbetedge.ai/logo/pbe-mark-240.png",
    full600: "https://propbetedge.ai/logo/pbe-full-600.png",
  },
  pricing: {
    monthly: "$14.99/mo",
    cardPass: "$5.99/card",
  },
  publisher: "PropTechUSA.ai",
  desk: "PropBetEdge UFC Desk",
  twitter: "@propbetedge",
  contact: "sales@localhomebuyersusa.com",
} as const;

export const NAV = [
  { href: "/", label: "Home" },
  { href: "/events", label: "Events" },
  { href: "/fighters", label: "Fighters" },
  { href: "/rankings", label: "Rankings" },
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

/* Brand colours used by server-rendered images (OG cards, icons). */
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
