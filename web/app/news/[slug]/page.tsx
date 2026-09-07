import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getArticleBySlug, getImageById, getFightersByIds, getImagesForFighters, getEventById, getArticles, getBoutById, getWireFor, getVideosForArticle, getVideosForBout, getVideosForEvent } from "@/lib/db";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { JsonLd, ProLock, Breadcrumbs, Avatar, Octagon, FighterRow } from "@/components/ui";
import { NewsStoryCard } from "@/components/NewsStoryCard";
import { renderMarkdown, excerpt, readingMinutes } from "@/lib/markdown";
import { fighterSlug, eventSlug, matchupSlug } from "@/lib/slug";
import { fmtDateTime, fmtDate, eventStatusLabel, locationLine, relTime } from "@/lib/format";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";
import { storyMedia } from "@/lib/faces";
import { getMatchupDna } from "@/lib/dna";
import { DnaEvidence } from "@/components/dna";
import { Mark } from "@/components/Brand";
import { BettorsEdge, MatchupModule, MarketWatch, Methodology, type FactBlock } from "@/components/editorial";

export const revalidate = 300;

function materiallyUpdated(published: string | null, updated: string): boolean {
  if (!published || !updated) return false;
  const p = Date.parse(published), u = Date.parse(updated);
  return Number.isFinite(p) && Number.isFinite(u) && u - p >= 5 * 60 * 1000;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = await getArticleBySlug((await params).slug);
  if (!a) return { title: "Story not found", robots: { index: false } };
  const description = a.dek || excerpt(a.body_md);
  const label = STORY_TYPE_LABEL[a.story_type] || a.story_type;
  const ogImage = `${SITE.url}/news/${a.slug}/opengraph-image`;
  return {
    title: a.headline,
    description,
    category: "sports",
    authors: [{ name: SITE.desk, url: `${SITE.url}/about` }],
    keywords: ["UFC", "MMA", label, "UFC fight intelligence", "UFC analysis", "PropBetEdge UFC"],
    alternates: { canonical: `/news/${a.slug}` },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
    openGraph: {
      type: "article",
      title: a.headline,
      description,
      publishedTime: a.published_at || undefined,
      modifiedTime: a.updated_at,
      authors: [SITE.desk],
      section: label,
      tags: ["UFC", "MMA", label, "Fight Intelligence"],
      url: `${SITE.url}/news/${a.slug}`,
      images: [{ url: ogImage, width: 1200, height: 630, alt: a.headline }],
    },
    twitter: {
      card: "summary_large_image",
      title: a.headline,
      description,
      images: [ogImage],
    },
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
  const [imgs, wire, vidArticle, vidBout, vidEvent] = await Promise.all([getImagesForFighters(fighters.map((f) => f.id)), getWireFor(a.event_id, a.fighter_ids || []), getVideosForArticle(a.id).catch(() => []), a.bout_id ? getVideosForBout(a.bout_id).catch(() => []) : Promise.resolve([]), a.event_id ? getVideosForEvent(a.event_id, 3).catch(() => []) : Promise.resolve([])]);
  const seen = new Set<string>();
  const videos = [...vidArticle, ...vidBout, ...vidEvent].filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true))).slice(0, 4);
  const more = moreRes.rows.filter((x) => x.id !== a.id).slice(0, 3);
  const moreMedia = await storyMedia(more);
  const faces = bout ? [bout.fighter_a, bout.fighter_b] : fighters.slice(0, 2);
  const label = STORY_TYPE_LABEL[a.story_type] || a.story_type;
  const fb = (a.fact_block || {}) as FactBlock;
  const angle = fb.bettor_angle && (fb.bettor_angle.summary || fb.bettor_angle.markets?.length) ? fb.bettor_angle : null;
  const mm = fb.matchup?.a && fb.matchup?.b ? fb.matchup : null;
  const mmImgs = mm ? await getImagesForFighters([mm.a.fighter_id, mm.b.fighter_id]) : new Map();
  const dna = bout && a.story_type === "fight_preview" ? await getMatchupDna(bout.fighter_a.id, bout.fighter_b.id) : null;
  const updated = materiallyUpdated(a.published_at, a.updated_at);
  const articleUrl = `${SITE.url}/news/${a.slug}`;
  const keywords = [...new Set(["UFC", "MMA", label, event?.name, ...fighters.map((f) => f.name), "PropBetEdge UFC", "Fight Intelligence"].filter(Boolean))];

  return (
    <article className="wrap page article">
      <Breadcrumbs items={[{ name: "News", href: "/news" }, { name: label, href: `/news?type=${a.story_type}` }, { name: a.headline }]} />
      <div className="eyebrow">{label}{event ? <> · <Link href={`/events/${eventSlug(event)}`}>{event.name}</Link></> : null}</div>
      <h1>{a.headline}</h1>
      {a.dek && <p className="dek">{a.dek}</p>}
      <div className="byline article-freshness">
        <Mark size={28} />
        <span>
          <b>{SITE.desk}</b>
          {a.published_at ? <> · Published <time dateTime={a.published_at}>{fmtDateTime(a.published_at)}</time></> : null}
          {updated ? <> · Updated <time dateTime={a.updated_at}>{fmtDateTime(a.updated_at)}</time></> : null}
          {` · ${readingMinutes(a.body_md)} min read`}
        </span>
      </div>

      <div className={`article-hero${hero ? " has-media" : ""}`}>
        {hero ? (
          <>
            <img className="article-hero-bg" src={hero.card} alt="" aria-hidden="true" width={800} height={1000} decoding="async" />
            <img className="article-hero-subject" src={hero.portrait} alt={faces[0]?.name || a.headline} width={1200} height={1500} fetchPriority="high" decoding="async" />
          </>
        ) : (
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
      {dna && dna.status === "ok" && <DnaEvidence dna={dna.data} />}
      {mm && <MatchupModule a={mm.a} b={mm.b} imgs={mmImgs} edges={mm.edges} href={bout && event ? `/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}` : null} />}
      <VideoRail videos={videos} title="Official video for this story" eyebrow="Official UFC channel" feature={videos.length === 1} note="Publisher-hosted video from the official channel linked to this fight, card or story · not hosted by PropBetEdge" />

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
          <div className="news">{more.map((x) => <NewsStoryCard key={x.id} a={x} hero={x.hero_image_ref ? moreMedia.heroes.get(x.hero_image_ref) : null} faces={moreMedia.faces.get(x.id)} />)}</div>
        </section>
      )}

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "@id": `${articleUrl}#article`,
        url: articleUrl,
        headline: a.headline,
        description: a.dek || excerpt(a.body_md),
        image: hero ? [hero.portrait, hero.card, `${articleUrl}/opengraph-image`] : [`${articleUrl}/opengraph-image`],
        thumbnailUrl: `${articleUrl}/opengraph-image`,
        datePublished: a.published_at || undefined,
        dateModified: a.updated_at,
        articleSection: label,
        articleBody: undefined,
        inLanguage: "en-US",
        genre: ["Sports journalism", "Fight analysis"],
        keywords,
        wordCount: a.body_md.trim().split(/\s+/).length,
        isAccessibleForFree: true,
        author: { "@type": "NewsMediaOrganization", "@id": `${SITE.url}/#desk`, name: SITE.desk, url: SITE.url },
        publisher: {
          "@type": "NewsMediaOrganization",
          "@id": `${SITE.url}/#desk`,
          name: SITE.desk,
          url: SITE.url,
          logo: { "@type": "ImageObject", url: `${SITE.url}${SITE.brand.logoWide}`, width: 600, height: 160 },
        },
        mainEntityOfPage: { "@type": "WebPage", "@id": articleUrl },
        isPartOf: { "@id": `${SITE.url}/#site` },
        about: [
          ...(event ? [{ "@type": "SportsEvent", name: event.name, startDate: event.event_date, url: `${SITE.url}/events/${eventSlug(event)}`, sport: "Mixed Martial Arts" }] : []),
          ...fighters.map((f) => ({ "@type": "Person", name: f.name, url: `${SITE.url}/fighters/${fighterSlug(f)}` })),
        ],
        mentions: fighters.map((f) => ({ "@type": "Person", name: f.name, url: `${SITE.url}/fighters/${fighterSlug(f)}` })),
        speakable: { "@type": "SpeakableSpecification", cssSelector: [".article h1", ".article .dek"] },
        video: videos.length ? videoJsonLd(videos) : undefined,
      }} />
    </article>
  );
}
