import type { Metadata } from "next";
import { getAllEvents } from "@/lib/db";
import { Empty, EventCard, SectionHead } from "@/components/ui";

export const revalidate = 300;
export const metadata: Metadata = { title: "UFC Events & Fight Cards", description: "Every upcoming and completed UFC event with full cards, main card and prelims, results and round-level stats.", alternates: { canonical: "/events" } };

export default async function EventsPage() {
  const all = await getAllEvents();
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = all.filter((e) => e.event_date && e.event_date >= today).sort((a, b) => a.event_date!.localeCompare(b.event_date!));
  const past = all.filter((e) => !e.event_date || e.event_date < today);
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow">Schedule</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 32px" }}>UFC events</h1>
      <SectionHead title="Upcoming" />
      {upcoming.length ? <div className="grid-2">{upcoming.map((e) => <EventCard key={e.id} e={e} />)}</div> : <Empty title="No upcoming events loaded">The schedule is refreshed nightly from ESPN's public calendar.</Empty>}
      <div style={{ height: 48 }} />
      <SectionHead title="Completed" />
      {past.length ? <div className="grid-3">{past.map((e) => <EventCard key={e.id} e={e} />)}</div> : <Empty title="Archive backfill in progress">Historical events land here as the backfill runs. Each one carries results and, where available, round-by-round stats.</Empty>}
    </div>
  );
}
