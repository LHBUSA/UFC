import Link from "next/link";
import { MarketInline } from "@/components/Market";
import type { BoutMarket, MarketState } from "@/lib/market";
import { marketStateFor } from "@/lib/market";
import type { Article, Bout, Event, Fighter, PortraitSet } from "@/lib/db";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { cardPositionLabel, daysUntil, eventBrand, eventHeadline, eventStatusLabel, fmtDate, fmtHeight, fmtReach, fmtRecord, fmtTime, initials, locationLine, METHOD_LABEL, METHOD_SHORT, weightClassLabel, age, stanceLabel, cityLine, winnerOf } from "@/lib/format";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";
import { OCTAGON } from "./Brand";

export type Portraits = Map<string, PortraitSet>;

/* ---- structured data --------------------------------------------------- */
export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
export function Breadcrumbs({ items }: { items: Array<{ name: string; href?: string }> }) {
  const all = [{ name: "Home", href: "/" }, ...items];
  return (
    <>
      <ol className="crumbs" aria-label="Breadcrumb">
        {all.map((c, i) => <li key={i}>{c.href && i < all.length - 1 ? <Link href={c.href}>{c.name}</Link> : <span>{c.name}</span>}</li>)}
      </ol>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: all.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.href ? `${SITE.url}${c.href}` : undefined })) }} />
    </>
  );
}

/* ---- primitives -------------------------------------------------------- */
export function Octagon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 64 64" aria-hidden="true"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
}
export function Empty({ title, children, cta }: { title: string; children: React.ReactNode; cta?: { href: string; label: string } }) {
  return (
    <div className="empty" role="status">
      <Octagon className="oc" />
      <h3>{title}</h3>
      <p>{children}</p>
      {cta && <Link href={cta.href} className="btn">{cta.label}</Link>}
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
      {href && <Link href={href} className="more">{cta || "View all"} →</Link>}
    </div>
  );
}
export function PageHead({ eyebrow, title, lede, crumbs, children }: { eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode; crumbs?: Array<{ name: string; href?: string }>; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      {crumbs && <Breadcrumbs items={crumbs} />}
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h1>{title}</h1>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </div>
  );
}

/* ---- fighter imagery --------------------------------------------------- */
export function Avatar({ f, img, size = 46, className = "" }: { f: Pick<Fighter, "name">; img?: PortraitSet | null; size?: number; className?: string }) {
  return (
    <span className={`avatar ${className}`} style={{ width: size, height: size, fontSize: size }} aria-hidden="true">
      {img ? <img src={img.thumb} alt="" width={size} height={size} loading="lazy" decoding="async" /> : (
        <>
          <svg viewBox="0 0 64 64"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="2" strokeLinejoin="round" /></svg>
          <span>{initials(f.name)}</span>
        </>
      )}
    </span>
  );
}
export function Portrait({ f, img, sizes = "(max-width: 680px) 45vw, 320px", priority = false, className = "" }: { f: Pick<Fighter, "name">; img?: PortraitSet | null; sizes?: string; priority?: boolean; className?: string }) {
  return (
    <div className={`portrait ${className}`}>
      {img ? (
        <img src={img.card} alt={`${f.name}`} width={800} height={1000} sizes={sizes} loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : undefined} />
      ) : (
        <div className="fallback" aria-hidden="true">
          <Octagon />
          <b>{initials(f.name)}</b>
          <small>Portrait pending</small>
        </div>
      )}
    </div>
  );
}
export function Credit({ img, prefix = "Photo" }: { img?: PortraitSet | null; prefix?: string }) {
  if (!img || (!img.author && !img.license)) return null;
  /* A display-only ESPN headshot is not a Commons photo. */
  if (img.kind === "display_fallback" || img.source_family === "espn") {
    return <div className="credit">{prefix}: {img.source_url ? <a href={img.source_url} rel="noopener nofollow" target="_blank">ESPN</a> : "ESPN"}</div>;
  }
  return (
    <div className="credit">
      {prefix}: {img.source_url ? <a href={img.source_url} rel="noopener nofollow" target="_blank">{img.author || "Wikimedia Commons"}</a> : img.author}{img.license ? ` · ${img.license}` : ""} · via Wikimedia Commons
    </div>
  );
}

