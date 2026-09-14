import { sitemapFiles, SITEMAP_REVALIDATE } from "@/lib/sitemap";
import { sitemapIndexXml } from "@/lib/sitemapRules";
import { SITE } from "@/lib/site";

/* /sitemap.xml is a sitemap index. Children live under /sitemaps/ and are
 * segmented by entity; see lib/sitemap.ts for populations and exclusions. */
/* Rendered on request, never prerendered at build: the population reads are
 * strict, and a build must not fail because the database blinked. The CDN
 * caches the response for SITEMAP_REVALIDATE seconds (s-maxage). */
export const dynamic = "force-dynamic";

export async function GET() {
  const files = await sitemapFiles();
  return new Response(sitemapIndexXml(files.map((f) => `${SITE.url}/sitemaps/${f}`)), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=0, s-maxage=${SITEMAP_REVALIDATE}, stale-while-revalidate=86400`,
    },
  });
}
