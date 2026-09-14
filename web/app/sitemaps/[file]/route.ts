import { sitemapChild, SITEMAP_REVALIDATE } from "@/lib/sitemap";
import { urlsetXml } from "@/lib/sitemapRules";

/* One child sitemap: pages.xml, events.xml, news.xml, officials.xml,
 * fighters-N.xml, fights-N.xml. An unknown name or an out-of-range chunk is a
 * 404. A failed population read throws (5xx) rather than publishing a partial
 * file. */
/* Rendered on request (Next 15 GET handlers are dynamic by default), never
 * at build, so a build never depends on the database. The CDN caches the
 * response (s-maxage) and each population page read sits in the data cache
 * for SITEMAP_REVALIDATE seconds. */

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const urls = await sitemapChild(file);
  if (!urls) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(urlsetXml(urls), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=0, s-maxage=${SITEMAP_REVALIDATE}, stale-while-revalidate=86400`,
    },
  });
}
