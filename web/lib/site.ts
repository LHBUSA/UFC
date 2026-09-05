export const SITE = {
  name: "PropBetEdge UFC",
  shortName: "PBE UFC",
  tagline: "Fight Intelligence OS",
  url: "https://ufc.propbetedge.ai",
  description:
    "PropBetEdge UFC is a fight intelligence operating system: upcoming cards, card changes, fighter pages, event pages, rankings and a self-improving model that prices fight winner, method and rounds against the market.",
  parent: "https://propbetedge.ai",
  network: {
    mlb: "https://propbetedge.ai",
    nfl: "https://nfl.propbetedge.ai",
  },
  logo: {
    mark80: "https://propbetedge.ai/logo/pbe-mark-80.png",
    mark160: "https://propbetedge.ai/logo/pbe-mark-160.png",
    mark240: "https://propbetedge.ai/logo/pbe-mark-240.png",
    full400: "https://propbetedge.ai/logo/pbe-full-400.png",
    full600: "https://propbetedge.ai/logo/pbe-full-600.png",
  },
  pricing: {
    monthly: "$14.99/mo",
    cardPass: "$5.99/card",
  },
  publisher: "PropTechUSA.ai",
  twitter: "@propbetedge",
} as const;

export const NAV = [
  { href: "/", label: "Home" },
  { href: "/events", label: "Events" },
  { href: "/fighters", label: "Fighters" },
  { href: "/rankings", label: "Rankings" },
  { href: "/news", label: "News" },
  { href: "/pro", label: "Pro" },
] as const;
