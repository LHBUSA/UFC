import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventBouts, getImagesForFighters, getArticlesForEvent, getUpcomingEvents, getRecentEvents, getVideosForEvent, getImageFraming, sortVideosTimeline, getRankings } from "@/lib/db";
import { storyMedia } from "@/lib/faces";
import { resolveEvent } from "@/lib/resolve";
import { CardSegments, Empty, JsonLd, MatchupCard, Breadcrumbs, Avatar, EventRow } from "@/components/ui";
import { NewsStoryCard } from "@/components/NewsStoryCard";
import { PregameDesk } from "@/components/PregameDesk";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { buildDeskBriefs } from "@/lib/pregame";
import { intelligenceUpdated } from "@/lib/fightweek";
import { getIngestFreshness } from "@/lib/archive";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { daysUntil, fmtDate, locationLine, eventBrand, eventStatusLabel, fmtRecord, weightClassLabel, winnerOf, METHOD_LABEL, fmtTime, plural } from "@/lib/format";
import { isDanaWhiteContenderSeries } from "@/lib/contender";
import { SITE } from "@/lib/site";
import { UFC_OFFICIAL } from "@/lib/heritage";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const e = await resolveEvent((await params).slug);
  if (!e) return { title: "Event not found", robots: { index: false } };
  const where = [e.venue, e.city, e.country].filter(Boolean).join(", ");
  const done = e.card_status === "complete";
  const title = done ? `${e.name} — Results, Full Card & Stats` : `${e.name} — Fight Card, Pregame Desk & Matchups`;
  const og = `${SITE.url}/events/${eventSlug(e)}/opengraph-image`;
  return {
    title,
    description: `${e.name} on ${fmtDate(e.event_date)}${where ? ` at ${where}` : ""}. ${done ? "Loaded results with method, round, time and round-level stats where available." : "Full announced fight card, Pregame Desk fight-week intelligence, fighter records, tale of the tape and matchup pages."}`,
    alternates: { canonical: `/events/${eventSlug(e)}` },
    openGraph: { title: e.name, description: `${fmtDate(e.event_date)}${where ? ` · ${where}` : ""}`, type: "website", url: `${SITE.url}/events/${eventSlug(e)}`, images: [{ url: og, width: 1200, height: 630, alt: e.name }] },
    twitter: { card: "summary_large_image", title: e.name, images: [og] },
  };
}

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const e = await resolveEvent((await params).slug);
  if (!e) notFound();
  const [bouts, articles, videosRaw] = await Promise.all([getEventBouts(e.id), getArticlesForEvent(e.id), getVideosForEvent(e.id, 24).catch(() => [])]);
  const videos = sortVideosTimeline(videosRaw);
  const imgs = await getImagesForFighters(bouts.flatMap((b) => [b.fighter_a.id, b.fighter_b.id]));
  const framing = await getImageFraming(bouts.slice(0, 1).flatMap((b) => [imgs.get(b.fighter_a.id)?.id, imgs.get(b.fighter_b.id)?.id]).filter(Boolean) as string[]);
  const media = await storyMedia(articles);
  const d = daysUntil(e.event_date);
  const live = bouts.filter((b) => b.status !== "cancelled");
  const main = live[0] || null;
  const headline = live.slice(0, 2);
  const done = e.card_status === "complete" || (bouts.length > 0 && live.every((b) => b.result));
  const historical = !done && bouts.length === 0 && d != null && d < 0;
  const finishes = live.filter((b) => b.result && (b.result.method === "KO_TKO" || b.result.method === "SUB")).length;
  const decisions = live.filter((b) => b.result && b.result.method.startsWith("DEC")).length;
  const titleBouts = live.filter((b) => b.is_title).length;
  const [briefs, rankings, ingest] = await Promise.all([!done && live.length > 0 ? buildDeskBriefs(e, live, 1).catch(() => []) : Promise.resolve([]), getRankings().catch(() => null), getIngestFreshness().catch(() => null)]);
  const nearby = done || historical ? await getRecentEvents(4) : await getUpcomingEvents(4);
  const isCurrent = !done && nearby[0]?.id === e.id;
  const others = nearby.filter((x) => x.id !== e.id).slice(0, 3);
  const dwcs = isDanaWhiteContenderSeries(e.name);

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: dwcs ? "Contender Series" : "Schedule", href: dwcs ? "/contender-series" : "/events" }, { name: e.name }]} />
      <div className="poster" style={{ minHeight: 0 }}>
        <div className="poster-top">
          <span className="eyebrow">{eventBrand(e.name)}{e.is_ppv ? " · Pay-per-view" : ""}</span>
          <span className={`tag${!done && d != null && d >= 0 && d <= 6 ? " gold" : done ? " pos" : ""}`}>{historical ? "Historical · card not yet loaded" : eventStatusLabel(e)}</span>
        </div>
        {main ? (
          <>
            <div className="poster-faces">
              {[main.fighter_a, main.fighter_b].map((f, i) => {
                const img = imgs.get(f.id);
                return <div className={`face ${i ? "b" : "a"}`} key={f.id}>{img ? <img src={img.card} alt={f.name} width={800} height={1000} fetchPriority="high" decoding="async" /> : <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><Avatar f={f} size={120} /></div>}</div>;
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
            <div className="m"><time dateTime={e.event_date || undefined}>{fmtDate(e.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</time> · {locationLine(e) || "Venue TBA"}</div>
            <div className="m">{main ? `${weightClassLabel(main.weight_class, main.is_womens)}${main.is_title ? " title" : ""} main event` : historical ? "Bout rows not yet loaded for this historical event" : "Main event TBA"}{live.length ? ` · ${plural(live.length, "bout")}` : ""}{titleBouts ? ` · ${plural(titleBouts, "title fight")}` : ""}{done && main?.result ? ` · ${METHOD_LABEL[main.result.method]}${main.result.round ? ` R${main.result.round}` : ""}${main.result.time_sec != null ? ` ${fmtTime(main.result.time_sec)}` : ""}` : ""}</div>
          </div>
          {!done && d != null && d >= 0 ? <div className="count"><b>{d}</b><span>{d === 1 ? "day out" : "days out"}</span></div> : done && live.length ? <div className="count"><b>{finishes}</b><span>finishes · {decisions} dec</span></div> : null}
        </div>
      </div>

      <div className="mt-4"><OfficialDestinations compact keys={["home", "fightpass", "store"]} /></div>

      {live.length > 0 && !historical && <div className="mt-6"><PregameDesk event={e} briefs={briefs} imgs={imgs} framing={framing} mode="cta" meta={{ fights: live.length, updated: intelligenceUpdated(ingest, rankings, videos), href: `/pregame/${eventSlug(e)}`, done, hub: isCurrent }} /></div>}

      {bouts.length ? (
        <>
          <CardSegments bouts={bouts} e={e} imgs={imgs} />
          {headline.length > 0 && <section className="segment"><h3>{done ? "Main event & co-main" : "Headline matchups"} <small>tale of the tape</small></h3><div className="grid-2">{headline.map((b) => <MatchupCard key={b.id} b={b} e={e} imgs={imgs} />)}</div></section>}
        </>
      ) : historical ? (
        <div className="mt-6"><Empty title="Historical card not yet loaded" cta={{ href: "/history#archive", label: "Archive coverage" }}>This event exists in the canonical schedule, but its bouts and results have not been backfilled yet. PropBetEdge fills the archive year by year from archived UFC Stats captures and shows this state instead of inventing a card. The official record is at <a href={UFC_OFFICIAL.events} target="_blank" rel="noopener">UFC.com events</a>.</Empty></div>
      ) : (
        <div className="mt-6"><Empty title="Card not published yet" cta={{ href: "/events", label: "Other cards" }}>This event is on the schedule but no bouts have been announced. The card appears as soon as it is published, with fighter records and matchup pages.</Empty></div>
      )}

      <VideoRail variant="timeline" videos={videos} title={done ? "Official video from this card" : "Fight-week video"} eyebrow="Official channels · event relevance first" note="Videos are attached to this event by the resolver only when the title or description names it · embedded from YouTube, not hosted by PropBetEdge" />

      {articles.length > 0 && <section className="segment"><h3>{done ? "Post-fight desk" : "Pregame reading"} <small>{plural(articles.length, "story", "stories")} · timestamped</small></h3><div className="news">{articles.map((a) => <NewsStoryCard key={a.id} a={a} hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} kicker={eventBrand(e.name)} />)}</div></section>}

      {others.length > 0 && <section className="segment"><h3>{done || historical ? "More recent cards" : "Also coming up"}</h3><div className="elist">{others.map((x) => <EventRow key={x.id} e={x} />)}</div></section>}

      <JsonLd data={{ "@context": "https://schema.org", "@type": "SportsEvent", "@id": `${SITE.url}/events/${eventSlug(e)}#event`, name: e.name, startDate: e.event_date, endDate: e.event_date, sport: "Mixed Martial Arts", description: `${e.name}: ${live.length ? `${live.length} bouts` : "card"}${main ? `, main event ${main.fighter_a.name} vs ${main.fighter_b.name}` : ""}.`, eventStatus: done ? "https://schema.org/EventCompleted" : "https://schema.org/EventScheduled", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode", image: `${SITE.url}/events/${eventSlug(e)}/opengraph-image`, location: e.venue || e.city ? { "@type": "Place", name: e.venue || e.city, address: { "@type": "PostalAddress", addressLocality: e.city, addressRegion: e.region, addressCountry: e.country } } : undefined, organizer: { "@type": "SportsOrganization", name: "Ultimate Fighting Championship", url: UFC_OFFICIAL.home }, url: `${SITE.url}/events/${eventSlug(e)}`, video: videos.length ? videoJsonLd(videos) : undefined, subEvent: live.map((b) => ({ "@type": "SportsEvent", name: `${b.fighter_a.name} vs ${b.fighter_b.name}`, startDate: e.event_date, url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`, sport: "Mixed Martial Arts", competitor: [{ "@type": "Person", name: b.fighter_a.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_a)}` }, { "@type": "Person", name: b.fighter_b.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_b)}` }] })) }} />
    </div>
  );
}
