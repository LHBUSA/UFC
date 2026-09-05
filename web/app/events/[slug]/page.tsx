import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getEventsOnDate, getEventBouts, type Event } from "@/lib/db";
import { CardSegments, Empty, JsonLd, MatchupCard } from "@/components/ui";
import { eventDateFromSlug, eventSlug } from "@/lib/slug";
import { daysUntil, fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;

async function resolve(slug: string): Promise<Event | null> {
  const date = eventDateFromSlug(slug);
  if (!date) return null;
  const events = await getEventsOnDate(date);
  return events.find((e) => eventSlug(e) === slug) || events[0] || null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const e = await resolve((await params).slug);
  if (!e) return { title: "Event not found" };
  const where = [e.venue, e.city, e.country].filter(Boolean).join(", ");
  return {
    title: `${e.name} — Full Card, Results & Odds Context`,
    description: `${e.name} on ${fmtDate(e.event_date)}${where ? ` at ${where}` : ""}. Main card, prelims, fighter records, results and round stats.`,
    alternates: { canonical: `/events/${eventSlug(e)}` },
    openGraph: { title: e.name, description: `${fmtDate(e.event_date)}${where ? ` · ${where}` : ""}`, type: "website" },
  };
}

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const e = await resolve((await params).slug);
  if (!e) notFound();
  const bouts = await getEventBouts(e.id);
  const d = daysUntil(e.event_date);
  const main = bouts.slice(0, 2);
  const where = [e.venue, e.city, e.region, e.country].filter(Boolean).join(" · ");
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="event-hero">
        <div>
          <div className="eyebrow">{e.card_status === "complete" ? "Final" : e.card_status === "locked" ? "Card locked" : "Announced card"}</div>
          <h1 style={{ margin: "10px 0" }}>{e.name}</h1>
          <div className="mono dim">{fmtDate(e.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
          <div className="faint">{where || "Venue TBA"}</div>
        </div>
        {d != null && d >= 0 && (
          <div className="countdown"><b>{d}</b><span className="eyebrow dim">{d === 1 ? "day" : "days"} out</span></div>
        )}
      </div>

      {bouts.length ? (
        <>
          <CardSegments bouts={bouts} e={e} />
          {main.length > 0 && (
            <section className="segment">
              <h3>Headline matchups</h3>
              <div className="grid-2">{main.map((b) => <MatchupCard key={b.id} b={b} e={e} />)}</div>
            </section>
          )}
        </>
      ) : (
        <div style={{ marginTop: 32 }}>
          <Empty title="Card not published yet">This event is on the schedule but no bouts have been announced. Bouts appear as soon as ESPN lists them.</Empty>
        </div>
      )}

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "SportsEvent", name: e.name, startDate: e.event_date, sport: "Mixed Martial Arts",
        eventStatus: e.card_status === "complete" ? "https://schema.org/EventScheduled" : "https://schema.org/EventScheduled",
        location: e.venue || e.city ? { "@type": "Place", name: e.venue || e.city, address: { "@type": "PostalAddress", addressLocality: e.city, addressRegion: e.region, addressCountry: e.country } } : undefined,
        organizer: { "@type": "Organization", name: "Ultimate Fighting Championship" },
        url: `${SITE.url}/events/${eventSlug(e)}`,
        subEvent: bouts.map((b) => ({ "@type": "SportsEvent", name: `${b.fighter_a.name} vs ${b.fighter_b.name}`, startDate: e.event_date,
          competitor: [{ "@type": "Person", name: b.fighter_a.name }, { "@type": "Person", name: b.fighter_b.name }] })),
      }} />
    </div>
  );
}
