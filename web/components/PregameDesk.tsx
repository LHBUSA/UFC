import Link from "next/link";
import type { Bout, Event, PortraitSet } from "@/lib/db";
import type { DeskBrief, DeskSide } from "@/lib/pregame";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { fmtDate, fmtRecord, locationLine, weightClassLabel } from "@/lib/format";
import { Avatar } from "@/components/ui";
import { OCTAGON, Mark } from "@/components/Brand";
import { pickVariant, composeDesk, type Framing } from "@/lib/variants";

/* Pregame Desk — fight-week intelligence. Every line comes from
 * lib/pregame.ts, which only writes what the stored packet supports. */

function Para({ lines }: { lines: string[] }) {
  return <>{lines.map((l) => <p key={l}>{l}</p>)}</>;
}

type Portraits = Map<string, PortraitSet>;

function Panel({ f, img, framing, side, single }: { f: Bout["fighter_a"]; img?: PortraitSet | null; framing?: Framing | null; side: "a" | "b"; single?: boolean }) {
  const v = pickVariant(img, "desk", framing);
  if (!v || v.mode === "badge") {
    return (
      <div className={`desk-panel ${side} badge`}>
        {v ? <img className="desk-badge-img" src={v.src} alt={f.name} width={v.width} height={v.height} loading="lazy" decoding="async" /> : <div className="desk-badge-img"><Avatar f={f} size={120} /></div>}
        <span className="desk-panel-name">{f.name}</span>
      </div>
    );
  }
  return (
    <div className={`desk-panel ${side}${single ? " single" : ""}${v.mode === "staged" ? " staged" : ""}`} data-confidence={v.confidence}>
      <img src={v.src} alt={f.name} width={v.width} height={v.height} loading="lazy" decoding="async" style={{ objectPosition: v.objectPosition }} />
      <span className="desk-panel-name">{f.name}</span>
    </div>
  );
}

/* Marquee art: two clean portrait panels when both fighters have confident
 * art; a single cinematic hero when only one does; a branded event card when
 * neither does. No masks, no face-destroying overlays. */
function DeskArt({ bout, event, imgs, framing }: { bout: Bout; event: Event; imgs?: Portraits; framing?: Map<string, Framing> }) {
  const ia = imgs?.get(bout.fighter_a.id) || null, ib = imgs?.get(bout.fighter_b.id) || null;
  const fa = ia ? framing?.get(ia.id) || null : null, fb = ib ? framing?.get(ib.id) || null : null;
  const mode = composeDesk(pickVariant(ia, "desk", fa), pickVariant(ib, "desk", fb));
  if (mode === "fallback") {
    return (
      <div className="desk-art fallback">
        <svg className="desk-art-cage" viewBox="0 0 64 64" aria-hidden="true"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <Mark size={54} />
        <div className="desk-art-names"><b>{bout.fighter_a.name}</b><i>vs</i><b>{bout.fighter_b.name}</b></div>
        <span className="desk-art-event">{event.name}</span>
      </div>
    );
  }
  if (mode !== "duo") {
    const hero = mode === "single-a" ? bout.fighter_a : bout.fighter_b, other = mode === "single-a" ? bout.fighter_b : bout.fighter_a;
    return (
      <div className="desk-art single">
        <Panel f={hero} img={imgs?.get(hero.id)} framing={framing?.get(imgs?.get(hero.id)?.id || "")} side={mode === "single-a" ? "a" : "b"} single />
        <div className="desk-art-other"><Avatar f={other} img={imgs?.get(other.id)} size={56} /><span>vs <b>{other.name}</b></span></div>
      </div>
    );
  }
  return (
    <div className="desk-art duo">
      <Panel f={bout.fighter_a} img={ia} framing={fa} side="a" />
      <div className="desk-vs">VS</div>
      <Panel f={bout.fighter_b} img={ib} framing={fb} side="b" />
    </div>
  );
}

function SideKeys({ s, first }: { s: DeskSide; first: boolean }) {
  return (
    <div className={`desk-keys-side ${first ? "a" : "b"}`}>
      <div className="desk-keys-name"><Link href={`/fighters/${fighterSlug(s.fighter)}`}>{s.fighter.name}</Link><span>{fmtRecord(s.fighter)}{s.rank ? ` · ${s.rank}` : ""}</span></div>
      <div className="desk-keys-label">How {s.fighter.name.split(" ").slice(-1)[0]} wins</div>
      <ul>{s.keys.map((k) => <li key={k}>{k}</li>)}</ul>
      {s.profile.length > 0 && <div className="desk-profile">{s.profile.slice(0, 3).map((p) => <span key={p}>{p}</span>)}</div>}
      {s.form.length > 0 && <div className="desk-form">{s.form.slice(0, 2).map((p) => <span key={p}>{p}</span>)}</div>}
    </div>
  );
}

