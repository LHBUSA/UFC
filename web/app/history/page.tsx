import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Brand";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import { JsonLd } from "@/components/ui";
import { getArchiveCoverage } from "@/lib/archive";
import { UFC_HISTORY, UFC_OFFICIAL } from "@/lib/heritage";
import { fmtDateTime } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "UFC History — From UFC 1 to the Modern Fight Game",
  description: "An independent, source-linked history of UFC and mixed martial arts from UFC 1 and Royce Gracie through rules, gloves, divisions, Hall of Fame eras and today's data-rich fight game.",
  alternates: { canonical: "/history" },
  openGraph: { type: "article", title: "From UFC 1 to Today — The Evolution of the Fight Game", description: "The people, rules and turning points that transformed the original style-vs-style experiment into modern MMA.", url: `${SITE.url}/history`, images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }] },
};

export default async function HistoryPage() {
  const coverage = await getArchiveCoverage();
  const ufc1Ready = Boolean(coverage.ufc1Event && coverage.ufc1Bouts > 0);
  return (
    <div className="wrap page heritage-page">
      <section className="heritage-hero">
        <div className="heritage-hero-copy">
          <div className="row"><Mark size={34} /><span className="eyebrow">The fight game · 1993 → today</span></div>
          <h1>Before the rankings.<br />Before the weight classes.<br /><em>There was the question.</em></h1>
          <p className="lede">What happens when different martial arts actually meet? UFC 1 made that question public. The answer did not stay still: fighters adapted, rules matured, divisions formed, and mixed martial arts became its own complete discipline.</p>
          <div className="heritage-actions">
            <a href={UFC_OFFICIAL.ufc1} className="btn gold" target="_blank" rel="noopener">UFC’s official UFC 1 page →</a>
            <a href={UFC_OFFICIAL.history30} className="btn" target="_blank" rel="noopener">Explore UFC’s 30-year history →</a>
            <Link href="/events" className="btn">Results archive</Link>
          </div>
        </div>
        <div className="heritage-hero-art">
          <div className="heritage-year">1993</div>
          <ChampionshipBelt size="hero" label="Evolution of the fight game" />
          <div className="heritage-era">Style vs style <i /> Mixed martial arts</div>
        </div>
      </section>

      <section className="archive-proof">
        <div className="archive-proof-head">
          <div><div className="eyebrow">PropBetEdge historical archive</div><h2>Building the result graph back to the beginning</h2></div>
          <span className={`archive-state ${ufc1Ready ? "ready" : "repair"}`}>{ufc1Ready ? "UFC 1 loaded" : "Historical repair active"}</span>
        </div>
        <div className="archive-proof-grid">
          <div><b>{coverage.events.toLocaleString()}</b><span>UFC event records</span></div>
          <div><b>{coverage.bouts.toLocaleString()}</b><span>bout rows loaded</span></div>
          <div><b>{coverage.results.toLocaleString()}</b><span>results loaded</span></div>
          <div><b>{coverage.roundRows.toLocaleString()}</b><span>round-stat rows</span></div>
        </div>
        <p>
          {ufc1Ready
            ? `The canonical database now contains ${coverage.ufc1Bouts} UFC 1 bout rows.`
            : `UFC 1 is not yet complete in the canonical PropBetEdge database. We show that gap instead of inventing an “every fight” claim; the historical repair pipeline is filling old cards year by year.`}
          {coverage.earliestEvent ? ` Earliest currently indexed non-DWCS event: ${coverage.earliestEvent.name} (${coverage.earliestEvent.event_date || "date pending"}).` : ""}
          {` Coverage checked ${fmtDateTime(coverage.lastChecked)}.`}
        </p>
      </section>

      <section className="heritage-intro">
        <div className="eyebrow">The origin</div>
        <h2>UFC 1 was raw by modern standards — but it was not literally ruleless.</h2>
        <p>The inaugural tournament had no weight classes, judges or round structure in the modern sense. That stripped-down format is part of the mythology, but precision matters: there were still prohibited actions and an organizing framework. The enduring story is more interesting anyway — specialists were forced to prove what survived contact with another discipline.</p>
        <p>Royce Gracie’s tournament win made grappling literacy mandatory. Future champions could not remain pure boxers, wrestlers, kickboxers or jiu-jitsu players. The sport rewarded integration, and that pressure created mixed martial arts as we recognize it now.</p>
        <div className="heritage-source-row"><a href={UFC_OFFICIAL.ufc1} target="_blank" rel="noopener">Official UFC 1 record</a><a href={UFC_OFFICIAL.fightPass} target="_blank" rel="noopener">UFC Fight Pass</a></div>
      </section>

      <section className="history-timeline" aria-label="UFC history timeline">
        {UFC_HISTORY.map((moment, i) => (
          <article className="history-moment" key={`${moment.year}-${moment.title}`}>
            <div className="history-rail"><span>{String(i + 1).padStart(2, "0")}</span><i /></div>
            <div className="history-year">{moment.year}</div>
            <div className="history-copy">
              <div className="eyebrow">{moment.eyebrow}</div>
              <h2>{moment.title}</h2>
              <p>{moment.body}</p>
              <a href={moment.source} target="_blank" rel="noopener">{moment.sourceLabel} →</a>
            </div>
          </article>
        ))}
      </section>

      <section className="heritage-close">
        <div><div className="eyebrow">Respect the lineage</div><h2>The archive should remember more than winners and losers.</h2><p>Rules, title lineage, round data, judging, methods, fighter identities, event context, official media and the historical source behind each fact all matter. That is the standard PropBetEdge is building toward.</p></div>
        <div className="heritage-close-actions"><Link href="/hall-of-fame" className="btn gold">Hall of Fame tribute →</Link><Link href="/events" className="btn">Schedule & results →</Link></div>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "Article", "@id": `${SITE.url}/history#article`, url: `${SITE.url}/history`, headline: "UFC History — From UFC 1 to the Modern Fight Game", dateModified: coverage.lastChecked,
        description: "A source-linked history of UFC and mixed martial arts from UFC 1 through the modern era.",
        publisher: { "@id": `${SITE.url}/#desk` }, author: { "@id": `${SITE.url}/#desk` },
        about: [{ "@type": "SportsOrganization", name: "Ultimate Fighting Championship", url: UFC_OFFICIAL.home }, { "@type": "SportsEvent", name: "UFC 1", startDate: "1993-11-12", url: UFC_OFFICIAL.ufc1 }],
      }} />
    </div>
  );
}
