import type { Metadata } from "next";
import { getUpcomingEvents } from "@/lib/db";
import { loadFightWeek, resolveFightWeekEvent } from "@/lib/fightweek";
import { FightWeekEmpty, FightWeekPage } from "@/components/FightWeek";
import { eventSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";

/* /fight-week — the Pregame Desk hub. Auto-rolls to the current or next
 * canonical UFC card from the schedule; nothing about the event is
 * hard-coded. Between cards (no event, or a card with no announced bouts)
 * the desk shows its "opens as the card fills" state. */
export const revalidate = 300;

const TITLE = "UFC Fight Week Intelligence — PropBetEdge Pregame Desk";

export async function generateMetadata(): Promise<Metadata> {
  const e = await resolveFightWeekEvent();
  const description = e
    ? `${e.name} on ${fmtDate(e.event_date)}: fight reads, key comparisons, three things that matter, how each fighter wins and fight-phase intelligence for every announced bout, built from records, UFC Stats, archived results, the official rankings snapshot and Fight DNA.`
    : "The PropBetEdge Pregame Desk for the next UFC card: fight reads, key comparisons, how each fighter wins and fight-phase intelligence, built only from verified evidence.";
  const og = e ? `${SITE.url}/events/${eventSlug(e)}/opengraph-image` : `${SITE.url}/opengraph-image`;
  return {
    title: { absolute: TITLE },
    description,
    alternates: { canonical: "/fight-week" },
    openGraph: { title: TITLE, description, type: "website", url: `${SITE.url}/fight-week`, images: [{ url: og, width: 1200, height: 630, alt: e ? e.name : SITE.name }] },
    twitter: { card: "summary_large_image", title: TITLE, description, images: [og] },
  };
}

export default async function FightWeekHub() {
  const e = await resolveFightWeekEvent();
  if (!e) {
    const upcoming = await getUpcomingEvents(4);
    return <FightWeekEmpty next={null} upcoming={upcoming} />;
  }
  const packet = await loadFightWeek(e);
  if (!packet.live.length) {
    const upcoming = (await getUpcomingEvents(5)).filter((x) => x.id !== e.id);
    return <FightWeekEmpty next={e} upcoming={upcoming} />;
  }
  return <FightWeekPage packet={packet} archive={false} />;
}
