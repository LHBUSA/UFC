import Link from "next/link";
import { type Article, getImageById, getFightersByIds, getImagesForFighters, getEventById, getArticles, getBoutById, getWireFor, getVideosForArticle, getVideosForBout, getVideosForEvent, getVideoStates } from "@/lib/db";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { storyImageIds, storyFaces, storySubject, sameFighterName, loadStoryImages } from "@/lib/storyImages";
import { renderablePlanVideos, railInitialSelection, isViewable, type PlanVideo } from "@/lib/videoPolicy";
import { JsonLd, ProLock, Breadcrumbs, Avatar, Octagon, FighterRow } from "@/components/ui";
import { NewsStoryCard } from "@/components/NewsStoryCard";
import { renderMarkdown, renderMarkdownBlocks, excerpt, readingMinutes } from "@/lib/markdown";
import { fighterSlug, eventSlug, matchupSlug } from "@/lib/slug";
import { fmtDateTime, fmtDate, eventStatusLabel, locationLine, relTime } from "@/lib/format";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";
import { storyMedia } from "@/lib/faces";
import { getMatchupDna } from "@/lib/dna";
import { DnaEvidence } from "@/components/dna";
import { Mark } from "@/components/Brand";
import { BettorsEdge, MatchupModule, MarketWatch, Methodology, type FactBlock } from "@/components/editorial";
import {
  BoutContextModule, ComparisonModule, DnaModule, RecentFormModule, RoundStyleModule,
  MarketModule, OfficialVideoModule, MethodologyModule, FighterCardModule,
  ArticleBody, ChartSet, CLAIMED_CHARTS,
  chartsOf, planAngle, moduleOf, type ContentPlan,
} from "@/components/plan";


function materiallyUpdated(published: string | null, updated: string): boolean {
  if (!published || !updated) return false;
  const p = Date.parse(published), u = Date.parse(updated);
  return Number.isFinite(p) && Number.isFinite(u) && u - p >= 5 * 60 * 1000;
}

/**
 * One article, rendered.
 *
 * Lives apart from the route so the public page and the desk preview render
 * BYTE-FOR-BYTE the same thing. A preview that draws an article differently
 * from the way it will publish is worse than no preview: it invites you to sign
 * off on a page nobody will ever see.
 */
