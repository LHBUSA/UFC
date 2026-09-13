import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/ui";
import { getVoice } from "@/lib/voices";
import { Mark } from "@/components/Brand";
import { getContenderSeries, getContenderSpinoffs, getContenderEventContext, getContenderFreshness, expectedContenderSeasons } from "@/lib/contender";
import { getDwcsGraph } from "@/lib/dwcsGraph";
import { getRankingIndex } from "@/lib/rankings";
import { isRanked } from "@/lib/rankingContext";
import { VideoRail } from "@/components/VideoRail";
import { getVideosForEvent, sortVideosTimeline } from "@/lib/db";
import { eventSlug } from "@/lib/slug";
import { eventStatusLabel, fmtDate, fmtDateTime, locationLine, METHOD_SHORT, winnerOf } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Dana White's Contender Series — Every Season, Week, Fight & Result",
  description: "Dana White's Contender Series schedule and results by season and week, fight totals and judges' cards, and where every DWCS fighter went next in the UFC.",
  keywords: ["Dana White Contender Series", "DWCS", "Contender Series schedule", "Contender Series results", "DWCS fighters", "DWCS season", "UFC Contender Series", "DWCS alumni"],
  alternates: { canonical: "/contender-series" },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
  openGraph: {
    type: "website",
    url: `${SITE.url}/contender-series`,
    title: "Dana White's Contender Series — Source of Truth",
    description: "Every loaded DWCS season and week, current schedule, results and matchup context from the PropBetEdge UFC data layer.",
    images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630, alt: "PropBetEdge UFC Fight Intelligence" }],
  },
  twitter: { card: "summary_large_image", title: "Dana White's Contender Series — Source of Truth", description: "DWCS seasons, weeks, schedule and results from PropBetEdge UFC.", images: [`${SITE.url}/opengraph-image`] },
};

/* The Voices desk already sourced and rights-cleared this portrait; the hub
 * reads that record rather than holding a second copy of the asset. */
const DANA = getVoice("dana-white");

