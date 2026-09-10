import type { Metadata } from "next";
import Link from "next/link";
import { getUpcomingEvents, getEventsInYear, getEventYears, getMainEvents, getBoutCounts, isContenderSeries, type Event, type Bout, type PortraitSet } from "@/lib/db";
import { resolveFighterPortraits } from "@/lib/fighterMedia";
import { getArchiveCoverage, getArchiveYearCoverage, getIngestFreshness } from "@/lib/archive";
import { isDanaWhiteContenderSeries } from "@/lib/contender";
import { Avatar, Empty, EventCard, EventRow, PageHead, SectionHead, JsonLd } from "@/components/ui";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { eventSlug } from "@/lib/slug";
import { daysUntil, eventBrand, eventHeadline, eventStatusLabel, fmtDate, fmtDateTime, locationLine, weightClassLabel, winnerOf, METHOD_SHORT } from "@/lib/format";
import { SITE } from "@/lib/site";
import { UFC_OFFICIAL } from "@/lib/heritage";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "UFC Schedule & Results — Every Announced Card, Year-by-Year Archive",
  description: "The UFC schedule month by month with date, location, status, featured fight and card links, Contender Series tracked separately, and a year-by-year results archive that reports its own historical coverage honestly.",
  alternates: { canonical: "/events" },
  openGraph: { title: "UFC Schedule & Results", description: "Upcoming UFC cards, full fight pages and a transparent historical results archive.", url: `${SITE.url}/events`, images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: "UFC Schedule & Results", images: [`${SITE.url}/opengraph-image`] },
};

