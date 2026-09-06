import Link from "next/link";
import type { Bout, Event, Fighter, Article } from "@/lib/db";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { cardPositionLabel, daysUntil, fmtDate, fmtHeight, fmtRecord, fmtTime, METHOD_LABEL, weightClassLabel, age, stanceLabel } from "@/lib/format";
import { fighterImageUrl, fighterInitials } from "@/lib/media";
import { SITE } from "@/lib/site";

export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

export function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty" role="status">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function SectionHead({ title, eyebrow, href, cta }: { title: string; eyebrow?: string; href?: string; cta?: string }) {
  return (
    <div className="sec-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
      </div>
      {href && <Link href={href}>{cta || "View all"} →</Link>}
    </div>
  );
}

export function FighterPortrait({ fighter, width = 720, priority = false }: { fighter: Fighter; width?: number; priority?: boolean }) {
  const src = fighterImageUrl(fighter, width);
  return (
    <div className="fighter-portrait" aria-label={`${fighter.name} portrait`}>
      {src ? (
        <img src={src} alt={fighter.name} loading={priority ? "eager" : "lazy"} decoding="async" />
      ) : (
        <>
          <div className="fighter-initials" aria-hidden="true">{fighterInitials(fighter.name)}</div>
          <div className="fighter-watermark" aria-hidden="true">PBE</div>
        </>
      )}
    </div>
  );
}

export function FightPoster({ e, bouts }: { e: Event; bouts: Bout[] }) {
  const headliner = bouts[0] || null;
  if (!headliner) {
    return (
      <div className="fight-poster">
        <div className="poster-top"><span className="eyebrow">Next card</span><span className="tag gold">Live schedule</span></div>
        <div className="poster-empty">
          <div><strong>{e.name}</strong><span>{fmtDate(e.event_date, { weekday: "long", month: "long", day: "numeric" })}</span></div>
        </div>
      </div>
    );
  }
  return (
    <div className="fight-poster">
      <div className="poster-fighters" aria-hidden="true">
        <div className="poster-fighter"><FighterPortrait fighter={headliner.fighter_a} width={900} priority /></div>
        <div className="poster-fighter"><FighterPortrait fighter={headliner.fighter_b} width={900} priority /></div>
      </div>
      <div className="poster-top">
        <span className="eyebrow">{e.is_ppv ? "Pay-per-view" : "Next card"}</span>
        <span className="tag gold">{headliner.is_title ? "Title bout" : cardPositionLabel(headliner.card_position)}</span>
      </div>
      <div className="poster-vs" aria-hidden="true">VS</div>
      <div className="poster-bottom">
        <div>
          <div className="poster-name">{headliner.fighter_a.name}</div>
          <div className="poster-record">{fmtRecord(headliner.fighter_a)}</div>
        </div>
        <div className="poster-meta">
          <strong>{weightClassLabel(headliner.weight_class, headliner.is_womens)}</strong>
          <span>{fmtDate(e.event_date, { month: "short", day: "numeric" })} · {bouts.length} bouts</span>
        </div>
        <div>
          <div className="poster-name right">{headliner.fighter_b.name}</div>
          <div className="poster-record right">{fmtRecord(headliner.fighter_b)}</div>
        </div>
      </div>
    </div>
  );
}

export function EventCard({ e, bouts }: { e: Event; bouts?: number }) {
  const d = daysUntil(e.event_date);
  return (
    <Link href={`/events/${eventSlug(e)}`} className="card hi">
      <div className="eyebrow">{d == null ? "Date TBA" : d > 0 ? `In ${d} day${d === 1 ? "" : "s"}` : d === 0 ? "Fight night" : "Final"}</div>
      <h3 style={{ margin: "8px 0", fontSize: 20, fontFamily: "var(--pbe-font-display)" }}>{e.name}</h3>
      <div className="mono dim" style={{ fontSize: "var(--fs-sm)" }}>{fmtDate(e.event_date)}</div>
      <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>
        {[e.venue, e.city, e.region || e.country].filter(Boolean).join(" · ") || "Venue TBA"}
      </div>
      {bouts != null && <div className="mono faint" style={{ fontSize: "var(--fs-label)", marginTop: 10 }}>{bouts} BOUTS · {e.card_status.toUpperCase()}</div>}
    </Link>
  );
}

