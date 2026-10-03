/* Customer source boundary (PropBetEdge network standard "DATA · PropSports", 2026-10-03).
 * PropBetEdge-authored article text (headline, dek, body) names PropSports, not the collection lane that
 * supplied the numbers. Stored rows are untouched, so nothing is regenerated or re-revised; named publishers
 * ("ESPN's 30 under 30", Sherdog reporting) and image credits are not rewritten. Used by the web reads and
 * by the ufc-api envelope. */
export function brandText(s: string): string {
  return s
    .replace(/\b([Rr])ound-level UFC ?Stats\b/g, "$1ound-level stats")
    .replace(/\bUFC ?Stats\b/g, "PropSports");
}
const ARTICLE_TEXT = ["headline", "dek", "body_md"] as const;
export function brandArticle<T>(a: T): T {
  if (!a || typeof a !== "object") return a;
  const out = { ...(a as Record<string, unknown>) };
  for (const k of ARTICLE_TEXT) if (typeof out[k] === "string") out[k] = brandText(out[k] as string);
  return out as T;
}
/* Deep variant for API payloads: rewrites only article text keys wherever they sit. */
export function brandArticlesDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(brandArticlesDeep) as unknown as T;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof x === "string" ? ((ARTICLE_TEXT as readonly string[]).includes(k) ? brandText(x) : x) : brandArticlesDeep(x);
  }
  return out as T;
}
