/* Google Preferred Sources — source policy shared across the PropBetEdge network.
 * Reference implementation: LHBUSA/propbetedge-news-site src/components/preferred-source.js.
 *
 * Checked in google.com/preferences/source on 2026-09-30:
 *   listed:     propbetedge.ai, mlb.propbetedge.ai, ufc.propbetedge.ai -> Google SDK, own host
 *   not listed: nfl/nba/wnba/nhl/tennis/soccer.propbetedge.ai        -> deeplink to propbetedge.ai
 * The SDK always adds the current page's source (canonical URL), so it is only
 * used on hosts Google lists; everywhere else the control targets the parent.
 */

export const PARENT_SOURCE = "propbetedge.ai";
export const ELIGIBLE_SOURCES = new Set(["propbetedge.ai", "mlb.propbetedge.ai", "ufc.propbetedge.ai"]);
/* This site's canonical host: server-rendered markup targets it, so the
 * no-JS / SDK-blocked href is right in production. */
export const SITE_SOURCE = "ufc.propbetedge.ai";
export const PREFERRED_SOURCE_SDK = "https://news.google.com/swg/js/v1/publisher.js";

export function preferredSourceTarget(host: string): { source: string; sdk: boolean } {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (ELIGIBLE_SOURCES.has(h)) return { source: h, sdk: true };
  return { source: PARENT_SOURCE, sdk: false };
}

export function preferredSourceDeeplink(source: string): string {
  return `https://www.google.com/preferences/source?q=${encodeURIComponent(source)}`;
}
