import { NextResponse, type NextRequest } from "next/server";
import { stripUtm } from "@/lib/seo";

/* Marketing UTMs never belong in an indexable URL.
 *
 * Search Console reported an impression-bearing
 * /events/...?utm_source=propbetedge&utm_medium=fight_week_rail&utm_campaign=ufc_fight_week
 * The page already emits a clean self-canonical, but a canonical is a hint;
 * a permanent redirect is not. Only utm_* keys are removed. Every functional
 * query parameter (?q=, ?season=, ?series=, ...) is preserved as-is.
 *
 * The matcher's `has` conditions mean this runs ONLY for requests carrying a
 * UTM key, so ordinary navigation never invokes middleware at all. The site
 * reads no UTM value anywhere; attribution comes from the referrer. */
export function middleware(req: NextRequest) {
  const search = stripUtm(req.nextUrl.search);
  if (search === null) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.search = search;
  return NextResponse.redirect(url, 308);
}

/* Next reads `config` statically at build time, so the matcher must be a
 * literal: one entry per key, because `has` conditions are AND-ed. */
export const config = {
  matcher: [
    { source: "/((?!_next/|api/).*)", has: [{ type: "query", key: "utm_source" }] },
    { source: "/((?!_next/|api/).*)", has: [{ type: "query", key: "utm_medium" }] },
    { source: "/((?!_next/|api/).*)", has: [{ type: "query", key: "utm_campaign" }] },
    { source: "/((?!_next/|api/).*)", has: [{ type: "query", key: "utm_term" }] },
    { source: "/((?!_next/|api/).*)", has: [{ type: "query", key: "utm_content" }] },
  ],
};
