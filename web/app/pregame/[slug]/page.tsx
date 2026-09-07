import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveEvent } from "@/lib/resolve";
import { loadFightWeek } from "@/lib/fightweek";
import { FightWeekPage } from "@/components/FightWeek";
import { Breadcrumbs, Empty } from "@/components/ui";
import { eventSlug } from "@/lib/slug";
import { daysUntil, fmtDate, locationLine } from "@/lib/format";
import { UFC_OFFICIAL } from "@/lib/heritage";
import { SITE } from "@/lib/site";

/* /pregame/[event-slug] — the permanent Pregame Desk page for one event.
 * Before the card it mirrors the Fight Week hub; after the card it stays as
 * the archived pregame read (form limited to results before the event date)
 * and points to the event page for results. */
export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const e = await resolveEvent((await params).slug);
  if (!e) return { title: "Pregame Desk not found", robots: { index: false } };
  const title = `${e.name} — Pregame Intelligence & Matchup Preview`;
  const where = [e.venue, e.city, e.country].filter(Boolean).join(", ");
  const description = `${e.name} on ${fmtDate(e.event_date)}${where ? ` at ${where}` : ""}: Pregame Desk fight reads, key comparisons, three things that matter, how each fighter wins and fight-phase intelligence for every bout, built from records, UFC Stats, archived results, rankings and Fight DNA.`;
  const og = `${SITE.url}/events/${eventSlug(e)}/opengraph-image`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/pregame/${eventSlug(e)}` },
    openGraph: { title, description, type: "website", url: `${SITE.url}/pregame/${eventSlug(e)}`, images: [{ url: og, width: 1200, height: 630, alt: e.name }] },
    twitter: { card: "summary_large_image", title, description, images: [og] },
  };
}

export default async function PregamePage({ params }: { params: Promise<{ slug: string }> }) {
  const e = await resolveEvent((await params).slug);
  if (!e) notFound();
  const packet = await loadFightWeek(e, { archive: true });
  if (!packet.live.length) {
    const d = daysUntil(e.event_date);
    const historical = d != null && d < 0;
    return (
      <div className="wrap fw-page">
        <Breadcrumbs items={[{ name: "Fight Week", href: "/fight-week" }, { name: e.name }]} />
        <header className="fw-head">
          <div>
            <div className="fw-kicker"><i />Pregame Desk · {historical ? "Archive" : "Fight week"}</div>
            <h1>{e.name}</h1>
            <div className="fw-meta"><span><time dateTime={e.event_date || undefined}>{fmtDate(e.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</time></span><span>{locationLine(e) || "Venue TBA"}</span></div>
          </div>
          <div className="fw-actions"><Link href={`/events/${eventSlug(e)}`} className="btn gold">Event page</Link><a href={UFC_OFFICIAL.events} className="btn" target="_blank" rel="noopener">Official UFC event ↗</a></div>
        </header>
        <div className="mt-6">
          {historical
            ? <Empty title="Pregame packet not available for this historical card" cta={{ href: "/history#archive", label: "Archive coverage" }}>The bouts for this event have not been backfilled yet, so there is no stored packet to read from. PropBetEdge shows this state instead of inventing a card.</Empty>
            : <Empty title="Intelligence desk opens as the card fills" cta={{ href: "/fight-week", label: "Fight Week hub" }}>No bouts have been announced for this event yet. The Pregame Desk builds its reads from the published card, fighter rows, archived results, rankings and Fight DNA the moment bouts land.</Empty>}
        </div>
      </div>
    );
  }
  return <FightWeekPage packet={packet} archive />;
}
