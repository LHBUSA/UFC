import { getArticles, getImageById } from "@/lib/db";
import { renderMarkdown, excerpt } from "@/lib/markdown";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";

export const revalidate = 600;

const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET() {
  const { rows } = await getArticles(50);
  const items = await Promise.all(rows.map(async (a) => {
    const url = `${SITE.url}/news/${a.slug}`;
    const hero = a.hero_image_ref ? await getImageById(a.hero_image_ref) : null;
    const img = hero ? hero.card : `${SITE.url}/news/${a.slug}/opengraph-image`;
    return `
    <item>
      <title>${esc(a.headline)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      ${a.published_at ? `<pubDate>${new Date(a.published_at).toUTCString()}</pubDate>` : ""}
      <category>${esc(STORY_TYPE_LABEL[a.story_type] || a.story_type)}</category>
      <dc:creator>${esc(SITE.desk)}</dc:creator>
      <description>${esc(a.dek || excerpt(a.body_md))}</description>
      <content:encoded><![CDATA[${renderMarkdown(a.body_md)}]]></content:encoded>
      <media:content url="${esc(img)}" medium="image" />
      <enclosure url="${esc(img)}" type="image/${img.endsWith(".jpg") ? "jpeg" : "png"}" length="0" />
    </item>`;
  }));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${esc(SITE.name)} — News</title>
    <link>${SITE.url}/news</link>
    <atom:link href="${SITE.url}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>${esc("Fight previews, results with round stats, card changes and rankings moves from PropBetEdge UFC, written from the data.")}</description>
    <language>en-us</language>
    <copyright>© ${new Date().getFullYear()} ${esc(SITE.publisher)}</copyright>
    <image><url>${SITE.url}/apple-icon</url><title>${esc(SITE.name)}</title><link>${SITE.url}</link></image>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>30</ttl>${items.join("")}
  </channel>
</rss>`;
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, s-maxage=600, stale-while-revalidate=3600" } });
}
