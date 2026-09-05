import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventsOnDate, getEventBouts, type Bout, type Event } from "@/lib/db";
import { JsonLd, ProLock, TaleOfTheTape } from "@/components/ui";
import { eventDateFromSlug, eventSlug, fighterSlug, matchupSlug, slugify } from "@/lib/slug";
import { cardPositionLabel, fmtDate, fmtRecord, fmtTime, METHOD_LABEL, weightClassLabel } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;

async function resolve(slug: string): Promise<{ e: Event; b: Bout } | null> {
  const date = eventDateFromSlug(slug);
  if (!date) return null;
  const events = await getEventsOnDate(date);
  for (const e of events) {
    const bouts = await getEventBouts(e.id);
    const hit = bouts.find((b) => matchupSlug(b.fighter_a, b.fighter_b, e) === slug || matchupSlug(b.fighter_b, b.fighter_a, e) === slug);
    if (hit) return { e, b: hit };
    const loose = bouts.find((b) => slug.startsWith(`${slugify(b.fighter_a.name)}-vs-${slugify(b.fighter_b.name)}`) || slug.startsWith(`${slugify(b.fighter_b.name)}-vs-${slugify(b.fighter_a.name)}`));
    if (loose) return { e, b: loose };
  }
  return null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const hit = await resolve((await params).slug);
  if (!hit) return { title: "Matchup not found" };
  const { e, b } = hit;
  const title = `${b.fighter_a.name} vs ${b.fighter_b.name} — ${e.name}`;
  return {
    title: `${title} Prediction, Odds & Tale of the Tape`,
    description: `${b.fighter_a.name} (${fmtRecord(b.fighter_a)}) vs ${b.fighter_b.name} (${fmtRecord(b.fighter_b)}) at ${e.name} on ${fmtDate(e.event_date)}: tale of the tape, ${weightClassLabel(b.weight_class, b.is_womens)}, ${cardPositionLabel(b.card_position)}, and PropBetEdge model context.`,
    alternates: { canonical: `/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}` },
    openGraph: { title, description: `${fmtDate(e.event_date)} · ${weightClassLabel(b.weight_class, b.is_womens)}` },
  };
}

export default async function FightPage({ params }: { params: Promise<{ slug: string }> }) {
  const hit = await resolve((await params).slug);
  if (!hit) notFound();
  const { e, b } = hit;
  const r = b.result;
  const winner = r?.winner_id === b.fighter_a.id ? b.fighter_a : r?.winner_id === b.fighter_b.id ? b.fighter_b : null;
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow"><Link href={`/events/${eventSlug(e)}`}>{e.name}</Link> · {fmtDate(e.event_date)} · {cardPositionLabel(b.card_position)}</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 24px" }}>
        {b.fighter_a.name} <em style={{ color: "var(--pbe-gold)" }}>vs</em> {b.fighter_b.name}
      </h1>
      <div className="matchup">
        <div className="top"><span className="eyebrow">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title bout" : ""}{b.scheduled_rounds ? ` · ${b.scheduled_rounds} rounds` : ""}</span>
          {b.status === "cancelled" ? <span className="tag live">Cancelled</span> : r ? <span className="tag pos">Final</span> : <span className="tag">Scheduled</span>}</div>
        <div className="tape">
          <Link href={`/fighters/${fighterSlug(b.fighter_a)}`} className="side"><div className="name">{b.fighter_a.name}</div>{b.fighter_a.nickname && <div className="nick">“{b.fighter_a.nickname}”</div>}<div className="rec">{fmtRecord(b.fighter_a)}</div></Link>
          <div className="vs">vs</div>
          <Link href={`/fighters/${fighterSlug(b.fighter_b)}`} className="side"><div className="name">{b.fighter_b.name}</div>{b.fighter_b.nickname && <div className="nick">“{b.fighter_b.nickname}”</div>}<div className="rec">{fmtRecord(b.fighter_b)}</div></Link>
        </div>
        <TaleOfTheTape a={b.fighter_a} b={b.fighter_b} />
        {r ? (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="eyebrow">Result</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--pbe-paper)", margin: "6px 0" }}>{winner ? `${winner.name} def. ${winner.id === b.fighter_a.id ? b.fighter_b.name : b.fighter_a.name}` : METHOD_LABEL[r.method] || r.method}</div>
            <div className="mono dim" style={{ fontSize: "var(--fs-sm)" }}>
              {METHOD_LABEL[r.method] || r.method}{r.finish_detail ? ` (${r.finish_detail})` : ""}{r.round ? ` · Round ${r.round}` : ""}{r.time_sec != null ? ` · ${fmtTime(r.time_sec)}` : ""}{r.referee ? ` · Ref ${r.referee}` : ""}
            </div>
            <div className="faint" style={{ fontSize: "var(--fs-label)", marginTop: 6 }}>Source: {r.result_source === "espn" ? "ESPN" : "UFC Stats"}{r.has_stats ? " · round stats archived" : ""}</div>
          </div>
        ) : <ProLock />}
      </div>
      <JsonLd data={{
        "@context": "https://schema.org", "@type": "SportsEvent", name: `${b.fighter_a.name} vs ${b.fighter_b.name}`, startDate: e.event_date, sport: "Mixed Martial Arts",
        superEvent: { "@type": "SportsEvent", name: e.name, url: `${SITE.url}/events/${eventSlug(e)}` },
        competitor: [{ "@type": "Person", name: b.fighter_a.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_a)}` }, { "@type": "Person", name: b.fighter_b.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_b)}` }],
        url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`,
      }} />
    </div>
  );
}