/* ---- events ------------------------------------------------------------ */
export function EventCard({ e, main, imgs, bouts }: { e: Event; main?: Bout | null; imgs?: Portraits; bouts?: number }) {
  const d = daysUntil(e.event_date);
  const w = main ? winnerOf(main) : null;
  return (
    <Link href={`/events/${eventSlug(e)}`} className="ecard">
      <div className="strip">
        <span className="eyebrow">{eventBrand(e.name)}</span>
        <span className={`tag${d != null && d >= 0 && d <= 6 && e.card_status !== "complete" ? " gold" : ""}`}>{eventStatusLabel(e)}</span>
      </div>
      {main ? (
        <div className="faces">
          {[main.fighter_a, main.fighter_b].map((f) => {
            const img = imgs?.get(f.id);
            return <div className="face" key={f.id}>{img ? <img src={img.card} alt="" width={400} height={500} loading="lazy" decoding="async" /> : <span className="fb">{initials(f.name)}</span>}</div>;
          })}
          <span className="vs">{main.result ? "FINAL" : "VS"}</span>
        </div>
      ) : null}
      <div className="body">
        <div className="t">{eventHeadline(e.name) || e.name}</div>
        {main ? (
          <div className="me">
            {w ? <><b>{w.name}</b> def. {w.id === main.fighter_a.id ? main.fighter_b.name : main.fighter_a.name} · {METHOD_SHORT[main.result!.method]}{main.result!.round ? ` R${main.result!.round}` : ""}</>
              : <><b>{main.fighter_a.name}</b> vs <b>{main.fighter_b.name}</b> · {weightClassLabel(main.weight_class, main.is_womens)}{main.is_title ? " title" : ""}</>}
          </div>
        ) : <div className="me faint">{bouts ? `${bouts} bouts announced` : "Card announcement pending"}</div>}
        <div className="meta">
          <span>{fmtDate(e.event_date)}</span>
          <span className="truncate">{cityLine(e) || "Venue TBA"}</span>
        </div>
      </div>
    </Link>
  );
}
export function EventRow({ e, main, bouts }: { e: Event; main?: Bout | null; bouts?: number }) {
  const w = main ? winnerOf(main) : null;
  return (
    <Link href={`/events/${eventSlug(e)}`} className="erow">
      <div className="d">{fmtDate(e.event_date, { month: "short", day: "numeric" })}<small>{e.event_date?.slice(0, 4)}</small></div>
      <div>
        <div className="t">{e.name}</div>
        <div className="l">{main ? (w ? `${w.name} def. ${w.id === main.fighter_a.id ? main.fighter_b.name : main.fighter_a.name}` : `${main.fighter_a.name} vs ${main.fighter_b.name}`) : locationLine(e) || "Venue TBA"}{bouts ? ` · ${bouts} bouts` : ""}</div>
      </div>
      <div className="s"><span className="tag">{eventStatusLabel(e)}</span></div>
    </Link>
  );
}