function ScheduleRow({ e, main, imgs, bouts }: { e: Event; main?: Bout | null; imgs: Map<string, PortraitSet>; bouts?: number }) {
  const d = daysUntil(e.event_date);
  const w = main ? winnerOf(main) : null;
  return (
    <Link href={`/events/${eventSlug(e)}`} className={`sched-row${e.is_ppv ? " ppv" : ""}`}>
      <div className="sched-date">{fmtDate(e.event_date, { month: "short", day: "numeric" })}<small>{e.event_date ? new Date(`${e.event_date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) : ""}{e.event_date ? ` · ${e.event_date.slice(0, 4)}` : ""}</small></div>
      <div className="sched-name">{eventHeadline(e.name) || e.name}<small>{eventBrand(e.name)}{e.is_ppv ? " · Pay-per-view" : ""}{locationLine(e) ? ` · ${locationLine(e)}` : " · Venue TBA"}</small></div>
      <div className="sched-main">
        {main ? (
          <>
            <Avatar f={main.fighter_a} img={imgs.get(main.fighter_a.id)} size={34} /><Avatar f={main.fighter_b} img={imgs.get(main.fighter_b.id)} size={34} />
            <span className="txt">{w ? <><b>{w.name}</b> def. {w.id === main.fighter_a.id ? main.fighter_b.name : main.fighter_a.name}{main.result ? ` · ${METHOD_SHORT[main.result.method] || main.result.method}${main.result.round ? ` R${main.result.round}` : ""}` : ""}</> : <><b>{main.fighter_a.name}</b> vs <b>{main.fighter_b.name}</b></>}<small>{weightClassLabel(main.weight_class, main.is_womens)}{main.is_title ? " title" : ""} main event{bouts ? ` · ${bouts} bouts` : ""}</small></span>
          </>
        ) : <span className="txt faint">{bouts ? `${bouts} bouts announced` : "Card announcement pending"}</span>}
      </div>
      <div className="sched-status"><span className={`tag${d != null && d >= 0 && d <= 6 && e.card_status !== "complete" ? " gold" : e.card_status === "complete" ? " pos" : ""}`}>{eventStatusLabel(e)}</span>{d != null && d > 0 && e.card_status !== "complete" && <small>in {d} day{d === 1 ? "" : "s"}</small>}</div>
    </Link>
  );
}

export default async function EventsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const sp = await searchParams;
  const [years, coverage, yearCoverage, freshness] = await Promise.all([getEventYears(), getArchiveCoverage(), getArchiveYearCoverage(), getIngestFreshness().catch(() => null)]);
  const thisYear = new Date().getUTCFullYear();
  const year = Number(sp.year) && years.some((y) => y.year === Number(sp.year)) ? Number(sp.year) : (years[0]?.year || thisYear);
  const [upcoming, inYear] = await Promise.all([getUpcomingEvents(40, { includeContenderSeries: true }), getEventsInYear(year)]);
  const today = new Date().toISOString().slice(0, 10);
  const past = inYear.filter((e) => e.event_date && e.event_date < today && !isContenderSeries(e.name));
  const ufcUpcoming = upcoming.filter((e) => !isContenderSeries(e.name));
  const dwcs = upcoming.filter((e) => isDanaWhiteContenderSeries(e.name));
  const ids = [...ufcUpcoming, ...dwcs, ...past.slice(0, 80)].map((e) => e.id);
  const [mains, counts] = await Promise.all([getMainEvents(ids), getBoutCounts(ids)]);
  const imgs = await resolveFighterPortraits([...mains.values()].flatMap((b) => [b.fighter_a.id, b.fighter_b.id]), { surface: "high_visibility" });
  const next = ufcUpcoming[0] || null;
  const ufc1Ready = Boolean(coverage.ufc1Event && coverage.ufc1Bouts > 0);
  const yc = yearCoverage.find((y) => y.year === year);
  const eventsWithCards = yearCoverage.reduce((s, y) => s + y.withBouts, 0);
  const months = new Map<string, Event[]>();
  for (const e of ufcUpcoming) { const k = e.event_date ? e.event_date.slice(0, 7) : "TBA"; months.set(k, [...(months.get(k) || []), e]); }
  const syncAt = freshness?.finished_at || freshness?.started_at || null;

  return (
    <div className="wrap page">
      <PageHead crumbs={[{ name: "Schedule" }]} eyebrow="Live UFC calendar · results archive" title="UFC schedule & results" lede="Every announced UFC card month by month with date, location, status and the featured fight; Contender Series on its own track; and a year-by-year results archive that measures its own historical coverage instead of pretending old cards are complete." />

      <div className="sched-fresh"><i />{syncAt ? <>Schedule &amp; results ingest last ran <time dateTime={syncAt}>{fmtDateTime(syncAt)}</time>{freshness?.status ? ` · ${freshness.status}` : ""}</> : <>Live database · ingest timestamp unavailable</>} · {coverage.lastDataWrite ? <>data last written <time dateTime={coverage.lastDataWrite}>{fmtDateTime(coverage.lastDataWrite)}</time> · </> : null}coverage checked <time dateTime={coverage.lastChecked}>{fmtDateTime(coverage.lastChecked)}</time></div>

      <div className="rank-official-bar">
        <p><b style={{ color: "var(--pbe-paper)" }}>PropBetEdge + official source.</b> Use our linked matchup intelligence here, then jump to UFC's own event calendar whenever you want the promotion's official destination.</p>
        <div className="actions"><a href={UFC_OFFICIAL.events} className="btn" target="_blank" rel="noopener">Official UFC events ↗</a><a href={UFC_OFFICIAL.fightPass} className="btn gold" target="_blank" rel="noopener">UFC Fight Pass ↗</a></div>
      </div>

      {next && (
        <section className="mb-6">
          <SectionHead eyebrow="Next UFC card" title="Fight week starts here" href={`/events/${eventSlug(next)}`} cta="Open live card" />
          <div className="grid-2">
            <EventCard e={next} main={mains.get(next.id)} imgs={imgs} bouts={counts.get(next.id)} />
            <div className="card hi" style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: 28 }}>
              <div className="eyebrow">Before the first horn</div>
              <h2 className="serif" style={{ fontSize: 30, lineHeight: 1.05, margin: "7px 0 12px" }}>Card, matchup pages and the Pregame Desk in one place.</h2>
              <p className="dim sm">Open the event for the fight-week intelligence desk, every announced bout, tale-of-the-tape links, official video and the newsroom stories attached to this card.</p>
              <Link href={`/events/${eventSlug(next)}`} className="btn gold mt-4" style={{ alignSelf: "flex-start" }}>Enter {next.name} →</Link>
            </div>
          </div>
        </section>
      )}

      <SectionHead eyebrow={`${ufcUpcoming.length} announced · pay-per-views marked gold`} title="Upcoming UFC cards" />
      {ufcUpcoming.length ? [...months.entries()].map(([k, list]) => (
        <div className="sched-month" key={k}>
          <h3>{k === "TBA" ? "Date to be announced" : new Date(`${k}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} <small>{list.length} card{list.length === 1 ? "" : "s"}</small></h3>
          <div className="sched-list">{list.map((e) => <ScheduleRow key={e.id} e={e} main={mains.get(e.id)} imgs={imgs} bouts={counts.get(e.id)} />)}</div>
        </div>
      )) : <Empty title="No upcoming UFC events loaded">The schedule is refreshed from the production source feed. Announced UFC cards appear here with the full lineup as it becomes available.</Empty>}

      {dwcs.length > 0 && (
        <div className="mt-6"><div className="segment" style={{ marginTop: 0 }}><div className="between mb-4"><h3 style={{ margin: 0 }}>Dana White's Contender Series <small>{dwcs.length} upcoming week{dwcs.length === 1 ? "" : "s"} · separate track</small></h3><Link href="/contender-series" className="more" style={{ color: "var(--pbe-gold)", fontWeight: 700 }}>Every season &amp; result →</Link></div><div className="elist">{dwcs.map((e) => <EventRow key={e.id} e={e} main={mains.get(e.id)} bouts={counts.get(e.id)} />)}</div></div></div>
      )}

      <section className="archive-proof mt-7" id="archive">
        <div className="archive-proof-head">
          <div><div className="eyebrow">Historical coverage · live database</div><h2>Results archive status</h2></div>
          <span className={`archive-state ${ufc1Ready ? "ready" : "repair"}`}>{ufc1Ready ? "UFC 1 loaded" : "Backfill active"}</span>
        </div>
        <div className="archive-proof-grid">
          <div><b>{coverage.events.toLocaleString()}</b><span>UFC archive events<small className="cov-scope">excludes Contender Series &amp; Road to UFC</small></span></div>
          <div><b>{eventsWithCards.toLocaleString()}</b><span>events with bouts loaded</span></div>
          <div><b>{coverage.bouts.toLocaleString()}</b><span>bouts loaded</span></div>
          <div><b>{coverage.results.toLocaleString()}</b><span>results · {coverage.roundRows.toLocaleString()} round-stat rows<small className="cov-scope">one row per fighter per round</small></span></div>
        </div>
        <p>{ufc1Ready ? `UFC 1 currently has ${coverage.ufc1Bouts} bout rows in the canonical archive.` : "The historical event shell reaches back to the mid-1990s, but bout-level coverage is still being repaired backward year by year from archived UFC Stats captures. Missing cards are labeled as missing instead of synthesized."} Coverage checked {fmtDateTime(coverage.lastChecked)}. <Link href="/history#archive" style={{ color: "var(--pbe-gold)" }}>See the historical methodology →</Link></p>
        {yearCoverage.length > 0 && (
          <>
            <div className="coverage-years" aria-label="Archive coverage by year">
              {[...yearCoverage].sort((a, b) => a.year - b.year).map((y) => <Link key={y.year} href={`/events?year=${y.year}`} className="coverage-year" aria-current={y.year === year ? "true" : undefined} title={`${y.year}: ${y.events} events indexed, ${y.withBouts} with bouts loaded (${y.bouts} bouts)`}>{y.year}<i><b style={{ width: `${y.events ? Math.round((y.withBouts / y.events) * 100) : 0}%` }} /></i><small>{y.withBouts}/{y.events}</small></Link>)}
            </div>
            <div className="coverage-legend"><span>Bar = share of that year's indexed events with bout rows loaded.</span><span>Numbers = events with bouts / events indexed.</span></div>
          </>
        )}
      </section>

      <div className="mt-7" id="year">
        <SectionHead eyebrow={yc ? `${yc.events} event${yc.events === 1 ? "" : "s"} indexed · ${yc.withBouts} with bouts loaded · ${yc.bouts} bouts` : "Year-by-year results"} title={`${year} UFC results`} />
        <div className="years mb-5" role="navigation" aria-label="Archive by year">{years.map((y) => <Link key={y.year} href={`/events?year=${y.year}`} aria-current={y.year === year ? "true" : undefined} title={`${y.count} indexed event records`}>{y.year}</Link>)}</div>
        {yc && yc.withBouts < yc.events && <p className="dim sm mb-4">{yc.events - yc.withBouts} of the {yc.events} indexed {year} events are still event shells without bout rows. They are listed so the archive is honest about what exists; each opens with a "card not yet loaded" state until the historical backfill reaches it.</p>}
        {past.length ? <div className="elist">{past.map((e) => <EventRow key={e.id} e={e} main={mains.get(e.id)} bouts={counts.get(e.id)} />)}</div> : <Empty title={`No completed UFC event records in ${year} yet`}>Results appear as the historical and current ingest layers fill this year.</Empty>}
      </div>

      <OfficialDestinations keys={["home", "athletes", "fightpass", "store"]} title="Official UFC events, athletes and viewing" />

      <JsonLd data={{ "@context": "https://schema.org", "@type": "CollectionPage", name: "UFC schedule and results", url: `${SITE.url}/events`, dateModified: coverage.lastChecked, isPartOf: { "@id": `${SITE.url}/#site` }, mainEntity: { "@type": "ItemList", itemListElement: ufcUpcoming.slice(0, 20).map((e, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "SportsEvent", name: e.name, startDate: e.event_date, url: `${SITE.url}/events/${eventSlug(e)}`, sport: "Mixed Martial Arts", location: locationLine(e) ? { "@type": "Place", name: locationLine(e) } : undefined } })) } }} />
    </div>
  );
}