export function BoutRow({ b, e, isMain }: { b: Bout; e: Event; isMain?: boolean }) {
  const r = b.result;
  const wA = r?.winner_id === b.fighter_a.id;
  const wB = r?.winner_id === b.fighter_b.id;
  return (
    <Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`} className={`bout${isMain ? " main" : ""}`}>
      <div className="f a">
        <div className={`n${wA ? " w" : ""}`}>{b.fighter_a.name}</div>
        <div className="r">{fmtRecord(b.fighter_a)}</div>
      </div>
      <div className="mid">
        <div className="wc">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title" : ""}{b.scheduled_rounds ? ` · ${b.scheduled_rounds}R` : ""}</div>
        {r ? (
          <div className="res">{METHOD_LABEL[r.method] || r.method}{r.round ? ` · R${r.round}` : ""}{r.time_sec != null ? ` ${fmtTime(r.time_sec)}` : ""}</div>
        ) : (
          <div className="vs">vs</div>
        )}
        {b.status === "cancelled" && <div className="tag live">Cancelled</div>}
      </div>
      <div className="f b">
        <div className={`n${wB ? " w" : ""}`}>{b.fighter_b.name}</div>
        <div className="r">{fmtRecord(b.fighter_b)}</div>
      </div>
    </Link>
  );
}

export function CardSegments({ bouts, e }: { bouts: Bout[]; e: Event }) {
  const order = ["main", "prelim", "early", null] as const;
  const groups = order.map((p) => ({ p, rows: bouts.filter((b) => (b.card_position || null) === p) })).filter((g) => g.rows.length);
  const mainId = bouts[0]?.id;
  return (
    <div>
      {groups.map((g) => (
        <section className="segment" key={String(g.p)}>
          <h3>{g.p ? cardPositionLabel(g.p) : "Announced bouts"}</h3>
          <div className="bouts">
            {g.rows.map((b) => <BoutRow key={b.id} b={b} e={e} isMain={b.id === mainId} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

export function TaleOfTheTape({ a, b }: { a: Fighter; b: Fighter }) {
  const rows: Array<[string, string, string]> = [
    [fmtRecord(a), "Record", fmtRecord(b)],
    [age(a.dob)?.toString() || "—", "Age", age(b.dob)?.toString() || "—"],
    [fmtHeight(a.height_in), "Height", fmtHeight(b.height_in)],
    [a.reach_in != null ? `${a.reach_in}"` : "—", "Reach", b.reach_in != null ? `${b.reach_in}"` : "—"],
    [stanceLabel(a.stance), "Stance", stanceLabel(b.stance)],
  ];
  return (
    <div className="tape-rows">
      {rows.map(([l, k, r]) => (
        <div key={k}><span>{l}</span><span>{k}</span><span>{r}</span></div>
      ))}
    </div>
  );
}

export function MatchupCard({ b, e }: { b: Bout; e: Event }) {
  return (
    <div className="matchup visual">
      <div className="top">
        <span className="eyebrow">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title bout" : ""}</span>
        <span className="tag">{cardPositionLabel(b.card_position)}</span>
      </div>
      <div className="matchup-visuals">
        <Link href={`/fighters/${fighterSlug(b.fighter_a)}`} className="matchup-fighter">
          <FighterPortrait fighter={b.fighter_a} width={620} />
          <div className="matchup-nameplate">
            <div className="name">{b.fighter_a.name}</div>
            {b.fighter_a.nickname && <div className="nick">“{b.fighter_a.nickname}”</div>}
            <div className="rec">{fmtRecord(b.fighter_a)}</div>
          </div>
        </Link>
        <Link href={`/fighters/${fighterSlug(b.fighter_b)}`} className="matchup-fighter">
          <FighterPortrait fighter={b.fighter_b} width={620} />
          <div className="matchup-nameplate">
            <div className="name">{b.fighter_b.name}</div>
            {b.fighter_b.nickname && <div className="nick">“{b.fighter_b.nickname}”</div>}
            <div className="rec">{fmtRecord(b.fighter_b)}</div>
          </div>
        </Link>
      </div>
      <TaleOfTheTape a={b.fighter_a} b={b.fighter_b} />
      <ProLock />
      <div className="matchup-link">
        <Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`} style={{ color: "var(--pbe-gold)", fontWeight: 600, fontSize: "var(--fs-sm)" }}>Full matchup →</Link>
      </div>
    </div>
  );
}

/* The funnel slot from the brief: renders as a locked placeholder until the
 * model exists. It never shows a number that was not produced by the model. */
export function ProLock() {
  return (
    <div className="lock">
      <div>
        <div className="eyebrow">Algo lean · locked</div>
        <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Model pricing arrives with UFC Pro. No pick is shown until the model has produced one.</div>
      </div>
      <div className="blur" aria-hidden="true">+0.0%</div>
    </div>
  );
}

export function FighterCard({ f }: { f: Fighter }) {
  return (
    <Link href={`/fighters/${fighterSlug(f)}`} className="fcard visual">
      <FighterPortrait fighter={f} width={620} />
      <div className="fcard-copy">
        <div className="n">{f.name}</div>
        {f.nickname ? <div className="nickname">“{f.nickname}”</div> : null}
        <div className="m">{fmtRecord(f)} · {fmtHeight(f.height_in)} · {f.reach_in != null ? `${f.reach_in}" reach` : "reach —"}</div>
      </div>
    </Link>
  );
}

export function StoryCard({ a }: { a: Article }) {
  return (
    <Link href={`/news/${a.slug}`} className="story">
      <span className="eyebrow">{a.story_type.replace("_", " ")}</span>
      <h3>{a.headline}</h3>
      {a.dek && <p>{a.dek}</p>}
      <span className="mono faint" style={{ fontSize: "var(--fs-label)" }}>{a.published_at ? fmtDate(a.published_at.slice(0, 10)) : ""}</span>
    </Link>
  );
}

export function ProPlans() {
  return (
    <div className="plans">
      <div className="plan">
        <div className="eyebrow dim">Free</div>
        <div className="price">$0</div>
        <ul>
          <li>Every upcoming card, main card and prelims</li>
          <li>Fighter pages with records and physicals</li>
          <li>Event pages and results with round-level stats</li>
          <li>A-vs-B matchup pages with tale of the tape</li>
          <li>Rankings and news</li>
        </ul>
        <Link href="/events" className="btn">Browse the cards</Link>
      </div>
      <div className="plan pro">
        <div className="eyebrow">UFC Pro</div>
        <div className="price">{SITE.pricing.monthly} <small>or {SITE.pricing.cardPass} pass</small></div>
        <ul>
          <li className="locked">Model picks and edges: winner, method, rounds, distance</li>
          <li className="locked">Card-change and injury alerts the moment a bout moves</li>
          <li className="locked">Judge and referee intelligence</li>
          <li className="locked">Friday weigh-in report with weight-miss history</li>
          <li className="locked">Verified track record graded on CLV and calibration</li>
        </ul>
        <Link href="/pro" className="btn gold">See what ships with Pro</Link>
      </div>
    </div>
  );
}
