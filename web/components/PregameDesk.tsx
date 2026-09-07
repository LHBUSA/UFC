import Link from "next/link";
import type { Event, PortraitSet } from "@/lib/db";
import type { DeskBrief, DeskSide } from "@/lib/pregame";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { fmtDate, fmtRecord, locationLine, weightClassLabel } from "@/lib/format";
import { Avatar } from "@/components/ui";
import type { Framing } from "@/lib/variants";
import { DeskArt, Tale } from "@/components/DeskArt";
import { FightWeekTeaser, PregameIntelligence } from "@/components/FightWeek";
import styles from "./PregameDesk.module.css";

/* Pregame Desk — fight-week intelligence.
 * The homepage marquee is intentionally a scan-first broadcast panel. Deep
 * prose and the full evidence packet live on the matchup page. Nothing below
 * invents a missing fact: unpublished values stay explicit. */

function Para({ lines }: { lines: string[] }) {
  return <>{lines.map((l) => <p key={l}>{l}</p>)}</>;
}

function Signal({ label, line }: { label: string; line?: string }) {
  if (!line) return null;
  return (
    <div className={styles.signal}>
      <span>{label}</span>
      <p>{line}</p>
    </div>
  );
}

function WinPath({ side }: { side: DeskSide }) {
  const last = side.fighter.name.split(" ").slice(-1)[0];
  return (
    <div className={styles.winPath}>
      <div className={styles.winPathHead}>
        <div><span>Win path</span><strong>{side.fighter.name}</strong></div>
        <b>{fmtRecord(side.fighter)}</b>
      </div>
      <ul>{side.keys.slice(0, 2).map((k) => <li key={k}>{k}</li>)}</ul>
      <span className={styles.pathLabel}>How {last} gets there</span>
    </div>
  );
}

function Marquee({ brief, event, imgs, framing }: { brief: DeskBrief; event: Event; imgs?: Map<string, PortraitSet>; framing?: Map<string, Framing> }) {
  const { bout, a, b } = brief;
  const coverage = brief.coverage.startsWith("Full") ? "Full archive coverage" : "Limited archive coverage";
  const signals = [
    { label: "Fight read", line: brief.mainTake[1] || brief.mainTake[0] },
    { label: "Style collision", line: brief.styleClash[0] },
    { label: "Opening round", line: brief.earlyRead[0] },
    { label: "If it goes long", line: brief.ifItGoesLong[0] || brief.resultChanges[0] },
  ].filter((x) => x.line);

  return (
    <article className={styles.marquee}>
      <div className={styles.top}>
        <div>
          <div className={styles.kicker}>Fight-week intelligence · verified packet</div>
          <div className={styles.eventName}>{event.name}</div>
        </div>
        <div className={styles.stakes}>{brief.stakes.slice(0, 3).map((s) => <span key={s}>{s}</span>)}</div>
      </div>

      <DeskArt brief={brief} event={event} imgs={imgs} framing={framing} />
      <Tale brief={brief} event={event} />

      <div className={styles.signalGrid}>
        {signals.map((s) => <Signal key={s.label} label={s.label} line={s.line} />)}
      </div>

      <div className={styles.winGrid}>
        <WinPath side={a} />
        <WinPath side={b} />
      </div>

      <div className={styles.foot}>
        <div className={styles.coverage}><span className={styles.coverageDot} />{coverage}<small> · records + UFC Stats + archive + rankings + Fight DNA</small></div>
        <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} className="btn gold">Full matchup intelligence →</Link>
      </div>
    </article>
  );
}

