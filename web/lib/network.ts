/* The PropBetEdge network, as every sports product should present it.
 *
 * One registry, two consumers here: the footer (PropBetEdge column + Sports
 * rail) and the More menu's PropBetEdge group. The shape is the convention
 * the other sports products copy — see docs/PROPBETEDGE_NETWORK_CONVENTION.md.
 *
 * Rules the data encodes:
 *   - A sport is listed only while it has a public destination. Remove the
 *     entry (do not point it at a placeholder) if a product goes dark.
 *   - First-party network links are plain same-tab links: no nofollow, no
 *     target=_blank just because the hostname differs.
 *   - PROPBETEDGE_DISCORD_URL is the one canonical, non-expiring invite
 *     (confirmed by the owner 2026-09-11). Every product uses this exact
 *     value; never mint a per-product invite. Replaced dead codes: HPzYDAng,
 *     8rMxrMG5, e9S6pFq9, Cn57R2MG, QsBmfgXd, 7AGkr9XG, YfQd2JkQ.
 *   - The store link carries this product's collection context. The UFC app
 *     is the network's only live checkout today, so for UFC that is the local
 *     /store. When propbetedge.ai/store ships on the same commerce engine it
 *     becomes /store/ufc there, and ufc.propbetedge.ai/store/... keeps
 *     resolving (see the convention doc — print, order and checkout paths
 *     are never redirected). */

export type NetworkSport = { key: "mlb" | "nfl" | "ufc" | "nhl" | "nba"; label: string; name: string; blurb: string; href: string };

export const CURRENT_SPORT: NetworkSport["key"] = "ufc";

export const PROPBETEDGE_DISCORD_URL = "https://discord.gg/kb5zCTHbME";

export const NETWORK = {
  news: { label: "Sports News", href: "https://propbetedge.ai/" },
  store: { label: "Store", href: "/store" },
  discord: PROPBETEDGE_DISCORD_URL as string | null,
  sports: [
    { key: "mlb", label: "MLB", name: "Baseball Intelligence", blurb: "Live markets, model research, archives", href: "https://mlb.propbetedge.ai/" },
    { key: "nfl", label: "NFL", name: "Football Intelligence", blurb: "Prop board, Model Lab, Player DNA", href: "https://nfl.propbetedge.ai/" },
    { key: "ufc", label: "UFC", name: "Fight Intelligence", blurb: "Cards, fighters, rankings, newsroom", href: "/" },
    { key: "nhl", label: "NHL", name: "Hockey Intelligence", blurb: "PBE Cast, goalies, shot maps, props", href: "https://nhl.propbetedge.ai/" },
    { key: "nba", label: "NBA", name: "Basketball Intelligence", blurb: "NBACast, injuries, matchups, props", href: "https://nba.propbetedge.ai/" },
  ] as readonly NetworkSport[],
} as const;