function Marquee({ brief, event, imgs, framing }: { brief: DeskBrief; event: Event; imgs?: Map<string, PortraitSet>; framing?: Map<string, Framing> }) {
  const { bout, a, b } = brief;
  return (
    <article className="desk-marquee">
      <svg className="desk-cage" viewBox="0 0 64 64" aria-hidden="true"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1" strokeLinejoin="round" /></svg>
      <div className="desk-marquee-faces"><DeskArt bout={bout} event={event} imgs={imgs} framing={framing} /></div>
      <div className="desk-marquee-body">
        <div className="desk-kicker">
          <span>{bout.is_title ? "Title fight" : "Main event"} · {weightClassLabel(bout.weight_class, bout.is_womens)}{bout.scheduled_rounds ? ` · ${bout.scheduled_rounds} rounds` : ""}</span>
          <span className="desk-stakes">{brief.stakes.map((s) => <em key={s}>{s}</em>)}</span>
        </div>
        <h3><Link href={`/fighters/${fighterSlug(bout.fighter_a)}`}>{bout.fighter_a.name}</Link> <i>vs</i> <Link href={`/fighters/${fighterSlug(bout.fighter_b)}`}>{bout.fighter_b.name}</Link></h3>
        <div className="desk-section desk-main-take"><div className="desk-h">Main take</div><Para lines={brief.mainTake} /></div>
        {brief.styleClash.length > 0 && <div className="desk-section"><div className="desk-h">Style clash</div><Para lines={brief.styleClash} /></div>}
        <div className="desk-keys"><div className="desk-h">Keys to victory</div><div className="desk-keys-grid"><SideKeys s={a} first /><SideKeys s={b} first={false} /></div></div>
        <div className="desk-cols">
          <div className="desk-section"><div className="desk-h">Early read</div><Para lines={brief.earlyRead} /></div>
          {brief.ifItGoesLong.length > 0 && <div className="desk-section"><div className="desk-h">If it goes long</div><Para lines={brief.ifItGoesLong} /></div>}
          <div className="desk-section"><div className="desk-h">What the result changes</div><Para lines={brief.resultChanges} /></div>
        </div>
        <div className="desk-foot">
          <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} className="btn gold">Open the full matchup →</Link>
          <details className="desk-evidence"><summary>Evidence packet · {brief.coverage.startsWith("Full") ? "full" : "limited"}</summary><ul>{brief.evidence.map((e) => <li key={e}>{e}</li>)}</ul><p>{brief.coverage}</p></details>
        </div>
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
          <div className="desk-records">{fmtRecord(bout.fighter_a)}{a.rank ? ` (${a.rank})` : ""} · {fmtRecord(bout.fighter_b)}{b.rank ? ` (${b.rank})` : ""}</div>
        </div>
      </div>
      {watch ? (
        <>
          <div className="desk-section"><div className="desk-h">What to watch</div><Para lines={[...brief.mainTake.slice(0, 1), ...brief.earlyRead.slice(0, 1)]} /></div>
          <p className="desk-limited">{brief.coverage}</p>
        </>
      ) : (
        <>
          <div className="desk-section"><div className="desk-h">Main take</div><Para lines={brief.mainTake.slice(1)} /></div>
          {brief.styleClash.length > 0 && <div className="desk-section"><div className="desk-h">Style clash</div><Para lines={brief.styleClash.slice(0, 1)} /></div>}
          <div className="desk-section desk-mini-keys"><div className="desk-h">Keys</div><ul><li><b>{a.fighter.name.split(" ").slice(-1)[0]}:</b> {a.keys[0]}</li><li><b>{b.fighter.name.split(" ").slice(-1)[0]}:</b> {b.keys[0]}</li></ul></div>
          <div className="desk-section"><div className="desk-h">What the result changes</div><Para lines={brief.resultChanges.slice(0, 1)} /></div>
        </>
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
          <p>{fmtDate(event.event_date, { weekday: "long", month: "long", day: "numeric" })}{locationLine(event) ? ` · ${locationLine(event)}` : ""}. Evidence-led reads on the fights that matter this week, built from fighter records, UFC Stats career rates, archived results, the dated rankings snapshot and Fight DNA — nothing about camps, injuries or odds unless a verified source exists.</p>
        </div>
        <Link href={`/events/${eventSlug(event)}`} className="btn">Full card →</Link>
      </div>
      {lead.tier === "watch" ? <div className="desk-support-grid"><Supporting brief={lead} event={event} imgs={imgs} /></div> : <Marquee brief={lead} event={event} imgs={imgs} framing={framing} />}
      {rest.length > 0 && !compact && <div className="desk-support-grid">{rest.map((b) => <Supporting key={b.bout.id} brief={b} event={event} imgs={imgs} />)}</div>}
      <p className="pregame-note">Pregame Desk is evidence-led commentary, not a pick generator. Every number is traceable to a stored packet; odds, model output and injury or camp claims appear only when a verified source exists.</p>
    </section>
  );
}
