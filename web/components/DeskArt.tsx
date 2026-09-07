import Link from "next/link";
import type { Bout, Event, PortraitSet } from "@/lib/db";
import type { DeskBrief } from "@/lib/pregame";
import { fighterSlug } from "@/lib/slug";
import { fmtDate, fmtRecord, weightClassLabel } from "@/lib/format";
import { Avatar } from "@/components/ui";
import { Mark } from "@/components/Brand";
import { pickVariant, type Framing } from "@/lib/variants";
import styles from "./PregameDesk.module.css";

/* Faceoff art + key comparison shared by the Pregame Desk marquee, the Fight
 * Week main-event desk and the homepage FIGHT WEEK teaser. One composition
 * system: stored portrait variants with detector focal points, staged mode
 * for display-only headshots, octagon avatar when nothing rights-cleared
 * exists. Unpublished values stay explicit. */

type Portraits = Map<string, PortraitSet>;

export function ageAt(dob: string | null, eventDate: string | null): number | null {
  if (!dob || !eventDate) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  const at = new Date(`${eventDate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(at.getTime())) return null;
  let age = at.getUTCFullYear() - birth.getUTCFullYear();
  if (at.getUTCMonth() < birth.getUTCMonth() || (at.getUTCMonth() === birth.getUTCMonth() && at.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

export function height(v: number | null): string {
  if (v == null) return "Not published";
  const n = Number(v);
  return `${Math.floor(n / 12)}′${Math.round(n % 12)}″`;
}

export function inches(v: number | null): string {
  return v == null ? "Not published" : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}″`;
}

export function stance(v: string | null): string {
  if (!v) return "Not published";
  return v.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function FighterPanel({ side, fighter, rank, img, framing }: { side: "a" | "b"; fighter: Bout["fighter_a"]; rank: string | null; img?: PortraitSet | null; framing?: Framing | null }) {
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

export function FightCenter({ bout, event, kicker }: { bout: Bout; event: Event; kicker?: string }) {
  return (
    <div className={styles.center}>
      <Mark size={24} />
      <span className={styles.centerKicker}>{kicker || (bout.is_title ? "Title fight" : "Main event")}</span>
      <b className={styles.vs}>VS</b>
      <span className={styles.division}>{weightClassLabel(bout.weight_class, bout.is_womens)}</span>
      <span className={styles.centerMeta}>{bout.scheduled_rounds || 3} rounds</span>
      <span className={styles.centerMeta}>{fmtDate(event.event_date, { month: "short", day: "numeric" })}</span>
    </div>
  );
}

export function DeskArt({ brief, event, imgs, framing, kicker }: { brief: DeskBrief; event: Event; imgs?: Portraits; framing?: Map<string, Framing>; kicker?: string }) {
  const { bout, a, b } = brief;
  const ia = imgs?.get(bout.fighter_a.id) || null;
  const ib = imgs?.get(bout.fighter_b.id) || null;
  const fa = ia ? framing?.get(ia.id) || null : null;
  const fb = ib ? framing?.get(ib.id) || null : null;
  if (!ia && !ib) {
    return (
      <div className={styles.faceoff}>
        <FighterPanel side="a" fighter={bout.fighter_a} rank={a.rank} img={null} framing={null} />
        <FightCenter bout={bout} event={event} kicker={kicker} />
        <FighterPanel side="b" fighter={bout.fighter_b} rank={b.rank} img={null} framing={null} />
      </div>
    );
  }
  return (
    <div className={styles.faceoff}>
      <FighterPanel side="a" fighter={bout.fighter_a} rank={a.rank} img={ia} framing={fa} />
      <FightCenter bout={bout} event={event} kicker={kicker} />
      <FighterPanel side="b" fighter={bout.fighter_b} rank={b.rank} img={ib} framing={fb} />
      {(ia?.attribution_text || ib?.attribution_text) && <div className={styles.credit}>Portraits: {[ia?.attribution_text, ib?.attribution_text].filter(Boolean).join(" · ")}</div>}
    </div>
  );
}

/* Key comparison: Age · Height · Reach · Stance · Ranking, nothing else. */
export function Tale({ brief, event }: { brief: DeskBrief; event: Event }) {
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