/* ---- bouts ------------------------------------------------------------- */
export function BoutRow({ b, e, imgs, isMain, roundCoverage, market, marketState }: { b: Bout; e: Event; imgs?: Portraits; isMain?: boolean; roundCoverage?: { rounds: number; bothCorners: boolean } | null; market?: BoutMarket; marketState?: MarketState }) {
  const r = b.result;
  const wA = r?.winner_id === b.fighter_a.id;
  const wB = r?.winner_id === b.fighter_b.id;
  const off = b.status === "cancelled";
  return (
    <Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`} className={`bout${isMain ? " main" : ""}${off ? " off" : ""}${b.is_title ? " title" : ""}${r ? " done" : ""}`}>
      <div className="f a">
        <Avatar f={b.fighter_a} img={imgs?.get(b.fighter_a.id)} />
        <div className="t">
          <div className="n">{b.fighter_a.name}{wA && <span className="w">WIN</span>}</div>
          <div className="r">{fmtRecord(b.fighter_a)}{b.fighter_a.nickname ? <> · <em>{b.fighter_a.nickname}</em></> : null}</div>
        </div>
      </div>
      <div className="mid">
        <div className="wc">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title" : ""}{!r && b.scheduled_rounds ? ` · ${b.scheduled_rounds}R` : ""}</div>
        {off ? <div className="res" style={{ color: "var(--pbe-crimson-bright)" }}>Cancelled</div>
          : r ? <><div className="res">{METHOD_LABEL[r.method] || r.method}</div><div className="sub">{r.round ? `Round ${r.round}` : ""}{r.time_sec != null ? ` · ${fmtTime(r.time_sec)}` : ""}{!r.winner_id && r.method !== "DRAW" && r.method !== "NC" ? "" : ""}</div></>
          : <div className="vs">vs</div>}
        {/* The row is already a link to the fight, so this is a marker rather
            than a second anchor. It appears only when round observations
            exist; there is no disabled state advertising data we lack. */}
        {marketState && marketState !== "not_configured" ? (
          <MarketInline market={market} state={marketState} nameA={b.fighter_a.name} nameB={b.fighter_b.name} />
        ) : null}
        {roundCoverage && roundCoverage.rounds > 0 ? (
          <div className="bout-rba" data-rba-source="event_page">Round-by-Round · {roundCoverage.rounds} round{roundCoverage.rounds === 1 ? "" : "s"}</div>
        ) : null}
      </div>
      <div className="f b">
        <Avatar f={b.fighter_b} img={imgs?.get(b.fighter_b.id)} />
        <div className="t">
          <div className="n">{wB && <span className="w">WIN</span>}{b.fighter_b.name}</div>
          <div className="r">{fmtRecord(b.fighter_b)}{b.fighter_b.nickname ? <> · <em>{b.fighter_b.nickname}</em></> : null}</div>
        </div>
      </div>
    </Link>
  );
}
export function CardSegments({ bouts, e, imgs, roundCoverage, markets, unresolved }: { bouts: Bout[]; e: Event; imgs?: Portraits; roundCoverage?: Map<string, { rounds: number; bothCorners: boolean }>; markets?: Map<string, BoutMarket>; unresolved?: Set<string> }) {
  const order = ["main", "prelim", "early", null] as const;
  const groups = order.map((p) => ({ p, rows: bouts.filter((b) => (b.card_position || null) === p) })).filter((g) => g.rows.length);
  const mainId = bouts[0]?.id;
  return (
    <div>
      {groups.map((g) => (
        <section className="segment" key={String(g.p)}>
          <h3>{g.p ? cardPositionLabel(g.p) : e.card_status === "complete" ? "Results" : "Announced bouts"} <small>{g.rows.length} bouts</small></h3>
          <div className="bouts">
            {g.rows.map((b) => <BoutRow key={b.id} b={b} e={e} imgs={imgs} isMain={b.id === mainId} roundCoverage={roundCoverage?.get(b.id) || null} market={markets?.get(b.id)} marketState={markets ? marketStateFor(markets.get(b.id), { eventDate: e.event_date, hasResult: Boolean(b.result), unresolved: unresolved?.has(b.id) }) : undefined} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---- tale of the tape -------------------------------------------------- */
function bar(v: number | null, o: number | null, hi = true): number {
  if (v == null || o == null) return 0;
  const max = Math.max(v, o) || 1;
  return hi ? (v / max) * 100 : (Math.min(v, o) / (v || 1)) * 100;
}
export function TaleOfTheTape({ a, b, at }: { a: Fighter; b: Fighter; at?: string | null }) {
  const aa = age(a.dob, at), ab = age(b.dob, at);
  const rows: Array<{ k: string; l: string; r: string; lv?: number | null; rv?: number | null; hi?: boolean }> = [
    { k: "Record", l: fmtRecord(a), r: fmtRecord(b), lv: a.record_w, rv: b.record_w },
    { k: "Age", l: aa?.toString() || "—", r: ab?.toString() || "—", lv: aa, rv: ab, hi: false },
    { k: "Height", l: fmtHeight(a.height_in), r: fmtHeight(b.height_in), lv: a.height_in, rv: b.height_in },
    { k: "Reach", l: fmtReach(a.reach_in), r: fmtReach(b.reach_in), lv: a.reach_in, rv: b.reach_in },
    { k: "Stance", l: stanceLabel(a.stance), r: stanceLabel(b.stance) },
    ...(a.career_slpm != null || b.career_slpm != null ? [{ k: "Sig. str./min", l: a.career_slpm?.toFixed(2) || "—", r: b.career_slpm?.toFixed(2) || "—", lv: a.career_slpm, rv: b.career_slpm }] : []),
    ...(a.career_td_avg != null || b.career_td_avg != null ? [{ k: "TD / 15 min", l: a.career_td_avg?.toFixed(2) || "—", r: b.career_td_avg?.toFixed(2) || "—", lv: a.career_td_avg, rv: b.career_td_avg }] : []),
  ];
  return (
    <div className="tape-rows">
      {rows.map((row) => {
        const lw = row.lv != null && row.rv != null ? (row.hi === false ? row.lv < row.rv : row.lv > row.rv) : false;
        const rw = row.lv != null && row.rv != null ? (row.hi === false ? row.rv < row.lv : row.rv > row.lv) : false;
        return (
          <div className="tr" key={row.k}>
            <span className={`l${lw ? " edge" : ""}`}>{row.l}{row.lv != null && row.rv != null && <span className="bar"><i style={{ width: `${bar(row.lv, row.rv, row.hi !== false)}%` }} /></span>}</span>
            <span className="k">{row.k}</span>
            <span className={`r${rw ? " edge" : ""}`}>{row.r}{row.lv != null && row.rv != null && <span className="bar"><i style={{ width: `${bar(row.rv, row.lv, row.hi !== false)}%` }} /></span>}</span>
          </div>
        );
      })}
    </div>
  );
}
export function MatchupCard({ b, e, imgs }: { b: Bout; e: Event; imgs?: Portraits }) {
  const r = b.result;
  const w = winnerOf(b);
  return (
    <div className="matchup">
      <div className="top">
        <span className="eyebrow">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title bout" : ""}</span>
        <span className={`tag${r ? " pos" : ""}`}>{r ? "Final" : cardPositionLabel(b.card_position)}</span>
      </div>
      <div className="tape">
        <Link href={`/fighters/${fighterSlug(b.fighter_a)}`} className="side">
          <Avatar f={b.fighter_a} img={imgs?.get(b.fighter_a.id)} size={84} />
          <div className="name">{b.fighter_a.name}</div>
          {b.fighter_a.nickname && <div className="nick">“{b.fighter_a.nickname}”</div>}
          <div className="rec">{fmtRecord(b.fighter_a)}</div>
        </Link>
        <div className="vs">vs</div>
        <Link href={`/fighters/${fighterSlug(b.fighter_b)}`} className="side">
          <Avatar f={b.fighter_b} img={imgs?.get(b.fighter_b.id)} size={84} />
          <div className="name">{b.fighter_b.name}</div>
          {b.fighter_b.nickname && <div className="nick">“{b.fighter_b.nickname}”</div>}
          <div className="rec">{fmtRecord(b.fighter_b)}</div>
        </Link>
      </div>
      <TaleOfTheTape a={b.fighter_a} b={b.fighter_b} at={e.event_date} />
      {r ? (
        <div className="well mt-4">
          <div className="eyebrow">Result</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", marginTop: 4 }}>{w ? `${w.name} def. ${w.id === b.fighter_a.id ? b.fighter_b.name : b.fighter_a.name}` : METHOD_LABEL[r.method]}</div>
          <div className="mono faint sm">{METHOD_LABEL[r.method] || r.method}{r.round ? ` · Round ${r.round}` : ""}{r.time_sec != null ? ` · ${fmtTime(r.time_sec)}` : ""}</div>
        </div>
      ) : <ProLock />}
      <div style={{ marginTop: 12, textAlign: "right" }}>
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
        <div className="faint sm">Model pricing arrives with UFC Pro. No pick is shown until the model has produced one.</div>
      </div>
      <div className="blur" aria-hidden="true">+0.0%</div>
    </div>
  );
}

/* ---- fighters ---------------------------------------------------------- */
export function FighterCard({ f, img, meta }: { f: Fighter; img?: PortraitSet | null; meta?: string }) {
  return (
    <Link href={`/fighters/${fighterSlug(f)}`} className="fcard">
      <Portrait f={f} img={img} sizes="(max-width: 680px) 45vw, 220px" />
      <div className="body">
        <div className="n">{f.name}</div>
        {f.nickname ? <div className="nick">“{f.nickname}”</div> : null}
        <div className="m"><b>{fmtRecord(f)}</b>{meta ? ` · ${meta}` : ` · ${fmtHeight(f.height_in)} · ${fmtReach(f.reach_in)} reach`}</div>
      </div>
    </Link>
  );
}
export function FighterRow({ f, img, rank, change, isNew, meta }: { f: Fighter; img?: PortraitSet | null; rank?: number; change?: number | null; isNew?: boolean; meta?: string }) {
  return (
    <Link href={`/fighters/${fighterSlug(f)}`} className="frow">
      {rank != null && <span className="rk">{rank === 0 ? "C" : rank}</span>}
      <Avatar f={f} img={img} size={40} />
      <div style={{ minWidth: 0 }}>
        <div className="n truncate">{f.name}</div>
        <div className="m">{meta || fmtRecord(f)}</div>
      </div>
      {(change != null || isNew) && <Change change={change ?? null} isNew={isNew} />}
    </Link>
  );
}
export function Change({ change, isNew }: { change: number | null; isNew?: boolean }) {
  if (isNew) return <span className="chg new">NEW</span>;
  if (change == null || change === 0) return <span className="chg none">—</span>;
  return <span className={`chg ${change > 0 ? "up" : "down"}`}>{change > 0 ? "▲" : "▼"} {Math.abs(change)}</span>;
}

/* ---- news -------------------------------------------------------------- */
export function StoryCard({ a, hero, feature, faces, kicker }: { a: Article; hero?: PortraitSet | null; feature?: boolean; faces?: Array<{ f: Pick<Fighter, "name">; img?: PortraitSet | null }>; kicker?: string }) {
  return (
    <Link href={`/news/${a.slug}`} className={`story${feature ? " feature" : ""}`}>
      <div className="img">
        {hero ? <img src={hero.card} alt="" width={800} height={1000} loading={feature ? "eager" : "lazy"} decoding="async" /> : (
          <div className="gen">
            <Octagon className="oc" />
            {faces && faces.length > 0 && (
              <div className="faces">
                <Avatar f={faces[0].f} img={faces[0].img} size={feature ? 72 : 48} />
                {faces[1] && <><span className="vs">vs</span><Avatar f={faces[1].f} img={faces[1].img} size={feature ? 72 : 48} /></>}
              </div>
            )}
            <small>{a.published_at ? fmtDate(a.published_at.slice(0, 10), { month: "short", day: "numeric" }) : SITE.desk}</small>
            <b>{kicker || STORY_TYPE_LABEL[a.story_type] || a.story_type}</b>
          </div>
        )}
      </div>
      <div className="body">
        <span className="eyebrow">{STORY_TYPE_LABEL[a.story_type] || a.story_type}{impactOf(a) ? <span className="impact" title="Bettor's Edge impact score (analysis)"> · Edge {impactOf(a)}/5</span> : null}</span>
        <h3>{a.headline}</h3>
        {a.dek && <p>{a.dek}</p>}
        <div className="foot">
          <span>{a.published_at ? fmtDate(a.published_at.slice(0, 10)) : ""}</span>
          <span>{SITE.desk}</span>
        </div>
      </div>
    </Link>
  );
}

function impactOf(a: Article): number | null {
  const v = (a.fact_block as { bettor_angle?: { impact_score?: number } } | null | undefined)?.bettor_angle?.impact_score;
  return typeof v === "number" && v > 0 ? Math.min(5, Math.round(v)) : null;
}

export function ProPlans() {
  return (
    <div className="plans">
      <div className="plan">
        <div className="eyebrow dim">Free</div>
        <div className="price">$0</div>
        <ul>
          <li>Every upcoming card, main card and prelims</li>
          <li>Fighter pages with records, physicals and fight history</li>
          <li>Event pages and results with round-level stats</li>
          <li>A-vs-B matchup pages with tale of the tape</li>
          <li>Official rankings, newsroom and RSS</li>
        </ul>
        <Link href="/events" className="btn">Browse the cards</Link>
      </div>
      <div className="plan pro">
        <div className="eyebrow">UFC Pro · Founding access</div>
        <div className="price">{SITE.pricing.monthly} <small>or {SITE.pricing.cardPass} pass</small></div>
        <ul>
          <li>Fight DNA and bettor-grade UFC intelligence as Pro surfaces ship</li>
          <li>Fight-week card-change, weigh-in and market intelligence as available</li>
          <li className="locked">Model picks and fair pricing stay locked until validated</li>
          <li className="locked">Judge/referee intelligence unlocks only from verified source data</li>
          <li>No fabricated odds, picks, probabilities or unavailable features</li>
        </ul>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href={SITE.checkout.monthly} className="btn gold">Start UFC Pro · {SITE.pricing.monthly}</a>
          <a href={SITE.checkout.cardPass} className="btn">Single card · {SITE.pricing.cardPass}</a>
        </div>
        <div className="faint label mt-3">Secure checkout by Stripe. The validated model layer remains locked until its track record is ready.</div>
      </div>
    </div>
  );
}
