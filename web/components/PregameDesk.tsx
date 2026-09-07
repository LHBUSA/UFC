import Link from "next/link";
import type { Bout, Event, PortraitSet } from "@/lib/db";
import type { DeskBrief, DeskSide } from "@/lib/pregame";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { fmtDate, fmtRecord, locationLine, weightClassLabel } from "@/lib/format";
import { Avatar } from "@/components/ui";
import { Mark } from "@/components/Brand";
import { pickVariant, type Framing } from "@/lib/variants";
import styles from "./PregameDesk.module.css";

/* Pregame Desk — fight-week intelligence. Every analysis line comes from
 * lib/pregame.ts, which only writes what the stored packet supports. This
 * component edits for hierarchy; it never fills a missing fact with inference. */

function Para({ lines }: { lines: string[] }) {
  return <>{lines.map((l) => <p key={l}>{l}</p>)}</>;
}

type Portraits = Map<string, PortraitSet>;

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
        <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", padding: 24 }}><Avatar f={fighter} img={img || undefined} size={130} /></div>
      )}
      <div className={styles.fighterInfo}>
        <strong><Link href={`/fighters/${fighterSlug(fighter)}`}>{fighter.name}</Link></strong>
        <div className={styles.fighterMeta}><span>{fmtRecord(fighter)}</span><span className={styles.rank}>{rank || "Unranked"}</span></div>
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
        <div className={styles.fallback} style={{ gridColumn: "1 / -1" }}>
          <Mark size={64} />
          <div className={styles.center} style={{ background: "transparent" }}>
            <h3>{bout.fighter_a.name}<i>vs</i>{bout.fighter_b.name}</h3>
            <div className={styles.eventline}>{event.name}</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.faceoff}>
      <FighterPanel side="a" fighter={bout.fighter_a} rank={a.rank} img={ia} framing={fa} />
      <div className={styles.center}>
        <div className={styles.kicker}>{bout.is_title ? "Title fight" : "Main event"} · {weightClassLabel(bout.weight_class, bout.is_womens)} · {bout.scheduled_rounds || 3} rounds</div>
        <h3>{bout.fighter_a.name}<i>vs</i>{bout.fighter_b.name}</h3>
        <div className={styles.eventline}>{event.name} · {fmtDate(event.event_date, { month: "short", day: "numeric" })}{locationLine(event) ? ` · ${locationLine(event)}` : ""}</div>
      </div>
      <FighterPanel side="b" fighter={bout.fighter_b} rank={b.rank} img={ib} framing={fb} />
      {(ia?.attribution_text || ib?.attribution_text) && <div className={styles.credit}>Portraits: {[ia?.attribution_text, ib?.attribution_text].filter(Boolean).join(" · ")}</div>}
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

function Insight({ label, lines }: { label: string; lines: string[] }) {
  if (!lines.length) return null;
  return <div className={styles.insight}><div className={styles.label}>{label}</div><Para lines={lines} /></div>;
}

function SideKeys({ s }: { s: DeskSide }) {
  const last = s.fighter.name.split(" ").slice(-1)[0];
  return (
    <div className={styles.keyCard}>
      <div className={styles.keyHead}><strong>{s.fighter.name}</strong><span>{fmtRecord(s.fighter)} · {s.rank || "Unranked"}</span></div>
      <div className={styles.label} style={{ marginTop: 12 }}>How {last} wins</div>
      <ul>{s.keys.slice(0, 3).map((k) => <li key={k}>{k}</li>)}</ul>
    </div>
  );
}

function Marquee({ brief, event, imgs, framing }: { brief: DeskBrief; event: Event; imgs?: Map<string, PortraitSet>; framing?: Map<string, Framing> }) {
  const { bout, a, b } = brief;
  return (
    <article className={styles.marquee}>
      <div className={styles.top}>
        <div className={styles.kicker}>{bout.is_title ? "Championship" : "Featured matchup"} · verified fight-week packet</div>
        <div className={styles.stakes}>{brief.stakes.map((s) => <span key={s}>{s}</span>)}</div>
      </div>
      <DeskArt brief={brief} event={event} imgs={imgs} framing={framing} />
      <Tale brief={brief} event={event} />
      <div className={styles.insights}>
        <Insight label="Main take" lines={brief.mainTake.slice(0, 2)} />
        <Insight label="Style clash" lines={brief.styleClash.slice(0, 2)} />
        <Insight label="Early read" lines={brief.earlyRead.slice(0, 2)} />
      </div>
      <div className={styles.keys}><SideKeys s={a} /><SideKeys s={b} /></div>
      <div className={styles.bottom}>
        {brief.ifItGoesLong.length > 0 && <div className={styles.bottomCard}><div className={styles.label}>If it goes long</div><Para lines={brief.ifItGoesLong.slice(0, 2)} /></div>}
        <div className={styles.bottomCard}><div className={styles.label}>What the result changes</div><Para lines={brief.resultChanges.slice(0, 2)} /></div>
      </div>
      <div className={styles.foot}>
        <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} className="btn gold">Open the full matchup →</Link>
        <details className={styles.evidence}><summary>Evidence packet · {brief.coverage.startsWith("Full") ? "full" : "limited"}</summary><ul>{brief.evidence.map((e) => <li key={e}>{e}</li>)}</ul><p>{brief.coverage}</p></details>
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
          <p>{fmtDate(event.event_date, { weekday: "long", month: "long", day: "numeric" })}{locationLine(event) ? ` · ${locationLine(event)}` : ""}. Evidence-led reads from fighter records, UFC Stats career rates, archived results, the dated rankings snapshot and Fight DNA. Missing facts remain explicitly unpublished rather than inferred.</p>
        </div>
        <Link href={`/events/${eventSlug(event)}`} className="btn">Full card →</Link>
      </div>
      {lead.tier === "watch" ? <div className="desk-support-grid"><Supporting brief={lead} event={event} imgs={imgs} /></div> : <Marquee brief={lead} event={event} imgs={imgs} framing={framing} />}
      {rest.length > 0 && !compact && <div className="desk-support-grid">{rest.map((x) => <Supporting key={x.bout.id} brief={x} event={event} imgs={imgs} />)}</div>}
      <p className="pregame-note">Pregame Desk is evidence-led commentary, not a pick generator. Every number is traceable to a stored packet; odds, model output, injuries, camps and referee assignments appear only when a verified source exists.</p>
    </section>
  );
}
