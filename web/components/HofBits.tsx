import Link from "next/link";
import type { Fighter, PortraitSet } from "@/lib/db";
import { hofPacket, portrait, val, type Claim, type FightWingEntry } from "@/lib/enrichment";
import { initialsOf } from "@/lib/hof";
import { fighterSlug } from "@/lib/slug";
import { fmtDate, METHOD_LABEL, fmtTime } from "@/lib/format";

/* Hall of Fame media + Fight Wing pieces.
 *
 * Portrait precedence: the enrichment packet (licensed Commons portrait,
 * first-party hosted derivative, full attribution) → a fighter-archive
 * portrait when the inductee resolved to a canonical fighter row → the
 * monogram plate. The monogram means approved sources were searched and
 * nothing usable was found; the packet lists the rejections. */
export function hofImage(slug: string, slot: "avatar" | "card" | "profile", archive?: { img: PortraitSet | null } | null) {
  const p = portrait(hofPacket(slug), slot);
  if (p) return p;
  const a = archive?.img;
  if (a) return { src: slot === "avatar" ? a.thumb : a.card, alt: "", attribution: a.attribution_text || [a.author, a.license].filter(Boolean).join(" · ") || "Rights-cleared image", sourcePage: a.source_url || "", license: a.license || "", status: "approved" as const };
  return null;
}

export function HofFace({ slug, name, slot = "avatar", archive, large = false }: { slug: string; name: string; slot?: "avatar" | "card" | "profile"; archive?: { img: PortraitSet | null } | null; large?: boolean }) {
  const img = hofImage(slug, slot, archive);
  return (
    <span className={`hof-face${large ? " lg" : ""}`}>
      {img ? <img src={img.src} alt={name} width={400} height={500} loading="lazy" decoding="async" /> : <b aria-hidden="true">{initialsOf(name)}</b>}
    </span>
  );
}

/* Packet claim reader for the profile page. */
export function hofFact(slug: string, key: string): string | number | string[] | null {
  const p = hofPacket(slug);
  return val(p?.facts?.[key] as Claim<unknown> | null) as string | number | string[] | null;
}

/* ---- Fight Wing --------------------------------------------------------
 * An induction here honours a bout, not a person. Both fighters link to their
 * archive pages when they resolve; the result is shown only when our own bout
 * archive holds it, otherwise the packet's honest note is displayed. */
export function FightWingCard({ f, fighters }: { f: FightWingEntry; fighters: Map<string, Fighter> }) {
  const res = f.result;
  return (
    <article className="hof-fw" id={f.slug}>
      <div className="hof-fw-head">
        <span className="hof-kicker">Fight Wing{f.meeting ? ` · meeting ${f.meeting}` : ""}</span>
        <h3>{f.fighters.map((x, i) => {
          const fr = x.fighter_id ? fighters.get(x.fighter_id) : null;
          return (
            <span key={x.name || i}>
              {i > 0 && <i>vs</i>}
              {fr ? <Link href={`/fighters/${fighterSlug(fr)}`}>{x.name}</Link> : <span>{x.name}</span>}
            </span>
          );
        })}</h3>
        <div className="hof-fw-meta">{f.event.name} · {f.event.year}{f.event.event_date ? ` · ${fmtDate(f.event.event_date, { month: "short", day: "numeric", year: "numeric" })}` : ""}</div>
      </div>
      {res ? (
        <div className="hof-fw-result">
          <span className="lab">Result</span>
          <b>{res.winner ? `${res.winner} won` : METHOD_LABEL[res.method] || res.method_raw}</b>
          <span>{METHOD_LABEL[res.method] || res.method_raw}{res.round ? ` · Round ${res.round}` : ""}{res.time_sec != null ? ` · ${fmtTime(res.time_sec)}` : ""}{res.is_title ? " · Title fight" : ""}</span>
          <small>Verified from the PropBetEdge bout archive</small>
        </div>
      ) : (
        <div className="hof-fw-result pending"><span className="lab">Result</span><small>{f.result_note}</small></div>
      )}
      <p className="hof-fw-note">{f.significance.value}</p>
      <div className="hof-fw-foot">
        {f.fighters.some((x) => x.archive_status === "missing") && <small className="faint">Some fighters on this bout are not yet in the loaded archive, so they are shown without a profile link.</small>}
        <a href={f.induction.source} target="_blank" rel="noopener">Official UFC Hall of Fame ↗</a>
      </div>
    </article>
  );
}
