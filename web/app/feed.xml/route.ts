import { getArticles } from "@/lib/db";
import { SITE } from "@/lib/site";

export const revalidate = 600;

const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET() {
  const articles = await getArticles(50);
  const items = articles.map((a) => `
    <item>
      <title>${esc(a.headline)}</title>
      <link>${SITE.url}/news/${a.slug}</link>
      <guid isPermaLink="true">${SITE.url}/news/${a.slug}</guid>
      ${a.published_at ? `<pubDate>${new Date(a.published_at).toUTCString()}</pubDate>` : ""}
      <category>${esc(a.story_type)}</category>
      ${a.dek ? `<description>${esc(a.dek)}</description>` : ""}
    </item>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE.name)} — News</title>
    <link>${SITE.url}/news</link>
    <atom:link href="${SITE.url}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>${esc("Card changes, weigh-in reports, results and previews from PropBetEdge UFC.")}</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, s-maxage=600, stale-while-revalidate=3600" } });
}
