import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getArticleBySlug, getImageById, getFightersByIds, getImagesForFighters, getEventById, getArticles, getBoutById, getWireFor } from "@/lib/db";
import { JsonLd, ProLock, Breadcrumbs, Avatar, Octagon, StoryCard, FighterRow } from "@/components/ui";
import { renderMarkdown, excerpt, readingMinutes } from "@/lib/markdown";
import { fighterSlug, eventSlug, matchupSlug } from "@/lib/slug";
import { fmtDateTime, fmtDate, eventStatusLabel, locationLine, relTime } from "@/lib/format";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";
import { storyMedia } from "@/lib/faces";
import { Mark } from "@/components/Brand";
import { BettorsEdge, MatchupModule, MarketWatch, Methodology, type FactBlock } from "@/components/editorial";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = await getArticleBySlug((await params).slug);
  if (!a) return { title: "Story not found", robots: { index: false } };
  const hero = a.hero_image_ref ? await getImageById(a.hero_image_ref) : null;
  return {
    title: a.headline, description: a.dek || excerpt(a.body_md), alternates: { canonical: `/news/${a.slug}` },
    openGraph: { type: "article", title: a.headline, description: a.dek || excerpt(a.body_md), publishedTime: a.published_at || undefined, modifiedTime: a.updated_at, authors: [SITE.desk], section: STORY_TYPE_LABEL[a.story_type] || a.story_type, url: `${SITE.url}/news/${a.slug}`, ...(hero ? { images: [{ url: hero.card, width: 800, height: 1000 }] } : {}) },
    twitter: { card: "summary_large_image", title: a.headline, description: a.dek || undefined },
  };
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const a = await getArticleBySlug((await params).slug);
  if (!a) notFound();
  const [hero, fighters, event, bout, moreRes] = await Promise.all([
    a.hero_image_ref ? getImageById(a.hero_image_ref) : null,
    getFightersByIds(a.fighter_ids || []),
    a.event_id ? getEventById(a.event_id) : null,
    a.bout_id ? getBoutById(a.bout_id) : null,
    getArticles(4),
  ]);
  const [imgs, wire] = await Promise.all([getImagesForFighters(fighters.map((f) => f.id)), getWireFor(a.event_id, a.fighter_ids || [])]);
  const more = moreRes.rows.filter((x) => x.id !== a.id).slice(0, 3);
  const moreMedia = await storyMedia(more);
  const faces = bout ? [bout.fighter_a, bout.fighter_b] : fighters.slice(0, 2);
  const label = STORY_TYPE_LABEL[a.story_type] || a.story_type;
  const fb = (a.fact_block || {}) as FactBlock;
  const angle = fb.bettor_angle && (fb.bettor_angle.summary || fb.bettor_angle.markets?.length) ? fb.bettor_angle : null;
  const mm = fb.matchup?.a && fb.matchup?.b ? fb.matchup : null;
  const mmImgs = mm ? await getImagesForFighters([mm.a.fighter_id, mm.b.fighter_id]) : new Map();

  return (
    <article className="wrap page article">
      <Breadcrumbs items={[{ name: "News", href: "/news" }, { name: label, href: `/news?type=${a.story_type}` }, { name: a.headline }]} />
      <div className="eyebrow">{label}{event ? <> · <Link href={`/events/${eventSlug(event)}`}>{event.name}</Link></> : null}</div>
      <h1>{a.headline}</h1>
      {a.dek && <p className="dek">{a.dek}</p>}
      <div className="byline">
        <Mark size={28} />
        <span><b>{SITE.desk}</b> · {a.published_at ? fmtDateTime(a.published_at) : ""}{a.updated_at && a.published_at && a.updated_at.slice(0, 16) !== a.published_at.slice(0, 16) ? ` · updated ${fmtDate(a.updated_at.slice(0, 10))}` : ""} · {readingMinutes(a.body_md)} min read</span>
      </div>

      <div className="article-hero">
        {hero ? <img src={hero.portrait} alt={faces[0]?.name || a.headline} width={1200} height={1500} fetchPriority="high" decoding="async" /> : (
          <div className="gen">
            <Octagon className="oc" />
            {faces.length > 0 && (
              <div className="faces">
                <Avatar f={faces[0]} img={imgs.get(faces[0].id)} size={120} />
                {faces[1] && <><span className="vs">vs</span><Avatar f={faces[1]} img={imgs.get(faces[1].id)} size={120} /></>}
              </div>
            )}
            <div className="txt"><small>{label}</small><b>{event ? event.name : a.headline}</b></div>
          </div>
        )}
      </div>
      {hero && (
        <div className="credit mb-5">Photo: {hero.source_url ? <a href={hero.source_url} rel="noopener nofollow" target="_blank">{hero.author || a.hero_credit?.author || "Wikimedia Commons"}</a> : hero.author}{hero.license ? ` · ${hero.license}` : ""} · via Wikimedia Commons</div>
      )}

      {angle && <BettorsEdge angle={angle} />}
      {mm && <MatchupModule a={mm.a} b={mm.b} imgs={mmImgs} edges={mm.edges} href={bout && event ? `/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}` : null} />}

      <div className="grid-side">
        <div>
          <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body_md) }} />
          {fb.market_watch && <MarketWatch mw={fb.market_watch} />}
          {a.story_type === "fight_preview" && !angle && <div style={{ maxWidth: "72ch" }}><ProLock /></div>}
          {fb.version ? <Methodology fb={fb} updated={a.updated_at} /> : (
            <p className="faint label mt-6">Written by the {SITE.desk} from PropBetEdge's own fight tables and a stored fact block. Read the <Link href="/about" className="dim">editorial policy</Link>.</p>
          )}
        </div>
        <aside className="stack" style={{ gap: 24 }}>
          {bout && event && (
            <div className="card hi">
              <div className="eyebrow mb-3">The bout</div>
              <div className="stack" style={{ gap: 6 }}>
                <FighterRow f={bout.fighter_a} img={imgs.get(bout.fighter_a.id)} />
                <FighterRow f={bout.fighter_b} img={imgs.get(bout.fighter_b.id)} />
              </div>
              <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} className="btn mt-4" style={{ width: "100%" }}>Matchup page →</Link>
            </div>
          )}
          {!bout && fighters.length > 0 && (
            <div className="card">
              <div className="eyebrow mb-3">Fighters in this story</div>
              <div className="stack" style={{ gap: 6 }}>{fighters.slice(0, 6).map((f) => <FighterRow key={f.id} f={f} img={imgs.get(f.id)} />)}</div>
            </div>
          )}
          {wire.length > 0 && (
            <div className="card">
              <div className="eyebrow mb-3">From the live wire</div>
              <ul className="wire">
                {wire.map((n) => (
                  <li key={n.id}>
                    <a href={n.url || "#"} rel="noopener nofollow" target="_blank">{n.title}</a>
                    <span className="src">{n.source?.name || "Source"} · {relTime(n.published_at)}</span>
                  </li>
                ))}
              </ul>
              <p className="faint label mt-3">Attributed headlines linked to this story's fighters or event. We reproduce at most a phrase.</p>
            </div>
          )}
          {event && (
            <Link href={`/events/${eventSlug(event)}`} className="card link">
              <div className="eyebrow mb-2">{eventStatusLabel(event)}</div>
              <div className="serif" style={{ fontSize: 18, fontWeight: 800, color: "var(--pbe-paper)" }}>{event.name}</div>
              <div className="mono faint label mt-2">{fmtDate(event.event_date)}{locationLine(event) ? ` · ${locationLine(event)}` : ""}</div>
              <div className="gold sm mt-3" style={{ fontWeight: 600 }}>Full card →</div>
            </Link>
          )}
        </aside>
      </div>

      {more.length > 0 && (
        <section className="segment">
          <h3>More from the desk</h3>
          <div className="news">{more.map((x) => <StoryCard key={x.id} a={x} hero={x.hero_image_ref ? moreMedia.heroes.get(x.hero_image_ref) : null} faces={moreMedia.faces.get(x.id)} />)}</div>
        </section>
      )}

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "NewsArticle", "@id": `${SITE.url}/news/${a.slug}#article`, headline: a.headline, description: a.dek || excerpt(a.body_md),
        image: hero ? [hero.portrait, hero.card] : [`${SITE.url}/news/${a.slug}/opengraph-image`],
        datePublished: a.published_at || undefined, dateModified: a.updated_at, url: `${SITE.url}/news/${a.slug}`, articleSection: label, inLanguage: "en-US",
        author: { "@type": "Organization", "@id": `${SITE.url}/#desk`, name: SITE.desk, url: SITE.url },
        publisher: { "@type": "Organization", "@id": `${SITE.parent}/#org`, name: "PropBetEdge", logo: { "@type": "ImageObject", url: SITE.logo.full600 } },
        mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE.url}/news/${a.slug}` }, isAccessibleForFree: true,
        about: [
          ...(event ? [{ "@type": "SportsEvent", name: event.name, startDate: event.event_date, url: `${SITE.url}/events/${eventSlug(event)}` }] : []),
          ...fighters.map((f) => ({ "@type": "Person", name: f.name, url: `${SITE.url}/fighters/${fighterSlug(f)}` })),
        ],
        wordCount: a.body_md.split(/\s+/).length,
      }} />
    </article>
  );
}
