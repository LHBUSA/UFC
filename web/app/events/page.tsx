import type { Metadata } from "next";
import Link from "next/link";
import { getUpcomingEvents, getEventsInYear, getEventYears, getMainEvents, getImagesForFighters, getBoutCounts, isContenderSeries } from "@/lib/db";
import { getArchiveCoverage } from "@/lib/archive";
import { isDanaWhiteContenderSeries } from "@/lib/contender";
import { Empty, EventCard, EventRow, PageHead, SectionHead, JsonLd } from "@/components/ui";
import { eventSlug } from "@/lib/slug";
import { fmtDateTime } from "@/lib/format";
import { SITE } from "@/lib/site";
import { UFC_OFFICIAL } from "@/lib/heritage";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "UFC Schedule & Results — Every Announced Card, Historical Coverage",
  description: "A live UFC schedule with announced cards, matchup pages and results, plus an explicitly measured historical archive that is being repaired back toward UFC 1 without inventing missing fights.",
  alternates: { canonical: "/events" },
  openGraph: { title: "UFC Schedule & Results", description: "Upcoming UFC cards, full fight pages and a transparent historical results archive.", url: `${SITE.url}/events` },
};

export default async function EventsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const sp = await searchParams;
  const [years, coverage] = await Promise.all([getEventYears(), getArchiveCoverage()]);
  const thisYear = new Date().getUTCFullYear();
  const year = Number(sp.year) && years.some((y) => y.year === Number(sp.year)) ? Number(sp.year) : (years[0]?.year || thisYear);
  const [upcoming, inYear] = await Promise.all([getUpcomingEvents(24, { includeContenderSeries: true }), getEventsInYear(year)]);
  const today = new Date().toISOString().slice(0, 10);
  const past = inYear.filter((e) => e.event_date && e.event_date < today && !isContenderSeries(e.name));
  const ufcUpcoming = upcoming.filter((e) => !isContenderSeries(e.name));
  const dwcs = upcoming.filter((e) => isDanaWhiteContenderSeries(e.name));
  const ids = [...ufcUpcoming, ...dwcs, ...past.slice(0, 60)].map((e) => e.id);
  const [mains, counts] = await Promise.all([getMainEvents(ids), getBoutCounts(ids)]);
  const imgs = await getImagesForFighters([...mains.values()].flatMap((b) => [b.fighter_a.id, b.fighter_b.id]));
  const next = ufcUpcoming[0] || null;
  const ufc1Ready = Boolean(coverage.ufc1Event && coverage.ufc1Bouts > 0);

  return (
    <div className="wrap page">
      <PageHead crumbs={[{ name: "Schedule" }]} eyebrow="Live UFC calendar · results archive" title="UFC schedule & results" lede="The clean control center for fight night: every currently announced UFC card first, Contender Series tracked separately, and historical results presented with an explicit coverage meter rather than pretending missing old cards are complete." />

      <div className="rank-official-bar">
        <p><b style={{ color: "var(--pbe-paper)" }}>PropBetEdge + official source.</b> Use our linked matchup intelligence here, then jump to UFC's own event calendar whenever you want the promotion's official destination.</p>
        <div className="actions"><a href="https://www.ufc.com/events" className="btn" target="_blank" rel="noopener">Official UFC events ↗</a><a href={UFC_OFFICIAL.fightPass} className="btn gold" target="_blank" rel="noopener">UFC Fight Pass ↗</a></div>
      </div>

      {next && (
        <section className="mb-6">
          <SectionHead eyebrow="Next UFC card" title="Fight week starts here" href={`/events/${eventSlug(next)}`} cta="Open live card" />
          <div className="grid-2">
            <EventCard e={next} main={mains.get(next.id)} imgs={imgs} bouts={counts.get(next.id)} />
            <div className="card hi" style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: 28 }}>
              <div className="eyebrow">Before the first horn</div>
              <h2 className="serif" style={{ fontSize: 30, lineHeight: 1.05, margin: "7px 0 12px" }}>Card, matchup pages and Pregame Desk in one place.</h2>
              <p className="dim sm">Open the event for evidence-led pre-fight talking points, every announced bout, tale-of-the-tape links and the newsroom stories attached to this card.</p>
              <Link href={`/events/${eventSlug(next)}`} className="btn gold mt-4" style={{ alignSelf: "flex-start" }}>Enter {next.name} →</Link>
            </div>
          </div>
        </section>
      )}

      <SectionHead eyebrow={`${ufcUpcoming.length} announced`} title="Upcoming UFC cards" />
      {ufcUpcoming.length ? <div className="grid-3">{ufcUpcoming.map((e) => <EventCard key={e.id} e={e} main={mains.get(e.id)} imgs={imgs} bouts={counts.get(e.id)} />)}</div> : <Empty title="No upcoming UFC events loaded">The schedule is refreshed from the production source feed. Announced UFC cards appear here with the full lineup as it becomes available.</Empty>}

      {dwcs.length > 0 && (
        <div className="mt-6"><div className="segment" style={{ marginTop: 0 }}><div className="between mb-4"><h3 style={{ margin: 0 }}>Dana White's Contender Series <small>{dwcs.length} upcoming weeks</small></h3><Link href="/contender-series" className="more" style={{ color: "var(--pbe-gold)", fontWeight: 700 }}>Every season &amp; result →</Link></div><div className="elist">{dwcs.map((e) => <EventRow key={e.id} e={e} main={mains.get(e.id)} bouts={counts.get(e.id)} />)}</div></div></div>
      )}

      <section className="archive-proof mt-7">
        <div className="archive-proof-head">
          <div><div className="eyebrow">Historical coverage · live database</div><h2>Results archive status</h2></div>
          <span className={`archive-state ${ufc1Ready ? "ready" : "repair"}`}>{ufc1Ready ? "UFC 1 loaded" : "Backfill active"}</span>
        </div>
        <div className="archive-proof-grid">
          <div><b>{coverage.events.toLocaleString()}</b><span>UFC event records</span></div>
          <div><b>{coverage.bouts.toLocaleString()}</b><span>bouts loaded</span></div>
          <div><b>{coverage.results.toLocaleString()}</b><span>results loaded</span></div>
          <div><b>{coverage.roundRows.toLocaleString()}</b><span>round-stat rows</span></div>
        </div>
        <p>{ufc1Ready ? `UFC 1 currently has ${coverage.ufc1Bouts} bout rows in the canonical archive.` : "The historical event shell reaches deep into UFC history, but bout-level coverage is still being repaired backward. Missing fights are labeled as missing instead of synthesized."} Coverage checked {fmtDateTime(coverage.lastChecked)}. <Link href="/history" style={{ color: "var(--pbe-gold)" }}>See the historical methodology →</Link></p>
      </section>

      <div className="mt-7">
        <SectionHead eyebrow="Year-by-year results" title={`${year} UFC results`} />
        <div className="years mb-5" role="navigation" aria-label="Archive by year">{years.map((y) => <Link key={y.year} href={`/events?year=${y.year}`} aria-current={y.year === year ? "true" : undefined} title={`${y.count} indexed event records`}>{y.year}</Link>)}</div>
        {past.length ? <div className="elist">{past.map((e) => <EventRow key={e.id} e={e} main={mains.get(e.id)} bouts={counts.get(e.id)} />)}</div> : <Empty title={`No completed UFC event records in ${year} yet`}>Results appear as the historical and current ingest layers fill this year.</Empty>}
      </div>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "CollectionPage", name: "UFC schedule and results", url: `${SITE.url}/events`, dateModified: coverage.lastChecked, isPartOf: { "@id": `${SITE.url}/#site` }, mainEntity: { "@type": "ItemList", itemListElement: ufcUpcoming.slice(0, 20).map((e, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE.url}/events/${eventSlug(e)}`, name: e.name })) } }} />
    </div>
  );
}
