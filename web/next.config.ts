import type { NextConfig } from "next";
import { JUDGE_ALIASES, judgeSlug } from "./lib/judgeScoring";
import { retiredFighterSlugRedirects } from "./lib/retiredFighterSlugs";

const supabaseHost = (() => {
  try { return new URL(process.env.SUPABASE_URL || "https://tkmlnhmylqnttmnsnief.supabase.co").hostname; } catch { return "tkmlnhmylqnttmnsnief.supabase.co"; }
})();

/* One entry per merged spelling whose slug differs from its canonical. */
function retiredJudgeSlugRedirects() {
  const out = [];
  for (const [raw, alias] of Object.entries(JUDGE_ALIASES)) {
    if (alias.kind !== "spelling_variant") continue;
    const from = judgeSlug(raw);
    const to = judgeSlug(alias.canonical);
    if (!from || !to || from === to) continue;
    out.push({ source: `/judges/${from}`, destination: `/judges/${to}`, permanent: true });
  }
  return out;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /* Crawlers that get metadata rendered into <head> before the response
   * streams. Next 15.5 streams title/canonical/robots into the body for every
   * other client on an uncached render (React hoists them after hydration),
   * and its default list leaves out Googlebot and Bingbot. A sitemap sweep
   * found 2,096 of 3,108 first renders with the canonical after </head>.
   * Next's default pattern (next/dist/shared/lib/router/utils/html-bots.js,
   * 15.5) plus the two search crawlers; setting this replaces the default. */
  htmlLimitedBots: /Googlebot|Bingbot|[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "propbetedge.ai" },
      { protocol: "https", hostname: "a.espncdn.com", pathname: "/i/headshots/mma/players/full/**" },
      { protocol: "https", hostname: supabaseHost, pathname: "/storage/v1/object/public/**" },
    ],
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
      { source: "/brand/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/feed.xml", headers: [{ key: "Cache-Control", value: "public, s-maxage=600, stale-while-revalidate=3600" }] },
    ];
  },
  async redirects() {
    return [
      { source: "/rss", destination: "/feed.xml", permanent: true },
      { source: "/rss.xml", destination: "/feed.xml", permanent: true },
      // /picks is the phrase people type; /model is the page. A config
      // redirect rather than a second route, so there is one canonical URL and
      // the alias never competes with it in search.
      { source: "/picks", destination: "/model", permanent: true },
      /* Retired judge profile URLs.
       *
       * Merging two spellings into one official retires a slug that was a live,
       * linkable page. The page component also redirects, but that path only
       * runs after a profile lookup misses, and a config redirect is the one
       * mechanism that cannot be reached too late. Derived from the alias table
       * itself so the list cannot drift away from the merges it represents. */
      ...retiredJudgeSlugRedirects(),
      /* Retired fighter URLs, same reasoning: a merged duplicate's UFC
       * Stats-keyed profile must 308 before the streaming page can answer 200. */
      ...retiredFighterSlugRedirects(),
    ];
  },
};

export default nextConfig;