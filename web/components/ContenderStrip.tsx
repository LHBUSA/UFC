import Link from "next/link";
import type { Bout, Event } from "@/lib/db";
import { eventSlug } from "@/lib/slug";
import { contenderIdentity } from "@/lib/contenderIdentity";
import { daysUntil, eventStatusLabel, fmtDate, fmtDateTime, locationLine, METHOD_SHORT, winnerOf } from "@/lib/format";
import { UFC_OFFICIAL } from "@/lib/heritage";

/* Homepage Contender Series module. Deliberately its own track — it never
 * mixes into the UFC card poster or the main schedule — but it keeps the
 * current DWCS week visible during a season with status and freshness. */
export function ContenderStrip({ next, last, mains, counts, freshness }: {
  next: Event | null; last: Event | null; mains: Map<string, Bout>; counts: Map<string, number>; freshness: string | null;
}) {
  if (!next && !last) return null;
  const row = (e: Event, kind: "next" | "last") => {
    const main = mains.get(e.id);
    const w = main ? winnerOf(main) : null;
    const d = daysUntil(e.event_date);
    const id = contenderIdentity(e.name, e.event_date);
    return (
      <Link href={`/events/${eventSlug(e)}`} className={`dwcs-strip-card ${kind}`} key={e.id}>
        <div className="dwcs-strip-kicker">{kind === "next" ? (d === 0 ? "Tonight" : d != null && d <= 6 ? "This week" : "Next episode") : "Last result"} · {id.label}</div>
        <div className="dwcs-strip-main">{main ? (w ? <><b>{w.name}</b> def. {w.id === main.fighter_a.id ? main.fighter_b.name : main.fighter_a.name}{main.result ? ` · ${METHOD_SHORT[main.result.method] || main.result.method}` : ""}</> : <><b>{main.fighter_a.name}</b> vs <b>{main.fighter_b.name}</b></>) : "Card lineup pending"}</div>
        <div className="dwcs-strip-meta">{fmtDate(e.event_date)}{locationLine(e) ? ` · ${locationLine(e)}` : ""}{counts.get(e.id) ? ` · ${counts.get(e.id)} bouts` : ""} · <span className="tag">{eventStatusLabel(e)}</span></div>
      </Link>
    );
  };
  return (
    <section className="dwcs-strip" aria-labelledby="dwcs-title">
      <div className="dwcs-strip-head">
        <div>
          <div className="eyebrow">Dana White's Contender Series · separate track</div>
          <h2 id="dwcs-title">The pipeline to the roster</h2>
          <p>Prospects fight for a UFC contract in front of the matchmakers. PropBetEdge tracks every season and week as its own archive so it never crowds the main UFC schedule.</p>
        </div>
        <div className="dwcs-strip-actions">
          <Link href="/contender-series" className="btn gold">Every season &amp; week →</Link>
          <a href={UFC_OFFICIAL.contenderSeries} className="btn" target="_blank" rel="noopener">Official DWCS ↗</a>
        </div>
      </div>
      <div className="dwcs-strip-grid">
        {next && row(next, "next")}
        {last && row(last, "last")}
      </div>
      <div className="dwcs-fresh"><i />{freshness ? <>Data sync <time dateTime={freshness}>{fmtDateTime(freshness)}</time></> : <>Live database · freshness timestamp unavailable</>} · <Link href="/voices/dana-white">Who Dana White is →</Link></div>
    </section>
  );
}
