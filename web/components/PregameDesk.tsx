import Link from "next/link";
import type { Bout, Event, PortraitSet } from "@/lib/db";
import type { DeskBrief, DeskSide } from "@/lib/pregame";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { fmtDate, fmtRecord, locationLine, weightClassLabel } from "@/lib/format";
import { Avatar } from "@/components/ui";
import { Mark } from "@/components/Brand";
import { pickVariant, type Framing } from "@/lib/variants";
import styles from "./PregameDesk.module.css";

/* Pregame Desk — fight-week intelligence.
 * The homepage marquee is intentionally a scan-first broadcast panel. Deep
 * prose and the full evidence packet live on the matchup page. Nothing below
 * invents a missing fact: unpublished values stay explicit. */

type Portraits = Map<string, PortraitSet>;

function Para({ lines }: { lines: string[] }) {
  return <>{lines.map((l) => <p key={l}>{l}</p>)}</>;
}

function ageAt(dob: string | null, eventDate: string | null): number | null {
  if (!dob || !eventDate) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  const at = new Date(`${eventDate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(at.getTime())) return null;
  let age = at.getUTCFullYear() - birth.getUTCFullYear();
  if (at.getUTCMonth() < birth.getUTCMonth() || (at.getUTCMonth() === birth.getUTCMonth() && at.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

function height(v: number | null): string {
  if (v == null) return "Not published";
  const n = Number(v);
  return `${Math.floor(n / 12)}′${Math.round(n % 12)}″`;
}

function inches(v: number | null): string {
  return v == null ? "Not published" : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}″`;
}

function stance(v: string | null): string {
  if (!v) return "Not published";
  return v.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function FighterPanel({ side, fighter, rank, img, framing }: { side: "a" | "b"; fighter: Bout["fighter_a"]; rank: string | null; img?: PortraitSet | null; framing?: Framing | null }) {
  const variant = pickVariant(img, "desk", framing);
  const staged = !variant || variant.mode !== "cover" || variant.confidence === "low";
  return (
    <div className={`${styles.fighterPanel} ${styles[side]}${staged ? ` ${styles.staged}` : ""}`}>
      {variant ? (
        <img src={variant.src} alt={fighter.name} width={variant.width} height={variant.height} loading="lazy" decoding="async" style={{ objectPosition: variant.objectPosition }} />
      ) : (
        <div className={styles.fighterFallback}><Avatar f={fighter} img={img || undefined} size={126} /></div>
      )}
      <div className={styles.fighterShade} aria-hidden="true" />
      <div className={styles.fighterInfo}>
        <strong><Link href={`/fighters/${fighterSlug(fighter)}`}>{fighter.name}</Link></strong>
        {fighter.nickname && <span className={styles.nickname}>“{fighter.nickname}”</span>}
        <div className={styles.fighterMeta}>
          <b>{fmtRecord(fighter)}</b>
          <span className={rank ? styles.rank : styles.unranked}>{rank || "Unranked"}</span>
        </div>
      </div>
    </div>
  );
}

function DeskArt({ brief, event, imgs, framing }: { brief: DeskBrief; event: Event; imgs?: Portraits; framing?: Map<string, Framing> }) {
  const { bout, a, b } = brief;
  const ia = imgs?.get(bout.fighter_a.id) || null;
  const ib = imgs?.get(bout.fighter_b.id) || null;
  const fa = ia ? framing?.get(ia.id) || null : null;
  const fb = ib ? framing?.get(ib.id) || null : null;
  if (!ia && !ib) {
    return (
      <div className={styles.faceoff}>
        <FighterPanel side="a" fighter={bout.fighter_a} rank={a.rank} img={null} framing={null} />
        <FightCenter bout={bout} event={event} />
        <FighterPanel side="b" fighter={bout.fighter_b} rank={b.rank} img={null} framing={null} />
      </div>
    );
  }
  return (
    <div className={styles.faceoff}>
      <FighterPanel side="a" fighter={bout.fighter_a} rank={a.rank} img={ia} framing={fa} />
      <FightCenter bout={bout} event={event} />
      <FighterPanel side="b" fighter={bout.fighter_b} rank={b.rank} img={ib} framing={fb} />
      {(ia?.attribution_text || ib?.attribution_text) && <div className={styles.credit}>Portraits: {[ia?.attribution_text, ib?.attribution_text].filter(Boolean).join(" · ")}</div>}
    </div>
  );
}

function FightCenter({ bout, event }: { bout: Bout; event: Event }) {
  return (
    <div className={styles.center}>
      <Mark size={24} />
      <span className={styles.centerKicker}>{bout.is_title ? "Title fight" : "Main event"}</span>
      <b className={styles.vs}>VS</b>
      <span className={styles.division}>{weightClassLabel(bout.weight_class, bout.is_womens)}</span>
      <span className={styles.centerMeta}>{bout.scheduled_rounds || 3} rounds</span>
      <span className={styles.centerMeta}>{fmtDate(event.event_date, { month: "short", day: "numeric" })}</span>
    </div>
  );
}

function Tale({ brief, event }: { brief: DeskBrief; event: Event }) {
  const { a, b } = brief;
  const cells = [
    [String(ageAt(a.fighter.dob, event.event_date) ?? "Not published"), "Age", String(ageAt(b.fighter.dob, event.event_date) ?? "Not published")],
    [height(a.fighter.height_in), "Height", height(b.fighter.height_in)],
    [inches(a.fighter.reach_in), "Reach", inches(b.fighter.reach_in)],
    [stance(a.fighter.stance), "Stance", stance(b.fighter.stance)],
    [a.rank || "Unranked", "Ranking", b.rank || "Unranked"],
  ];
  return <div className={styles.tale}>{cells.map(([left, label, right]) => <div className={styles.taleCell} key={label}><b>{left}</b><span>{label}</span><b>{right}</b></div>)}</div>;
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
    { label: "The edge", line: brief.mainTake[0] },
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

export function PregameDesk({ event, briefs, imgs, framing, compact = false }: { event: Event; briefs: DeskBrief[]; imgs?: Map<string, PortraitSet>; framing?: Map<string, Framing>; compact?: boolean }) {
  if (!briefs.length) return null;
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
