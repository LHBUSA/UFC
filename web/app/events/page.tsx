import type { Metadata } from "next";
import Link from "next/link";
import { getUpcomingEvents, getEventsInYear, getEventYears, getMainEvents, getImagesForFighters, getBoutCounts, isContenderSeries } from "@/lib/db";
import { Empty, EventCard, EventRow, PageHead, SectionHead, JsonLd } from "@/components/ui";
import { eventSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "UFC Events & Fight Cards — Schedule and Results",
  description: "Every upcoming UFC event with the full card, main card and prelims, plus a complete results archive back to UFC 1 with round-level stats.",
  alternates: { canonical: "/events" },
  openGraph: { title: "UFC Events & Fight Cards", description: "Upcoming UFC cards and a complete results archive.", url: `${SITE.url}/events` },
};

export default async function EventsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const sp = await searchParams;
  const years = await getEventYears();
  const thisYear = new Date().getUTCFullYear();
  const year = Number(sp.year) && years.some((y) => y.year === Number(sp.year)) ? Number(sp.year) : (years[0]?.year || thisYear);
  const [upcoming, inYear] = await Promise.all([getUpcomingEvents(24, { includeContenderSeries: true }), getEventsInYear(year)]);
  const today = new Date().toISOString().slice(0, 10);
  const past = inYear.filter((e) => e.event_date && e.event_date < today);
  const ufcUpcoming = upcoming.filter((e) => !isContenderSeries(e.name));
  const dwcs = upcoming.filter((e) => isContenderSeries(e.name));
  const ids = [...ufcUpcoming, ...past.slice(0, 60)].map((e) => e.id);
  const [mains, counts] = await Promise.all([getMainEvents(ids), getBoutCounts(ids)]);
  const imgs = await getImagesForFighters([...mains.values()].flatMap((b) => [b.fighter_a.id, b.fighter_b.id]));

  return (
    <div className="wrap page">
      <PageHead crumbs={[{ name: "Events" }]} eyebrow="Schedule & archive" title="UFC events" lede="Every announced card with fighters, records and matchup pages, and a results archive that goes back to the first event. Cards refresh nightly from the public schedule." />

      <SectionHead eyebrow={`${ufcUpcoming.length} announced`} title="Upcoming cards" />
      {ufcUpcoming.length ? (
        <div className="grid-3">{ufcUpcoming.map((e) => <EventCard key={e.id} e={e} main={mains.get(e.id)} imgs={imgs} bouts={counts.get(e.id)} />)}</div>
      ) : <Empty title="No upcoming events loaded">The schedule is refreshed nightly from the public calendar. Announced cards appear here with the full lineup.</Empty>}

      {dwcs.length > 0 && (
        <div className="mt-6">
          <div className="segment" style={{ marginTop: 0 }}>
            <h3>Contender Series <small>{dwcs.length} weeks</small></h3>
            <div className="elist">{dwcs.map((e) => <EventRow key={e.id} e={e} bouts={counts.get(e.id)} />)}</div>
          </div>
        </div>
      )}

      <div className="mt-7">
        <SectionHead eyebrow="Results archive" title={`${year} results`} />
        <div className="years mb-5" role="navigation" aria-label="Archive by year">
          {years.map((y) => <Link key={y.year} href={`/events?year=${y.year}`} aria-current={y.year === year ? "true" : undefined} title={`${y.count} events`}>{y.year}</Link>)}
        </div>
        {past.length ? (
          <div className="elist">{past.map((e) => <EventRow key={e.id} e={e} main={mains.get(e.id)} bouts={counts.get(e.id)} />)}</div>
        ) : <Empty title={`No completed events in ${year} yet`}>Results land here the morning after each card, with round-by-round stats where available.</Empty>}
      </div>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "CollectionPage", name: "UFC events", url: `${SITE.url}/events`, isPartOf: { "@id": `${SITE.url}/#site` },
        mainEntity: { "@type": "ItemList", itemListElement: ufcUpcoming.slice(0, 20).map((e, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE.url}/events/${eventSlug(e)}`, name: e.name })) },
      }} />
    </div>
  );
}