export async function StoryView({ a, preview = false }: { a: Article; preview?: boolean }) {
  const [hero, fighters, event, bout, moreRes] = await Promise.all([
    a.hero_image_ref ? getImageById(a.hero_image_ref) : null,
    getFightersByIds(a.fighter_ids || []),
    a.event_id ? getEventById(a.event_id) : null,
    a.bout_id ? getBoutById(a.bout_id) : null,
    getArticles(4),
  ]);
  const fb = (a.fact_block || {}) as FactBlock & { content_plan?: ContentPlan; primary?: { name?: string; fighter_id?: string }; opponent?: { name?: string; fighter_id?: string } };
  /* Two article generations live in this table at once. Articles written by
   * ufc-news-enrich carry a deterministic content_plan; everything written
   * before it carries the v2 fact block the legacy modules were built for.
   * The page renders whichever it finds and never mixes them, because a page
   * that fell back from one to the other would show a reader a module built
   * from a DIFFERENT packet than the sentence beside it. */
  const plan = (fb.content_plan && Array.isArray(fb.content_plan.modules) ? fb.content_plan : null) as ContentPlan | null;
  const mm = !plan && fb.matchup?.a && fb.matchup?.b ? fb.matchup : null;
  const planVideoCopies = plan ? (moduleOf<{ videos?: PlanVideo[] }>(plan, "official_video")?.data.videos || []) : null;
  /* Every face this page can draw -- article fighters, BOTH sides of the
   * linked bout, the legacy matchup pair -- in one image request (issue #19:
   * the opponent used to be drawn from a map that never requested them). */
  const imageIds = storyImageIds(a.fighter_ids, bout, mm ? [mm.a.fighter_id, mm.b.fighter_id] : []);
  const [imgs, wire, vidArticle, vidBout, vidEvent, liveVideoState] = await Promise.all([loadStoryImages(imageIds, getImagesForFighters), getWireFor(a.event_id, a.fighter_ids || []), getVideosForArticle(a.id).catch(() => []), a.bout_id ? getVideosForBout(a.bout_id).catch(() => []) : Promise.resolve([]), a.event_id ? getVideosForEvent(a.event_id, 3).catch(() => []) : Promise.resolve([]), planVideoCopies?.length ? getVideoStates(planVideoCopies.map((v) => String(v.video_id || ""))).catch(() => new Map()) : Promise.resolve(new Map())]);
  const seen = new Set<string>();
  const videos = [...vidArticle, ...vidBout, ...vidEvent].filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true))).slice(0, 4);
  const more = moreRes.rows.filter((x) => x.id !== a.id).slice(0, 3);
  const moreMedia = await storyMedia(more);
  const faces = storyFaces(bout, fighters);
  /* The subject card and the hero photo are about the story's PRIMARY
   * fighter, who is bout.fighter_b as often as fighter_a. Resolve by id;
   * faces[0] would put the opponent's photo on the subject's card now that
   * the opponent's image is in the map. */
  const people = [...fighters, ...(bout ? [bout.fighter_a, bout.fighter_b] : [])];
  const subject = storySubject(fb.primary?.fighter_id, a.fighter_ids, people);
  const cardName = plan ? moduleOf<{ name?: string }>(plan, "fighter_card")?.data?.name : null;
  /* The card is built for fact_block.primary; an id match is proof, a subject
   * found by fallback must at least carry the card's name. */
  const cardFighter = subject && (subject.id === fb.primary?.fighter_id || sameFighterName(subject.name, cardName)) ? subject : null;
  const heroName = hero?.fighter_id ? people.find((f) => f.id === hero.fighter_id)?.name : subject?.name;
  const label = STORY_TYPE_LABEL[a.story_type] || a.story_type;
  const charts = chartsOf(plan);
  const planNames = { a: fb.primary?.name || subject?.name, b: fb.opponent?.name };
  const legacyAngle = fb.bettor_angle && (fb.bettor_angle.summary || fb.bettor_angle.markets?.length) ? fb.bettor_angle : null;
  const angle = plan ? planAngle(plan) : legacyAngle;
  const dna = bout && a.story_type === "fight_preview" ? await getMatchupDna(bout.fighter_a.id, bout.fighter_b.id) : null;
  /* Structured data must describe the page, not the database.
   *
   * The legacy rail showed up to four videos: the story's own, then the bout's,
   * then the event's. The content plan is stricter -- it serves only clips that
   * matched this story's own subject at a known tier -- so on a plan article the
   * page now shows two where JSON-LD still advertised four, including two
   * VideoObjects for videos that are nowhere on the page. That is exactly the
   * mismatch structured-data validators exist to catch, and it is a regression
   * introduced by making the on-page selection stricter without following
   * through to the markup. So when a plan owns the video, it owns the markup.
   *
   * Same rule for availability (issue #19): the JSON-LD list IS the rendered
   * list. A video the policy suppressed (known region block, embed disabled,
   * rejected) is on neither; a legacy rail's region-blocked fallback card is
   * rendered but cannot play, so it is not advertised either. */
  const planVideos = planVideoCopies ? renderablePlanVideos(planVideoCopies, liveVideoState) : null;
  const jsonLdVideos = planVideos
    ? planVideos.map((v) => ({
        title: v.title, description: v.title, thumbnail_url: v.thumbnail_url,
        published_at: v.published_at, duration_sec: v.duration_sec,
        provider_video_id: v.video_id, url: v.url, channel_name: v.publisher,
        source_metadata: v.language ? { language: v.language } : null,
      }))
    : railInitialSelection(videos, 3).filter((v) => isViewable(v));
  const updated = materiallyUpdated(a.published_at, a.updated_at);
  const articleUrl = `${SITE.url}/news/${a.slug}`;
  const keywords = [...new Set(["UFC", "MMA", label, event?.name, ...fighters.map((f) => f.name), "PropBetEdge UFC", "Fight Intelligence"].filter(Boolean))];

  return (
    <article className="wrap page article">
      {preview && (
        <div className="preview-banner" role="status">
          <b>Desk preview</b>
          <span>
            This story is <code>{a.status}</code> and is not public. It is shown here exactly as it would publish,
            so the reason it was held can be judged against the page itself rather than a log line.
          </span>
        </div>
      )}
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
            <img className="article-hero-subject" src={hero.portrait} alt={heroName || a.headline} width={1200} height={1500} fetchPriority="high" decoding="async" />
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
      {!plan && dna && dna.status === "ok" && <DnaEvidence dna={dna.data} />}
      {mm && <MatchupModule a={mm.a} b={mm.b} imgs={imgs} edges={mm.edges} href={bout && event ? `/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}` : null} />}
      {/* The plan owns video when it has one: it resolved the clips against
        * this story's own subject and knows at which tier they matched, which
        * the generic rail cannot. The rail stays for legacy articles. */}
      {!plan && <VideoRail videos={videos} title="Watch · official video for this story" eyebrow="Official channels · matched to this bout, card or story" feature={videos.length === 1} max={3} note="Publisher-hosted video from the official channel linked to this fight, card or story · not hosted by PropBetEdge" />}

      <div className="grid-side">
        <div>
          {plan ? (
            <ArticleBody
              md={a.body_md}
              modules={[
                <BoutContextModule key="booking" plan={plan} eventHref={event ? `/events/${eventSlug(event)}` : null} />,
                /* The subject card and the head-to-head table state many of the same
                 * facts. When both exist the comparison is strictly the better one,
                 * because every number in it has something to be measured against,
                 * so the card yields rather than repeat itself two modules later. */
                moduleOf(plan, "fighter_comparison") ? null : (
                  <FighterCardModule key="fcard" plan={plan} href={cardFighter ? `/fighters/${fighterSlug(cardFighter)}` : null} portrait={cardFighter ? imgs.get(cardFighter.id)?.thumb : null} />
                ),
                <ComparisonModule key="cmp" plan={plan} charts={charts} />,
                <OfficialVideoModule key="vid" plan={plan} videos={planVideos || []} />,
                <DnaModule key="dna" plan={plan} charts={charts} />,
                <RecentFormModule key="form" plan={plan} charts={charts} names={planNames} />,
                <RoundStyleModule key="rounds" plan={plan} names={planNames} />,
                <MarketModule key="mkt" plan={plan} charts={charts} />,
              ]}
            />
          ) : (
            <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body_md) }} />
          )}
          {!plan && fb.market_watch && <MarketWatch mw={fb.market_watch} />}
          {/* Anything the plan built that no module above claimed. Without this
            * a new chart kind would be computed, stored and silently invisible. */}
          {plan && <ChartSet charts={charts.filter((c) => !CLAIMED_CHARTS.has(c.id))} title="Also measured" />}
          {a.story_type === "fight_preview" && !angle && <div style={{ maxWidth: "72ch" }}><ProLock /></div>}
          {plan ? <MethodologyModule plan={plan} updated={a.updated_at} corroborating={(fb as { corroboration?: { publisher: string; url: string }[] }).corroboration} /> : fb.version ? <Methodology fb={fb} updated={a.updated_at} /> : (
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
        video: jsonLdVideos.length ? videoJsonLd(jsonLdVideos as never) : undefined,
      }} />
    </article>
  );
}
