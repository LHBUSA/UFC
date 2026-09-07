import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Brand";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import { JsonLd } from "@/components/ui";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { getArchiveCoverage, getArchiveYearCoverage } from "@/lib/archive";
import { getLatestVideos } from "@/lib/db";
import { UFC_ERAS, UFC_OFFICIAL } from "@/lib/heritage";
import { fmtDateTime } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "UFC History — Seven Eras From UFC 1 to the Data Era",
  description: "An independent, source-linked history of the UFC and mixed martial arts in seven eras: UFC 1 and the original question, the Gracie influence, rules and regulation, the Zuffa rebuild, The Ultimate Fighter, global expansion and women's MMA, and today's data era.",
  alternates: { canonical: "/history" },
  openGraph: { type: "article", title: "UFC History — Seven Eras From UFC 1 to Today", description: "The people, rules and turning points that transformed a style-vs-style tournament into modern championship MMA, with official UFC sources beside every era.", url: `${SITE.url}/history`, images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: "UFC History — Seven Eras From UFC 1 to Today", images: [`${SITE.url}/opengraph-image`] },
};

export default async function HistoryPage() {
  const [coverage, years, videos] = await Promise.all([getArchiveCoverage(), getArchiveYearCoverage(), getLatestVideos(4).catch(() => [])]);
  const ufc1Ready = Boolean(coverage.ufc1Event && coverage.ufc1Bouts > 0);
  const eventsWithCards = years.reduce((s, y) => s + y.withBouts, 0);
  const oldest = [...years].sort((a, b) => a.year - b.year);
  return (
    <div className="wrap page heritage-page">
      <section className="heritage-hero">
        <div className="heritage-hero-copy">
          <div className="row"><Mark size={34} /><span className="eyebrow">The fight game · 1993 → today</span></div>
          <h1>Before the rankings.<br />Before the weight classes.<br /><em>There was the question.</em></h1>
          <p className="lede">What happens when different martial arts actually meet? UFC 1 made that question public in November 1993. The answer never stood still: fighters adapted, rules matured, divisions formed, television found the sport, the map went global and mixed martial arts became its own complete discipline. Seven eras, source-linked, with the archive PropBetEdge is rebuilding underneath them.</p>
          <div className="heritage-actions">
            <a href={UFC_OFFICIAL.ufc1} className="btn gold" target="_blank" rel="noopener">UFC's official UFC 1 page ↗</a>
            <a href={UFC_OFFICIAL.history30} className="btn" target="_blank" rel="noopener">UFC's 30-year history ↗</a>
            <Link href="/hall-of-fame" className="btn">Hall of Fame tribute</Link>
          </div>
        </div>
        <div className="heritage-hero-art">
          <div className="heritage-year">1993</div>
          <ChampionshipBelt size="hero" label="Evolution of the fight game" />
          <div className="heritage-era">Style vs style <i /> Mixed martial arts</div>
        </div>
      </section>

      <nav className="era-nav" aria-label="Eras">
        {UFC_ERAS.map((era) => <a key={era.key} href={`#${era.key}`}><b>{era.number}</b>{era.eyebrow}</a>)}
        <a href="#archive"><b>DB</b>Archive coverage</a>
      </nav>

      <div className="history-eras">
        {UFC_ERAS.map((era) => (
          <article className="era" id={era.key} key={era.key} aria-labelledby={`era-${era.key}`}>
            <div className="era-rail">
              <div className="era-number">{era.number}</div>
              <div><div className="era-years">{era.years}</div><div className="eyebrow">{era.eyebrow}</div></div>
            </div>
            <div className="era-body">
              <h2 id={`era-${era.key}`}>{era.title}</h2>
              <p className="era-summary">{era.summary}</p>
              <div className="era-why"><div className="desk-h">Why it mattered</div><p>{era.whyItMattered}</p></div>
              <div className="era-grid">
                <div>
                  <div className="desk-h">Key moments</div>
                  <ul className="era-moments">{era.moments.map((m) => <li key={m.text}><b>{m.year}</b><span>{m.text}</span></li>)}</ul>
                </div>
                <aside className="era-figures">
                  <div className="desk-h">Key figures</div>
                  <div className="chips">{era.figures.map((f) => <span key={f}>{f}</span>)}</div>
                  <div className="era-sources">{era.sources.map((s) => <a key={s.href} href={s.href} target="_blank" rel="noopener">{s.label} ↗</a>)}</div>
                </aside>
              </div>
            </div>
          </article>
        ))}
      </div>

      <section className="archive-proof mt-7" id="archive">
        <div className="archive-proof-head">
          <div><div className="eyebrow">PropBetEdge historical archive · live database</div><h2>Every fight since UFC 1 is the target. Here is how far the archive actually reaches.</h2></div>
          <span className={`archive-state ${ufc1Ready ? "ready" : "repair"}`}>{ufc1Ready ? "UFC 1 loaded" : "Historical repair active"}</span>
        </div>
        <div className="archive-proof-grid">
          <div><b>{coverage.events.toLocaleString()}</b><span>UFC event records</span></div>
          <div><b>{eventsWithCards.toLocaleString()}</b><span>events with bouts loaded</span></div>
          <div><b>{coverage.bouts.toLocaleString()}</b><span>bout rows loaded</span></div>
          <div><b>{coverage.results.toLocaleString()}</b><span>results · {coverage.roundRows.toLocaleString()} round-stat rows</span></div>
        </div>
        <p>
          {ufc1Ready ? `The canonical database contains ${coverage.ufc1Bouts} UFC 1 bout rows.` : `UFC 1 is not yet complete in the canonical PropBetEdge database. We show that gap instead of inventing an "every fight" claim; the historical repair pipeline fills old cards year by year from archived UFC Stats captures.`}
          {coverage.earliestEvent ? ` Earliest indexed non-DWCS event: ${coverage.earliestEvent.name} (${coverage.earliestEvent.event_date || "date pending"}).` : ""}
          {` Coverage checked ${fmtDateTime(coverage.lastChecked)}.`}
        </p>
        {oldest.length > 0 && (
          <>
            <div className="coverage-years" aria-label="Archive coverage by year">
              {oldest.map((y) => <Link key={y.year} href={`/events?year=${y.year}`} className="coverage-year" title={`${y.year}: ${y.events} events indexed, ${y.withBouts} with bouts loaded (${y.bouts} bouts)`}>{y.year}<i><b style={{ width: `${y.events ? Math.round((y.withBouts / y.events) * 100) : 0}%` }} /></i><small>{y.withBouts}/{y.events}</small></Link>)}
            </div>
            <div className="coverage-legend"><span>Bar = share of that year's indexed events with bout rows loaded.</span><span>Numbers = events with bouts / events indexed.</span><Link href="/events" style={{ color: "var(--pbe-gold)" }}>Browse the results archive →</Link></div>
          </>
        )}
      </section>

      <VideoRail videos={videos} title="From UFC's official channel" eyebrow="Official video" note="Free, publisher-hosted video embedded from UFC's official YouTube channel · not hosted by PropBetEdge" />

      <OfficialDestinations title="Explore UFC's own history, athletes and archive" intro="These are UFC-owned destinations. PropBetEdge is an independent intelligence layer and links to the record owner wherever a fact can be verified there." />

      <section className="heritage-close">
        <div><div className="eyebrow">Respect the lineage</div><h2>The archive should remember more than winners and losers.</h2><p>Rules, title lineage, round data, judging, methods, fighter identities, event context, official media and the historical source behind each fact all matter. That is the standard PropBetEdge is building toward, year by year.</p></div>
        <div className="heritage-close-actions"><Link href="/hall-of-fame" className="btn gold">Hall of Fame tribute →</Link><Link href="/events" className="btn">Schedule & results →</Link><Link href="/voices/dana-white" className="btn">Dana White profile</Link></div>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "Article", "@id": `${SITE.url}/history#article`, url: `${SITE.url}/history`, headline: "UFC History — Seven Eras From UFC 1 to the Data Era", dateModified: coverage.lastChecked,
        description: "A source-linked history of the UFC and mixed martial arts in seven eras, from UFC 1 through the modern data era.",
        publisher: { "@id": `${SITE.url}/#desk` }, author: { "@id": `${SITE.url}/#desk` },
        hasPart: UFC_ERAS.map((era) => ({ "@type": "Article", name: era.title, url: `${SITE.url}/history#${era.key}`, about: era.figures.map((f) => ({ "@type": "Person", name: f })) })),
        about: [{ "@type": "SportsOrganization", name: "Ultimate Fighting Championship", url: UFC_OFFICIAL.home }, { "@type": "SportsEvent", name: "UFC 1", startDate: "1993-11-12", url: UFC_OFFICIAL.ufc1 }],
        video: videos.length ? videoJsonLd(videos) : undefined,
      }} />
    </div>
  );
}
