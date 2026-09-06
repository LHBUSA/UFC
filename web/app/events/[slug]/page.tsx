import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventBouts, getImagesForFighters, getArticlesForEvent, getUpcomingEvents, getRecentEvents } from "@/lib/db";
import { storyMedia } from "@/lib/faces";
import { resolveEvent } from "@/lib/resolve";
import { CardSegments, Empty, JsonLd, MatchupCard, Breadcrumbs, StoryCard, Avatar, EventRow } from "@/components/ui";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { daysUntil, fmtDate, locationLine, eventBrand, eventHeadline, eventStatusLabel, fmtRecord, weightClassLabel, winnerOf, METHOD_LABEL, fmtTime, plural } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const e = await resolveEvent((await params).slug);
  if (!e) return { title: "Event not found", robots: { index: false } };
  const where = [e.venue, e.city, e.country].filter(Boolean).join(", ");
  const done = e.card_status === "complete";
  const title = done ? `${e.name} — Results, Full Card & Stats` : `${e.name} — Fight Card, Start Time & Matchups`;
  return {
    title,
    description: `${e.name} on ${fmtDate(e.event_date)}${where ? ` at ${where}` : ""}. ${done ? "Complete results for every bout with method, round, time and round-by-round stats." : "Full fight card with main card and prelims, fighter records, tale of the tape and matchup pages."}`,
    alternates: { canonical: `/events/${eventSlug(e)}` },
    openGraph: { title: e.name, description: `${fmtDate(e.event_date)}${where ? ` · ${where}` : ""}`, type: "website", url: `${SITE.url}/events/${eventSlug(e)}` },
    twitter: { card: "summary_large_image", title: e.name },
  };
}

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const e = await resolveEvent((await params).slug);
  if (!e) notFound();
  const [bouts, articles] = await Promise.all([getEventBouts(e.id), getArticlesForEvent(e.id)]);
  const imgs = await getImagesForFighters(bouts.flatMap((b) => [b.fighter_a.id, b.fighter_b.id]));
  const media = await storyMedia(articles);
  const d = daysUntil(e.event_date);
  const live = bouts.filter((b) => b.status !== "cancelled");
  const main = live[0] || null;
  const headline = live.slice(0, 2);
  const done = e.card_status === "complete" || (bouts.length > 0 && live.every((b) => b.result));
  const finishes = live.filter((b) => b.result && (b.result.method === "KO_TKO" || b.result.method === "SUB")).length;
  const decisions = live.filter((b) => b.result && b.result.method.startsWith("DEC")).length;
  const titleBouts = live.filter((b) => b.is_title).length;
  const nearby = done ? await getRecentEvents(4) : await getUpcomingEvents(4);
  const others = nearby.filter((x) => x.id !== e.id).slice(0, 3);

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Events", href: "/events" }, { name: e.name }]} />
      <div className="poster" style={{ minHeight: 0 }}>
        <div className="poster-top">
          <span className="eyebrow">{eventBrand(e.name)}{e.is_ppv ? " · Pay-per-view" : ""}</span>
          <span className={`tag${!done && d != null && d >= 0 && d <= 6 ? " gold" : done ? " pos" : ""}`}>{eventStatusLabel(e)}</span>
        </div>
        {main ? (
          <>
            <div className="poster-faces">
              {[main.fighter_a, main.fighter_b].map((f, i) => {
                const img = imgs.get(f.id);
                return (
                  <div className={`face ${i ? "b" : "a"}`} key={f.id}>
                    {img ? <img src={img.card} alt={f.name} width={800} height={1000} fetchPriority="high" decoding="async" /> : (
                      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><Avatar f={f} size={120} /></div>
                    )}
                  </div>
                );
              })}
              <div className="vs" style={{ gridColumn: 2, gridRow: 1 }}>{done ? "FINAL" : "VS"}</div>
            </div>
            <div className="poster-names">
              <Link href={`/fighters/${fighterSlug(main.fighter_a)}`} className="a"><div className={`n${winnerOf(main)?.id === main.fighter_a.id ? " w" : ""}`}>{main.fighter_a.name}</div><div className="r">{fmtRecord(main.fighter_a)}</div></Link>
              <Link href={`/fighters/${fighterSlug(main.fighter_b)}`} className="b"><div className={`n${winnerOf(main)?.id === main.fighter_b.id ? " w" : ""}`}>{main.fighter_b.name}</div><div className="r">{fmtRecord(main.fighter_b)}</div></Link>
            </div>
          </>
        ) : null}
        <div className="poster-foot">
          <div>
            <h1 className="t" style={{ fontSize: "clamp(26px, 3.4vw, 44px)" }}>{e.name}</h1>
            <div className="m">{fmtDate(e.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · {locationLine(e) || "Venue TBA"}</div>
            <div className="m">
              {main ? `${weightClassLabel(main.weight_class, main.is_womens)}${main.is_title ? " title" : ""} main event` : "Main event TBA"}
              {live.length ? ` · ${plural(live.length, "bout")}` : ""}{titleBouts ? ` · ${plural(titleBouts, "title fight")}` : ""}
              {done && main?.result ? ` · ${METHOD_LABEL[main.result.method]}${main.result.round ? ` R${main.result.round}` : ""}${main.result.time_sec != null ? ` ${fmtTime(main.result.time_sec)}` : ""}` : ""}
            </div>
          </div>
          {!done && d != null && d >= 0 ? <div className="count"><b>{d}</b><span>{d === 1 ? "day out" : "days out"}</span></div>
            : done && live.length ? <div className="count"><b>{finishes}</b><span>finishes · {decisions} dec</span></div> : null}
        </div>
      </div>

      {bouts.length ? (
        <>
          <CardSegments bouts={bouts} e={e} imgs={imgs} />
          {headline.length > 0 && (
            <section className="segment">
              <h3>{done ? "Main event & co-main" : "Headline matchups"} <small>tale of the tape</small></h3>
              <div className="grid-2">{headline.map((b) => <MatchupCard key={b.id} b={b} e={e} imgs={imgs} />)}</div>
            </section>
          )}
        </>
      ) : (
        <div className="mt-6">
          <Empty title="Card not published yet" cta={{ href: "/events", label: "Other cards" }}>This event is on the schedule but no bouts have been announced. The card appears as soon as it is published, with fighter records and matchup pages.</Empty>
        </div>
      )}

      {articles.length > 0 && (
        <section className="segment">
          <h3>From the desk <small>{plural(articles.length, "story", "stories")}</small></h3>
          <div className="news">{articles.map((a) => <StoryCard key={a.id} a={a} hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} kicker={eventBrand(e.name)} />)}</div>
        </section>
      )}

      {others.length > 0 && (
        <section className="segment">
          <h3>{done ? "More recent cards" : "Also coming up"}</h3>
          <div className="elist">{others.map((x) => <EventRow key={x.id} e={x} />)}</div>
        </section>
      )}

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "SportsEvent", "@id": `${SITE.url}/events/${eventSlug(e)}#event`, name: e.name, startDate: e.event_date, endDate: e.event_date,
        sport: "Mixed Martial Arts", description: `${e.name}: ${live.length ? `${live.length} bouts` : "card"}${main ? `, main event ${main.fighter_a.name} vs ${main.fighter_b.name}` : ""}.`,
        eventStatus: e.card_status === "complete" ? "https://schema.org/EventScheduled" : "https://schema.org/EventScheduled", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        image: `${SITE.url}/events/${eventSlug(e)}/opengraph-image`,
        location: e.venue || e.city ? { "@type": "Place", name: e.venue || e.city, address: { "@type": "PostalAddress", addressLocality: e.city, addressRegion: e.region, addressCountry: e.country } } : undefined,
        organizer: { "@type": "SportsOrganization", name: "Ultimate Fighting Championship", url: "https://www.ufc.com" },
        url: `${SITE.url}/events/${eventSlug(e)}`,
        subEvent: live.map((b) => ({
          "@type": "SportsEvent", name: `${b.fighter_a.name} vs ${b.fighter_b.name}`, startDate: e.event_date, url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`, sport: "Mixed Martial Arts",
          competitor: [{ "@type": "Person", name: b.fighter_a.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_a)}` }, { "@type": "Person", name: b.fighter_b.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_b)}` }],
        })),
      }} />
    </div>
  );
}