export default async function ContenderSeriesPage({ searchParams }: { searchParams: Promise<{ season?: string; series?: string }> }) {
  const sp = await searchParams;
  const [seasons, spinoffs, freshness, graph, rankIndex] = await Promise.all([getContenderSeries(), getContenderSpinoffs(), getContenderFreshness(), getDwcsGraph(), getRankingIndex()]);
  const brazil = spinoffs.find((s) => s.key === "brazil") || null;
  const showBrazil = sp.series === "brazil" && Boolean(brazil);
  const latestLoaded = seasons[0]?.season || Math.max(...expectedContenderSeasons());
  const requested = Number(sp.season);
  const seasonNo = Number.isInteger(requested) && requested > 0 ? requested : latestLoaded;
  const selected = showBrazil ? null : seasons.find((s) => s.season === seasonNo) || null;
  const events = showBrazil ? brazil!.events : selected?.events || [];
  const { counts, mains } = await getContenderEventContext(events);
  const expected = expectedContenderSeasons();
  const loaded = new Set(seasons.map((s) => s.season));
  const loadedEvents = seasons.reduce((sum, season) => sum + season.events.length, 0);
  const missing = expected.filter((season) => !loaded.has(season));
  const completed = events.filter((e) => e.card_status === "complete").length;
  const upcoming = events.length - completed;
  const latestSync = freshness?.finished_at || freshness?.started_at || null;
  const reachedUfc = graph ? graph.alumni.filter((a) => a.reachedUfc).length : null;
  const rankedAlumni = graph && rankIndex ? graph.alumni.filter((a) => isRanked(rankIndex.byFighter.get(a.fighter.id))).length : null;
  /* Official video already attached to the latest completed week of the
   * selected season by the existing video resolver. No second video system. */
  const latestDone = [...events].reverse().find((e) => e.card_status === "complete") || null;
  const videos = latestDone ? sortVideosTimeline(await getVideosForEvent(latestDone.id, 8).catch(() => [])) : [];
  const unitLabel = showBrazil ? "episodes" : "weeks";

  return (
    <div className="wrap page dwcs-page">
      <section className="dwcs-hero">
        <div className="row"><Mark size={38} /><div className="eyebrow">PropBetEdge source of truth</div></div>
        <h1>Dana White's Contender Series</h1>
        <p className="lede">Season by season. Week by week. Results, fight totals and judges&apos; cards from the same canonical fight database that powers PropBetEdge UFC — and where every fighter went next.</p>
        <div className="dwcs-proof">
          <div><b>{seasons.length}</b><span>numbered seasons</span></div>
          <div><b>{loadedEvents}</b><span>weeks indexed</span></div>
          {graph ? <div><b>{graph.alumni.length.toLocaleString()}</b><span>fighters tracked</span></div> : null}
          {reachedUfc != null ? <div><b>{reachedUfc.toLocaleString()}</b><span>reached a UFC card</span></div> : null}
          {rankedAlumni != null ? <div><b>{rankedAlumni}</b><span>alumni ranked now</span></div> : null}
        </div>
        <div className="row mt-5" style={{ gap: 10, flexWrap: "wrap" }}>
          <Link href="/contender-series/alumni" className="btn gold">DWCS Alumni →</Link>
        </div>
        <div className="dwcs-fresh"><i />{latestSync ? <>Data sync: <time dateTime={latestSync}>{fmtDateTime(latestSync)}</time></> : <>Live database · freshness timestamp unavailable</>}</div>
        {DANA?.image && (
          /* The series carries his name, so the hero shows him. Reusing the
             portrait the Voices desk already cleared rather than sourcing a
             second copy: same file, same rights record, one place to audit.
             focal keeps the head in frame at every width — a centred crop of
             this photograph takes the chest. */
          <figure className="dwcs-portrait">
            <img
              src={DANA.image.hero || DANA.image.src}
              alt={DANA.image.alt}
              width={DANA.image.width}
              height={DANA.image.height}
              style={{ objectPosition: DANA.image.focal }}
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              {DANA.image.author} · {DANA.image.license}
              {DANA.image.source_url ? (
                <> · <a href={DANA.image.source_url} rel="nofollow noopener" target="_blank">source</a></>
              ) : null}
            </figcaption>
          </figure>
        )}
      </section>

      <nav className="dwcs-season-nav" aria-label="Contender Series seasons">
        {expected.map((season) => (
          <Link key={season} href={`/contender-series?season=${season}`} aria-current={!showBrazil && season === seasonNo ? "true" : undefined} title={loaded.has(season) ? `Season ${season}` : `Season ${season} historical backfill pending`}>
            S{season}{!loaded.has(season) ? " · loading" : ""}
          </Link>
        ))}
        {/* A separate series, so a separate tab: never a week of Season 2. */}
        {brazil ? <Link href="/contender-series?series=brazil" aria-current={showBrazil ? "true" : undefined} title="Contender Series Brazil">Brazil</Link> : null}
      </nav>

      <div className="between mb-5">
        <div>
          <div className="eyebrow">{showBrazil ? `Contender Series Brazil${brazil?.year ? ` · ${brazil.year}` : ""}` : `Season ${seasonNo}${selected?.year ? ` · ${selected.year}` : ""}`}</div>
          <h2 className="serif" style={{ fontSize: "clamp(26px,3vw,38px)", marginTop: 6 }}>{events.length ? `${events.length} ${unitLabel} in the database` : "Historical season ingestion pending"}</h2>
          {events.length ? <div className="dim sm mt-2">{completed} completed · {upcoming} upcoming</div> : null}
        </div>
        <Link href="/events" className="btn">UFC schedule →</Link>
      </div>

      {events.length ? (
        <div className="dwcs-grid">
          {events.map((event) => {
            const main = mains.get(event.id);
            const winner = main ? winnerOf(main) : null;
            const loser = main && winner ? (winner.id === main.fighter_a.id ? main.fighter_b : main.fighter_a) : null;
            const boutCount = counts.get(event.id) || 0;
            return (
              <Link key={event.id} href={`/events/${eventSlug(event)}`} className="dwcs-week">
                <div className="dwcs-week-date">
                  {event.identity.series === "brazil" ? (event.identity.episode ? `Episode ${event.identity.episode}` : "Episode") : event.week ? `Week ${event.week}` : "Episode"}
                  <small>{fmtDate(event.event_date, { month: "short", day: "numeric", year: "numeric" })}</small>
                </div>
                <div>
                  <h3>{event.name.replace(/^Dana White(?:'s|’s) Contender Series[: ,–-]*/i, "") || event.name}</h3>
                  <div className="dwcs-week-meta">
                    {main ? (winner && loser ? <><b>{winner.name}</b> def. {loser.name}{main.result ? ` · ${METHOD_SHORT[main.result.method] || main.result.method}` : ""}</> : <><b>{main.fighter_a.name}</b> vs <b>{main.fighter_b.name}</b></>) : "Card lineup pending"}
                    {boutCount ? ` · ${boutCount} bouts` : ""}
                    {locationLine(event) ? ` · ${locationLine(event)}` : ""}
                  </div>
                </div>
                <div className="dwcs-week-status"><span className={`tag${event.card_status === "complete" ? " pos" : " gold"}`}>{eventStatusLabel(event)}</span></div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card hi">
          <div className="eyebrow">Historical backfill</div>
          <h3 className="serif" style={{ fontSize: 24, margin: "8px 0" }}>Season {seasonNo} is not in the canonical database yet.</h3>
          <p className="dim">We show missing coverage explicitly rather than manufacture a season archive. This page fills automatically as the canonical event, bout and result rows land.</p>
        </div>
      )}

      {latestDone && videos.length > 0 && (
        <VideoRail videos={videos} title={`Official video · ${latestDone.identity.label}`} eyebrow="Official channels · attached to this week by the video resolver" note="Embedded from YouTube, not hosted by PropBetEdge" max={4} />
      )}

      <section className="dwcs-source">
        <b>Source &amp; freshness.</b> ESPN's UFC league feed is the primary schedule, bout, result, fight-total, judges&apos; card and fighter-identity source in the production ingest. UFC Stats is the round-stat source where a fight can be linked and verified. Contender Series Brazil (2018) is listed as its own series, not as weeks of Season 2. Current cards are read directly from the canonical PropBetEdge UFC tables; no season or week is hard-coded into this page. {missing.length ? `Historical seasons still missing from production: ${missing.map((s) => `S${s}`).join(", ")}.` : "All expected numbered seasons are loaded."}
      </section>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": `${SITE.url}/contender-series#collection`,
        url: `${SITE.url}/contender-series`,
        name: "Dana White's Contender Series — seasons, schedule and results",
        description: "Dana White's Contender Series season archive and current schedule from the PropBetEdge UFC data layer.",
        isPartOf: { "@id": `${SITE.url}/#site` },
        dateModified: latestSync || undefined,
        hasPart: { "@type": "CollectionPage", name: "DWCS Alumni", url: `${SITE.url}/contender-series/alumni` },
        mainEntity: {
          "@type": "ItemList",
          name: showBrazil ? "Contender Series Brazil" : `Dana White's Contender Series Season ${seasonNo}`,
          numberOfItems: events.length,
          itemListElement: events.map((event, index) => ({
            "@type": "ListItem",
            position: index + 1,
            item: {
              "@type": "SportsEvent",
              name: event.name,
              startDate: event.event_date,
              url: `${SITE.url}/events/${eventSlug(event)}`,
              sport: "Mixed Martial Arts",
              location: locationLine(event) ? { "@type": "Place", name: locationLine(event) } : undefined,
            },
          })),
        },
      }} />
    </div>
  );
}