function Supporting({ brief, event, imgs }: { brief: DeskBrief; event: Event; imgs?: Map<string, PortraitSet> }) {
  const { bout, a, b } = brief;
  const watch = brief.tier === "watch";
  return (
    <article className={`desk-support${watch ? " watch" : ""}`}>
      <div className="desk-support-head">
        <div className="desk-support-faces"><Avatar f={bout.fighter_a} img={imgs?.get(bout.fighter_a.id)} size={44} /><Avatar f={bout.fighter_b} img={imgs?.get(bout.fighter_b.id)} size={44} /></div>
        <div>
          <div className="desk-kicker"><span>{weightClassLabel(bout.weight_class, bout.is_womens)}{bout.is_title ? " · title" : ""}</span></div>
          <h4><Link href={`/fighters/${fighterSlug(bout.fighter_a)}`}>{bout.fighter_a.name}</Link> <i>vs</i> <Link href={`/fighters/${fighterSlug(bout.fighter_b)}`}>{bout.fighter_b.name}</Link></h4>
          <div className="desk-records">{fmtRecord(bout.fighter_a)}{a.rank ? ` (${a.rank})` : " (unranked)"} · {fmtRecord(bout.fighter_b)}{b.rank ? ` (${b.rank})` : " (unranked)"}</div>
        </div>
      </div>
      {watch ? (
        <><div className="desk-section"><div className="desk-h">What to watch</div><Para lines={[...brief.mainTake.slice(0, 1), ...brief.earlyRead.slice(0, 1)]} /></div><p className="desk-limited">{brief.coverage}</p></>
      ) : (
        <><div className="desk-section"><div className="desk-h">Main take</div><Para lines={brief.mainTake.slice(1, 2)} /></div>{brief.styleClash.length > 0 && <div className="desk-section"><div className="desk-h">Style clash</div><Para lines={brief.styleClash.slice(0, 1)} /></div>}<div className="desk-section desk-mini-keys"><div className="desk-h">Keys</div><ul><li><b>{a.fighter.name.split(" ").slice(-1)[0]}:</b> {a.keys[0]}</li><li><b>{b.fighter.name.split(" ").slice(-1)[0]}:</b> {b.keys[0]}</li></ul></div></>
      )}
      {brief.stakes.length > 0 && <div className="desk-stakes">{brief.stakes.map((s) => <em key={s}>{s}</em>)}</div>}
      <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} className="pregame-link">Matchup intelligence →</Link>
    </article>
  );
}

export type PregameDeskMode = "full" | "teaser" | "cta";

/* `mode`:
 *   full    the complete desk (marquee + supporting briefs) — used by /qa/preview and available to any surface
 *   teaser  homepage FIGHT WEEK teaser: faces, one Fight Read, up to three facts, "Open Pregame Desk →"
 *   cta     event-page PREGAME INTELLIGENCE module linking to /pregame/[slug] (no duplicated analysis) */
export function PregameDesk({ event, briefs, imgs, framing, compact = false, mode = "full", meta }: { event: Event; briefs: DeskBrief[]; imgs?: Map<string, PortraitSet>; framing?: Map<string, Framing>; compact?: boolean; mode?: PregameDeskMode; meta?: { fights?: number; updated?: string | null; href?: string; done?: boolean; hub?: boolean } }) {
  if (mode === "cta") return <PregameIntelligence event={event} brief={briefs[0] || null} fights={meta?.fights ?? briefs.length} updated={meta?.updated ?? null} href={meta?.href || `/pregame/${eventSlug(event)}`} done={meta?.done} hub={meta?.hub} />;
  if (!briefs.length) return null;
  if (mode === "teaser") return <FightWeekTeaser event={event} brief={briefs[0]} imgs={imgs} framing={framing} fights={meta?.fights ?? briefs.length} updated={meta?.updated ?? null} />;
  const [lead, ...rest] = briefs;
  return (
    <section className="pregame-desk" aria-labelledby="pregame-title">
      <div className="pregame-head">
        <div>
          <div className="eyebrow">Pregame Desk · Fight-week intelligence</div>
          <h2 id="pregame-title">{event.name}</h2>
          <p>{fmtDate(event.event_date, { weekday: "long", month: "long", day: "numeric" })}{locationLine(event) ? ` · ${locationLine(event)}` : ""}. A fast read from records, UFC Stats, archived results, rankings and Fight DNA. Missing facts stay unpublished instead of being guessed.</p>
        </div>
        <Link href={`/events/${eventSlug(event)}`} className="btn">Full card →</Link>
      </div>
      {lead.tier === "watch" ? <div className="desk-support-grid"><Supporting brief={lead} event={event} imgs={imgs} /></div> : <Marquee brief={lead} event={event} imgs={imgs} framing={framing} />}
      {rest.length > 0 && !compact && <div className="desk-support-grid">{rest.map((x) => <Supporting key={x.bout.id} brief={x} event={event} imgs={imgs} />)}</div>}
      <p className="pregame-note">Pregame Desk is evidence-led commentary, not a pick generator. Odds, model output, injuries, camps and referee assignments appear only when a verified source exists.</p>
    </section>
  );
}
