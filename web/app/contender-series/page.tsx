import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/ui";
import { getVoice } from "@/lib/voices";
import { Mark } from "@/components/Brand";
import { getContenderSeries, getContenderEventContext, getContenderFreshness, expectedContenderSeasons } from "@/lib/contender";
import { eventSlug } from "@/lib/slug";
import { eventStatusLabel, fmtDate, fmtDateTime, locationLine, METHOD_SHORT, winnerOf } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Dana White's Contender Series — Every Season, Week, Fight & Result",
  description: "Dana White's Contender Series schedule and results by season and week, with fighter matchups, bout counts and live source freshness from the PropBetEdge UFC data layer.",
  keywords: ["Dana White Contender Series", "DWCS", "Contender Series schedule", "Contender Series results", "DWCS fighters", "DWCS season", "UFC Contender Series"],
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

export default async function ContenderSeriesPage({ searchParams }: { searchParams: Promise<{ season?: string }> }) {
  const sp = await searchParams;
  const [seasons, freshness] = await Promise.all([getContenderSeries(), getContenderFreshness()]);
  const latestLoaded = seasons[0]?.season || Math.max(...expectedContenderSeasons());
  const requested = Number(sp.season);
  const seasonNo = Number.isInteger(requested) && requested > 0 ? requested : latestLoaded;
  const selected = seasons.find((s) => s.season === seasonNo) || null;
  const events = selected?.events || [];
  const { counts, mains } = await getContenderEventContext(events);
  const expected = expectedContenderSeasons();
  const loaded = new Set(seasons.map((s) => s.season));
  const loadedEvents = seasons.reduce((sum, season) => sum + season.events.length, 0);
  const missing = expected.filter((season) => !loaded.has(season));
  const completed = events.filter((e) => e.card_status === "complete").length;
  const upcoming = events.length - completed;
  const latestSync = freshness?.finished_at || freshness?.started_at || null;

  return (
    <div className="wrap page dwcs-page">
      <section className="dwcs-hero">
        <div className="row"><Mark size={38} /><div className="eyebrow">PropBetEdge source of truth</div></div>
        <h1>Dana White's Contender Series</h1>
        <p className="lede">Season by season. Week by week. Current cards, completed results and matchup context from the same canonical fight database that powers PropBetEdge UFC.</p>
        <div className="dwcs-proof">
          <div><b>{seasons.length}</b><span>seasons loaded</span></div>
          <div><b>{loadedEvents}</b><span>weeks indexed</span></div>
          <div><b>{events.length}</b><span>weeks in Season {seasonNo}</span></div>
          <div><b>{completed}</b><span>completed · {upcoming} upcoming</span></div>
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
          <Link key={season} href={`/contender-series?season=${season}`} aria-current={season === seasonNo ? "true" : undefined} title={loaded.has(season) ? `Season ${season}` : `Season ${season} historical backfill pending`}>
            S{season}{!loaded.has(season) ? " · loading" : ""}
          </Link>
        ))}
      </nav>

      <div className="between mb-5">
        <div>
          <div className="eyebrow">Season {seasonNo}{selected?.year ? ` · ${selected.year}` : ""}</div>
          <h2 className="serif" style={{ fontSize: "clamp(26px,3vw,38px)", marginTop: 6 }}>{events.length ? `${events.length} weeks in the database` : "Historical season ingestion pending"}</h2>
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
                  {event.week ? `Week ${event.week}` : "Episode"}
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
          <p className="dim">We show missing coverage explicitly rather than manufacture a season archive. The historical ESPN/UFC Stats backfill is being wired into the same event, bout and result tables used by current DWCS cards; this page will fill automatically as those rows land.</p>
        </div>
      )}

      <section className="dwcs-source">
        <b>Source &amp; freshness.</b> ESPN's UFC league feed is the primary schedule, bout, result and fighter-identity source in the production ingest. UFC Stats is the round-stat source where a fight can be linked and verified. Current cards are read directly from the canonical PropBetEdge UFC tables; no season or week is hard-coded into this page. {missing.length ? `Historical seasons still missing from production: ${missing.map((s) => `S${s}`).join(", ")}.` : "All expected numbered seasons are loaded."}
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
        mainEntity: {
          "@type": "ItemList",
          name: `Dana White's Contender Series Season ${seasonNo}`,
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
