import type { Metadata } from "next";
import Link from "next/link";
import { getArticles, getArticleTypeCounts, getNewsItems } from "@/lib/db";
import { storyMedia } from "@/lib/faces";
import { Empty, PageHead, StoryCard, JsonLd, SectionHead } from "@/components/ui";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";
import { relTime } from "@/lib/format";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "UFC News — Fight Previews, Results, Card Changes & Rankings",
  description: "Fight previews with tale of the tape, results with round-by-round stats, card changes, weigh-in reports and rankings moves, written from PropBetEdge's own fight data.",
  alternates: { canonical: "/news", types: { "application/rss+xml": `${SITE.url}/feed.xml` } },
  openGraph: { title: "UFC News from the PropBetEdge desk", description: "Previews, results, card changes and rankings, written from the data.", url: `${SITE.url}/news` },
};

const PAGE = 18;

export default async function NewsPage({ searchParams }: { searchParams: Promise<{ type?: string; page?: string }> }) {
  const sp = await searchParams;
  const type = sp.type && STORY_TYPE_LABEL[sp.type] ? sp.type : "";
  const page = Math.max(1, Number(sp.page) || 1);
  const [{ rows, count }, typeCounts, wire] = await Promise.all([getArticles(PAGE, type || undefined, (page - 1) * PAGE), getArticleTypeCounts(), getNewsItems(10)]);
  const media = await storyMedia(rows);
  const pages = count ? Math.ceil(count / PAGE) : 1;
  const feature = page === 1 && !type ? rows[0] : null;
  const rest = feature ? rows.slice(1) : rows;

  return (
    <div className="wrap page">
      <PageHead crumbs={[{ name: "News" }]} eyebrow="Newsroom" title={type ? STORY_TYPE_LABEL[type] : "UFC news from the desk"}
        lede="Every story is built from our own tables: fight previews with the tale of the tape, results with round stats, card changes and rankings moves. External reporting is attributed and linked, never rewritten.">
        <nav className="chips mt-5" aria-label="Story type">
          <Link href="/news" aria-current={!type ? "true" : undefined}>All{count != null && !type ? ` · ${count}` : ""}</Link>
          {Object.entries(STORY_TYPE_LABEL).filter(([k]) => typeCounts.get(k)).map(([k, v]) => <Link key={k} href={`/news?type=${k}`} aria-current={type === k ? "true" : undefined}>{v} · {typeCounts.get(k)}</Link>)}
          <a href="/feed.xml">RSS</a>
        </nav>
      </PageHead>

      {rows.length ? (
        <>
          <div className="news">
            {feature && <StoryCard a={feature} feature hero={feature.hero_image_ref ? media.heroes.get(feature.hero_image_ref) : null} faces={media.faces.get(feature.id)} />}
            {rest.map((a) => <StoryCard key={a.id} a={a} hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} />)}
          </div>
          {pages > 1 && (
            <nav className="pager" aria-label="Pagination">
              {page > 1 && <Link href={`/news?${type ? `type=${type}&` : ""}page=${page - 1}`} className="btn">← Newer</Link>}
              <span className="btn ghost mono">{page} / {pages}</span>
              {page < pages && <Link href={`/news?${type ? `type=${type}&` : ""}page=${page + 1}`} className="btn">Older →</Link>}
            </nav>
          )}
        </>
      ) : (
        <Empty title={type ? `No ${STORY_TYPE_LABEL[type].toLowerCase()} stories yet` : "Nothing published yet"} cta={{ href: "/events", label: "See the next card" }}>
          The newsroom only publishes when there is something real to say. Stories arrive with each card: previews in fight week, results the morning after. Subscribe to the RSS feed to be there when they do.
        </Empty>
      )}

      {wire.length > 0 && (
        <div className="mt-7">
          <SectionHead eyebrow="Around MMA" title="The wire" />
          <ul className="wire">
            {wire.map((n) => (
              <li key={n.id}>
                <a href={n.url || "#"} rel="noopener nofollow" target="_blank">{n.title}{n.taxonomy?.labels?.[0] && n.taxonomy.labels[0] !== "other" ? <span className="lab">{n.taxonomy.labels[0].replace("_", " ")}</span> : null}</a>
                <span className="src">{n.source?.name || "Source"} · {relTime(n.published_at)}</span>
              </li>
            ))}
          </ul>
          <p className="faint label mt-3">Headlines from the sources we monitor, linked to the original. We reproduce at most a phrase and never rewrite someone else's reporting.</p>
        </div>
      )}

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "CollectionPage", name: "UFC news", url: `${SITE.url}/news`, isPartOf: { "@id": `${SITE.url}/#site` },
        mainEntity: { "@type": "ItemList", itemListElement: rows.map((a, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE.url}/news/${a.slug}`, name: a.headline })) },
      }} />
    </div>
  );
}
