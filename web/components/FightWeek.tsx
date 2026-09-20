import Link from "next/link";
import { RoundLink } from "@/components/RoundLink";
import type { Bout, Event, PortraitSet } from "@/lib/db";
import type { DeskBrief } from "@/lib/pregame";
import { pickVariant, type Framing } from "@/lib/variants";
import { DeskArt, ageAt, height, inches, stance } from "@/components/DeskArt";
import { Avatar, Breadcrumbs, EventRow, JsonLd } from "@/components/ui";
import { VideoRail, videoJsonLd, curatedEventVideos } from "@/components/VideoRail";
import { Dropdown } from "@/components/Menu";
import { cardSections, fightRead, fightReadParts, whatToWatch, thingsThatMatter, fightPhases, phaseHeadlines, fmtStamp, compactRead, compactSignals, type FightWeekPacket, type Factor } from "@/lib/fightweek";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { cardPositionLabel, fmtDate, fmtRecord, locationLine, plural, weightClassLabel } from "@/lib/format";
import { UFC_OFFICIAL } from "@/lib/heritage";
import { SITE } from "@/lib/site";
import { ProPreview } from "@/components/ProPreview";
import { eventSnapshot, watchForNote } from "@/lib/fightWeekSnapshot";

/* Fight Week — Pregame Desk as a product surface, presented as a premium
 * editorial intelligence brief.
 *
 * Order (desktop and mobile): masthead → local navigator (MAIN EVENT · MAIN
 * CARD · PRELIMS + Jump to fight ▾) → main event surface (faceoff · Fight
 * Read · Key comparison · 3 things that matter · How they win · Fight phase ·
 * Full matchup intelligence, separated by dividers rather than nested boxes)
 * → main card as scan-first cards → compact expandable prelims → secondary
 * official video → sources and freshness.
 *
 * Every line is evidence-led commentary from the stored packet, never a pick.
 * Nothing here is called "The Edge". */

type Portraits = Map<string, PortraitSet>;
const lastName = (f: { name: string }) => f.name.split(" ").slice(-1)[0] || f.name;

function leanLabel(f: Factor, brief: DeskBrief): string | null {
  if (!f.lean) return null;
  return `Favors ${lastName(f.lean === "a" ? brief.a.fighter : brief.b.fighter)}`;
}

/* Fight Read: one strong lead, optional supporting sentence, short evidence. */
function Read({ brief, compact = false }: { brief: DeskBrief; compact?: boolean }) {
  const parts = fightReadParts(brief);
  if (!parts) return null;
  if (compact) return <div className="fw-card-read"><div className="fw-h">{parts.watch ? "What to watch" : "Fight read"}</div><span>{parts.lead}</span></div>;
  return (
    <div className="fw-sec-block fw-read">
      <div className="fw-h">{parts.watch ? "What to watch" : "Fight read"}</div>
      <p className="lead">{parts.lead}</p>
      {parts.supporting && <p className="support">{parts.supporting}</p>}
      {parts.evidence && <p className="evidence"><span>Supporting evidence</span>{parts.evidence}</p>}
    </div>
  );
}

function Facts({ brief, max = 2 }: { brief: DeskBrief; max?: number }) {
  const facts = thingsThatMatter(brief, max);
  if (!facts.length) return null;
  return <ul className="fw-facts">{facts.map((f) => <li key={f.key}><b>{f.label}</b><span><strong>{f.hook}</strong> {f.line}</span></li>)}</ul>;
}

/* Mirrored key comparison: Age · Height · Reach · Stance · Rank, with the
 * fighter names as column headers. Meaningful factual differences are
 * highlighted on both cells; nothing is declared a winner. */
function KeyComparison({ brief, event }: { brief: DeskBrief; event: Event }) {
  const { a, b } = brief;
  const A = a.fighter, B = b.fighter;
  const ageA = ageAt(A.dob, event.event_date), ageB = ageAt(B.dob, event.event_date);
  const num = (v: number | null) => (v == null ? null : Number(v));
  const diff = (x: number | null, y: number | null, min: number) => x != null && y != null && Math.abs(x - y) >= min;
  const rows: Array<[string, string, string, boolean]> = [
    ["Age", ageA == null ? "Not published" : String(ageA), ageB == null ? "Not published" : String(ageB), diff(ageA, ageB, 5)],
    ["Height", height(A.height_in), height(B.height_in), diff(num(A.height_in), num(B.height_in), 2)],
    ["Reach", inches(A.reach_in), inches(B.reach_in), diff(num(A.reach_in), num(B.reach_in), 2)],
    ["Stance", stance(A.stance), stance(B.stance), Boolean(A.stance && B.stance && A.stance !== B.stance)],
    ["Rank", a.rank || "Unranked", b.rank || "Unranked", Boolean(a.rank) !== Boolean(b.rank)],
  ];
  return (
    <div className="fw-sec-block">
      <div className="fw-h">Key comparison</div>
      <table className="fw-kc">
        <thead><tr><th scope="col"><span className="sr">Attribute</span></th><th scope="col">{lastName(A)}</th><th scope="col">{lastName(B)}</th></tr></thead>
        <tbody>{rows.map(([k, va, vb, hl]) => <tr key={k} className={hl ? "hl" : ""}><th scope="row">{k}</th><td>{va}</td><td>{vb}</td></tr>)}</tbody>
      </table>
      <p className="fw-fine">Highlighted rows mark a meaningful factual difference, not an advantage. Unpublished values stay unpublished.</p>
    </div>
  );
}

/* ---- main event surface ------------------------------------------------ */
export function MainEventDesk({ packet, brief }: { packet: FightWeekPacket; brief: DeskBrief }) {
  const { event, imgs, framing } = packet;
  const { bout, a, b } = brief;
  const factors = thingsThatMatter(brief, 3);
  const phases = fightPhases(brief);
  const heads = phases ? phaseHeadlines(brief, phases) : null;
  const full = brief.tier !== "watch";
  return (
    <section id="main-event" className="fw-main" aria-labelledby="fw-main-title">
      <div className="fw-main-top">
        <div>
          <div className="fw-kicker">{bout.is_title ? "Title fight" : "Main event"} · {full ? "Verified packet" : "Limited packet"}</div>
          <h2 id="fw-main-title">{bout.fighter_a.name} vs {bout.fighter_b.name}</h2>
        </div>
        <div className="fw-stakes">{brief.stakes.slice(0, 4).map((s) => <span key={s}>{s}</span>)}</div>
      </div>

      <DeskArt brief={brief} event={event} imgs={imgs} framing={framing as Map<string, Framing>} />

      <div className="fw-main-intel-grid">
        <Read brief={brief} />
        <KeyComparison brief={brief} event={event} />
      </div>

      {factors.length > 0 && (
        <div className="fw-sec-block">
          <div className="fw-h">{factors.length === 3 ? "3 things that matter" : "What matters"}</div>
          <div className="fw-factors">
            {factors.map((f) => {
              const lean = leanLabel(f, brief);
              return (
                <div className="fw-factor" key={f.key}>
                  <span className="lab">{f.label}</span>
                  <strong className="hook">{f.hook}</strong>
                  <p>{f.line}</p>
                  {lean && <small className="lean">{lean}</small>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <details className="fw-deep-read">
        <summary><span>Deep matchup read</span><small>How they win · Fight phase</small></summary>
        <div className="fw-deep-body">
          <div className="fw-sec-block">
            <div className="fw-h">How they win</div>
            <div className="fw-win">
              {[a, b].map((side) => (
                <div className="fw-win-side" key={side.fighter.id}>
                  <header><span>How {lastName(side.fighter)} wins</span><strong>{side.fighter.name}</strong><b>{fmtRecord(side.fighter)}</b></header>
                  <ul>{side.keys.slice(0, 3).map((k) => <li key={k}>{k}</li>)}</ul>
                </div>
              ))}
            </div>
          </div>

          {phases && heads && (
            <div className="fw-sec-block">
              <div className="fw-h">Fight phase</div>
              <ol className="fw-phase">
                <li><span className="ph">Early</span><strong>{heads.early}</strong><p>{phases.early}</p></li>
                <li><span className="ph">Middle</span><strong>{heads.middle}</strong><p>{phases.middle}</p></li>
                <li><span className="ph">Late</span><strong>{heads.late}</strong><p>{phases.late}</p></li>
              </ol>
            </div>
          )}
        </div>
      </details>

      <div className="fw-foot">
        <div className="fw-coverage"><i />{full ? "Full packet" : "Limited packet"}<small> · {brief.coverage.replace(/^(Full|Limited) packet: /, "")}</small></div>
        <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} className="btn gold">Full matchup intelligence →</Link>
      </div>
    </section>
  );
}

/* ---- scan-first matchup card ------------------------------------------
 * Division / rounds / position · mirrored fighter identity · one MATCHUP
 * READ · up to two KEY SIGNALS that never repeat the read's evidence · one
 * text CTA. Packet status sits with the position metadata, not the CTA. */
const rankShort = (rank: string | null) => (rank ? (/champion/i.test(rank) ? "C" : rank.replace(/\s.*$/, "")) : null);

function Identity({ bout, brief, imgs }: { bout: Bout; brief?: DeskBrief | null; imgs: Portraits }) {
  const sides = [{ f: bout.fighter_a, rank: brief?.a.rank ?? null, k: "a" }, { f: bout.fighter_b, rank: brief?.b.rank ?? null, k: "b" }];
  return (
    <div className="fw-card-id">
      {sides.map(({ f, rank, k }, i) => (
        <span key={f.id} className="fw-card-id-wrap">
          {i === 1 && <span className="vs" aria-hidden="true">VS</span>}
          <Link href={`/fighters/${fighterSlug(f)}`} className={`side ${k}`} aria-label={`${f.name}, ${fmtRecord(f)}${rank ? `, ${rank}` : ""}`}>
            <Avatar f={f} img={imgs.get(f.id)} size={48} />
            <span className="id"><span className="nm">{f.name}</span><span className="rr"><b>{fmtRecord(f)}</b>{rank && <em title={rank}>{rankShort(rank)}</em>}</span></span>
          </Link>
        </span>
      ))}
    </div>
  );
}

export function MatchupIntel({ bout, brief, event, imgs, roundCoverage }: { bout: Bout; brief?: DeskBrief | null; event: Event; imgs: Portraits; roundCoverage?: { rounds: number; bothCorners: boolean } | null }) {
  const watch = !brief || brief.tier === "watch";
  const read = brief ? compactRead(brief) : null;
  const signals = brief && read ? compactSignals(brief, read.used, 2) : [];
  const la = lastName(bout.fighter_a), lb = lastName(bout.fighter_b);
  return (
    <article id={`bout-${bout.id}`} className={`fw-card${watch ? " watch" : ""}`}>
      <div className="fw-card-top">
        <span>{weightClassLabel(bout.weight_class, bout.is_womens)}{bout.is_title ? " · Title" : ""}{bout.scheduled_rounds ? ` · ${bout.scheduled_rounds} rounds` : ""}</span>
        <small>{cardPositionLabel(bout.card_position)} · <i className={`pk${watch ? " lim" : ""}`} aria-hidden="true" />{brief ? (watch ? "Limited packet" : "Full packet") : "Card only"}</small>
      </div>
      <Identity bout={bout} brief={brief} imgs={imgs} />
      <div className="fw-card-read">
        <div className="fw-h">{read ? (read.watch ? "What to watch" : "Matchup read") : "Packet"}</div>
        <p>{read?.read || "Intelligence packet not available for this pairing yet. Records and the matchup page are live."}</p>
      </div>
      {signals.length > 0 && (
        <div className="fw-signals">
          <div className="fw-h">Key signals</div>
          {signals.map((s) => (
            <div className="fw-signal" key={s.key}>
              <span className="lab">{s.label}</span>
              <span className="vals"><span className="v a"><b>{s.a}</b><small>{la}</small></span><i aria-hidden="true" /><span className="v b"><b>{s.b}</b><small>{lb}</small></span></span>
              <span className="unit">{s.unit}</span>
              {(s.delta || s.note) && <span className="delta">{[s.delta, s.note].filter(Boolean).join(" · ")}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="fw-card-cta">
        <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`}>View matchup intelligence →</Link>
        <RoundLink href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} coverage={roundCoverage} source="fight_week" />
      </div>
    </article>
  );
}


/* ---- flagship scan tile ------------------------------------------------
 * Fight Week is a card overview first. Deep reads stay on the matchup page;
 * this surface gives identity, records and one evidence-led signal. */
function FightWeekBoutTile({ bout, brief, event, imgs, compact = false }: {
  bout: Bout;
  brief?: DeskBrief | null;
  event: Event;
  imgs: Portraits;
  compact?: boolean;
}) {
  const read = brief ? compactRead(brief) : null;
  const top = brief ? thingsThatMatter(brief, 1)[0] : null;
  const signal = top ? `${top.label}: ${top.hook}` : read?.read || (brief ? "Verified matchup packet" : "Card intelligence pending");
  return (
    <article id={`bout-${bout.id}`} className={`fw-bout-tile${compact ? " compact" : ""}`}>
      <div className="fw-bout-tile-meta">
        <span>{weightClassLabel(bout.weight_class, bout.is_womens)}{bout.is_title ? " · Title" : ""}</span>
        <small>{brief ? (brief.tier === "watch" ? "Limited packet" : "Full packet") : "Card only"}</small>
      </div>
      <div className="fw-bout-tile-fighters">
        <Link href={`/fighters/${fighterSlug(bout.fighter_a)}`} className="fw-bout-side a">
          <Avatar f={bout.fighter_a} img={imgs.get(bout.fighter_a.id)} size={compact ? 44 : 52} />
          <span><strong>{bout.fighter_a.name}</strong><small>{fmtRecord(bout.fighter_a)}{brief?.a.rank ? ` · ${brief.a.rank}` : ""}</small></span>
        </Link>
        <span className="fw-bout-vs">VS</span>
        <Link href={`/fighters/${fighterSlug(bout.fighter_b)}`} className="fw-bout-side b">
          <Avatar f={bout.fighter_b} img={imgs.get(bout.fighter_b.id)} size={compact ? 44 : 52} />
          <span><strong>{bout.fighter_b.name}</strong><small>{fmtRecord(bout.fighter_b)}{brief?.b.rank ? ` · ${brief.b.rank}` : ""}</small></span>
        </Link>
      </div>
      <div className="fw-bout-tile-signal">{signal}</div>
      <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} className="fw-bout-tile-cta">
        Read matchup <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

/* ---- compact prelim row with expand ----------------------------------- */
export function PrelimRow({ bout, brief, event, imgs, roundCoverage }: { bout: Bout; brief?: DeskBrief | null; event: Event; imgs: Portraits; roundCoverage?: { rounds: number; bothCorners: boolean } | null }) {
  const top = brief ? thingsThatMatter(brief, 1)[0] : null;
  const line = top ? `${top.label}: ${top.hook}` : brief ? (brief.tier === "watch" ? "Limited packet" : "Full packet") : "Card only";
  return (
    <details id={`bout-${bout.id}`} className="fw-prelim">
      <summary>
        <span className="avatars"><Avatar f={bout.fighter_a} img={imgs.get(bout.fighter_a.id)} size={40} /><Avatar f={bout.fighter_b} img={imgs.get(bout.fighter_b.id)} size={40} /></span>
        <span className="names">
          <b>{bout.fighter_a.name}<i>vs</i>{bout.fighter_b.name}</b>
          <span>{weightClassLabel(bout.weight_class, bout.is_womens)}{bout.is_title ? " · Title" : ""} · {fmtRecord(bout.fighter_a)}{brief?.a.rank ? <em> ({brief.a.rank})</em> : null} · {fmtRecord(bout.fighter_b)}{brief?.b.rank ? <em> ({brief.b.rank})</em> : null}</span>
          <span className="line">{line}</span>
        </span>
        <span className="open"><span className="closed-l">Read</span><span className="open-l">Close</span></span>
      </summary>
      <div className="fw-prelim-body">
        {brief ? <Read brief={brief} compact /> : <div className="fw-card-read"><span>Intelligence packet not available for this pairing yet.</span></div>}
        {brief && <Facts brief={brief} max={2} />}
        <div className="fw-card-cta">
          <Link href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`}>Matchup intelligence →</Link>
          <RoundLink href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, event)}`} coverage={roundCoverage} source="fight_week" />
          <small>{brief ? (brief.tier === "watch" ? "Limited packet" : "Full packet") : "Card only"}</small>
        </div>
      </div>
    </details>
  );
}

/* ---- local navigator: three groups + Jump to fight ▾ ------------------- */
export function FightNavigator({ live }: { live: Bout[] }) {
  const { main, mainCard, prelims, unpositioned } = cardSections(live);
  const items = live.map((b, i) => ({ href: i === 0 ? "#main-event" : `#bout-${b.id}`, label: `${lastName(b.fighter_a)} vs ${lastName(b.fighter_b)}`, note: `${weightClassLabel(b.weight_class, b.is_womens)}${b.is_title ? " · Title" : ""}` }));
  return (
    <nav className="fw-nav" aria-label="Fight navigator">
      <div className="fw-nav-in">
        {main && <a href="#main-event">Main event</a>}
        {mainCard.length > 0 && <a href="#main-card">Main card <small>{mainCard.length + 1}</small></a>}
        {prelims.length > 0 && <a href="#prelims">Prelims <small>{prelims.length}</small></a>}
        {unpositioned.length > 0 && <a href="#announced">Announced <small>{unpositioned.length}</small></a>}
        <span className="grow" aria-hidden="true" />
        {items.length > 1 && <Dropdown id="fw-jump" label="Jump to fight" align="right" className="fw-jump" panelClassName="fw-jump-panel" groups={[{ heading: "Jump to fight", items }]} />}
      </div>
    </nav>
  );
}

/* ---- page composition -------------------------------------------------- */
export function FightWeekPage({ packet, archive, locked = null }: { packet: FightWeekPacket; archive: boolean; locked?: { signedIn: boolean; returnPath: string } | null }) {
  const { event, live, briefById, imgs, videos, days, done, updated, slug } = packet;
  const { main, mainCard, prelims, unpositioned } = cardSections(live);
  const mainBrief = main ? briefById.get(main.id) || null : null;
  const liveNight = days != null && days <= 0 && days >= -1 && !done;
  const countdown = done ? "Final" : days == null ? "Date TBA" : days === 0 ? "Fight night" : days === 1 ? "Tomorrow" : days < 0 ? "Awaiting results" : `${days} days out`;
  const crumbs = archive ? [{ name: "Fight Week", href: "/fight-week" }, { name: event.name }] : [{ name: "Fight Week" }];
  const url = archive ? `${SITE.url}/pregame/${slug}` : `${SITE.url}/fight-week`;
  const grid = (list: Bout[]) => <div className="fw-grid">{list.map((b) => <MatchupIntel key={b.id} bout={b} brief={briefById.get(b.id)} event={event} imgs={imgs} roundCoverage={packet.roundCoverage?.get(b.id) || null} />)}</div>;

  const leadVideo = videos[0] || null;
  /* The desk's own note for this card when one is on file; otherwise the read
   * the packet derives. */
  const watch = watchForNote(event.id) || (mainBrief ? (fightRead(mainBrief)[0] || whatToWatch(mainBrief)[0] || null) : null);
  const eventHref = `/events/${eventSlug(event)}`;
  const snapshot = eventSnapshot({ event, stored: packet.broadcast, bouts: live.length, updated, done });

  return (
    <div className="wrap fw-page fw-flagship">
      {archive && <Breadcrumbs items={crumbs} />}

      <header className="fw-flagship-hero">
        <div className="fw-flagship-hero-copy">
          <div className="fw-flagship-mark">UFC</div>
          <div className="fw-flagship-title">Fight <span>Week</span></div>
          <div className="fw-flagship-sub">
            {main ? `${weightClassLabel(main.weight_class, main.is_womens)} main event` : "UFC fight intelligence"}
          </div>
          <div className="fw-flagship-meta">
            <span><time dateTime={event.event_date || undefined}>{fmtDate(event.event_date, { weekday: "short", month: "short", day: "numeric" })}</time></span>
            <span>{locationLine(event) || "Venue TBA"}</span>
            <span>{plural(live.length, "bout")}</span>
          </div>
          <h1>{event.name}</h1>
          <p className="fw-flagship-dek">Real analysis. Smarter reads. A deeper understanding of the card.</p>
          <div className="fw-flagship-actions">
            <Link href={eventHref} className="btn gold">View full card →</Link>
            <Link href="/algo/card" className="btn">PBE Picks</Link>
            {videos.length ? <a href="#fw-video" className="btn">Official video</a> : <a href={UFC_OFFICIAL.youtube} className="btn" target="_blank" rel="noopener">Official video ↗</a>}
          </div>
        </div>
        <div className="fw-flagship-hero-side">
          <div className="fw-flagship-status"><i className={liveNight ? "live" : ""} /><span>{countdown}</span><b>{fmtStamp(updated)}</b></div>
          <div className="fw-flagship-mantra">Same fights.<br />Deeper insights.</div>
        </div>
      </header>

      <FightNavigator live={live} />

      {locked && <ProPreview feature="fight_week" access={{ signedIn: locked.signedIn }} returnPath={locked.returnPath} />}

      {main && (mainBrief ? <div className="fw-sec fw-main-wrap"><MainEventDesk packet={packet} brief={mainBrief} /></div> : (
        <section id="main-event" className="fw-sec"><div className="fw-sec-head"><div><div className="eyebrow">Main event</div><h2>{main.fighter_a.name} vs {main.fighter_b.name}</h2></div></div>{grid([main])}</section>
      ))}

      <div className="fw-flagship-lower">
        <main className="fw-card-column">
          {mainCard.length > 0 && (
            <section id="main-card" className="fw-sec fw-card-section">
              <div className="fw-sec-head flagship">
                <div><div className="eyebrow">Main card</div><h2>Main card</h2></div>
                <small>{plural(mainCard.length + (main ? 1 : 0), "bout")} · scan the card</small>
              </div>
              <div className="fw-bout-grid">{mainCard.map((b) => <FightWeekBoutTile key={b.id} bout={b} brief={briefById.get(b.id)} event={event} imgs={imgs} />)}</div>
            </section>
          )}

          {unpositioned.length > 0 && (
            <section id="announced" className="fw-sec fw-card-section">
              <div className="fw-sec-head flagship"><div><div className="eyebrow">Announced bouts</div><h2>Card position pending</h2></div><small>{plural(unpositioned.length, "matchup")}</small></div>
              <div className="fw-bout-grid">{unpositioned.map((b) => <FightWeekBoutTile key={b.id} bout={b} brief={briefById.get(b.id)} event={event} imgs={imgs} compact />)}</div>
            </section>
          )}

          {prelims.length > 0 && (
            <section id="prelims" className="fw-sec fw-card-section">
              <div className="fw-sec-head flagship">
                <div><div className="eyebrow">Prelims</div><h2>Prelims</h2></div>
                <small>{plural(prelims.length, "bout")} · quick intelligence</small>
              </div>
              <div className="fw-bout-grid prelims">{prelims.map((b) => <FightWeekBoutTile key={b.id} bout={b} brief={briefById.get(b.id)} event={event} imgs={imgs} compact />)}</div>
            </section>
          )}
        </main>

        <aside className="fw-event-rail">
          <section className="fw-rail-card fw-rail-event" aria-labelledby="fw-rail-event-h">
            <div className="fw-h" id="fw-rail-event-h">Event snapshot</div>
            <dl>
              {snapshot.rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
            </dl>
            <div className="fw-rail-links">
              {snapshot.watch && <a href={snapshot.watch.href} className="primary" target="_blank" rel="noopener">{snapshot.watch.label} <span aria-hidden="true">→</span></a>}
              <Link href={eventHref}>Open event page <span aria-hidden="true">→</span></Link>
            </div>
          </section>

          {leadVideo && (
            <section className="fw-rail-card fw-rail-video">
              <div className="fw-h">Official event video</div>
              <a href="#fw-video" className="fw-rail-video-thumb" aria-label="Open official fight-week video">
                {leadVideo.thumbnail_url && <img src={leadVideo.thumbnail_url} alt="" loading="lazy" decoding="async" />}
                <span className="fw-rail-play">▶</span>
              </a>
              <strong>{leadVideo.title}</strong>
              <small>Official channel · embedded below</small>
            </section>
          )}

          {watch && (
            <section className="fw-rail-card fw-rail-watch">
              <div className="fw-h">What to watch for</div>
              <p>{watch}</p>
            </section>
          )}

          {/* Conversion slot: only a reader without Pro is sold Pro. */}
          {locked && (
            <section className="fw-rail-card fw-rail-pro" aria-labelledby="fw-rail-pro-h">
              <div className="fw-h">PBE Pro</div>
              <strong id="fw-rail-pro-h">Unlock deeper fight intelligence.</strong>
              <p>Get premium picks, deeper matchup reads, and full fight-week tools.</p>
              <Link href="/pro" className="btn gold">Go Pro <span aria-hidden="true">→</span></Link>
            </section>
          )}

          <Link href={locked ? "/pro" : "/algo/card"} className="fw-rail-card fw-rail-brand">
            <span>Fight intelligence</span>
            <strong>Same fights.<br />Deeper insights.</strong>
            <p>{locked ? "Premium UFC analysis, picks, and fight-week tools." : "Your Pro picks, reads and fight-week tools for this card."}</p>
            <b>{locked ? "Explore Pro" : "Open PBE Picks"} <i aria-hidden="true">→</i></b>
          </Link>
        </aside>
      </div>

      {videos.length > 0 && (
        <section id="fw-video" className="fw-sec fw-video fw-video-secondary">
          <VideoRail variant="timeline" phase={done ? "post" : "pre"} videos={videos} title={done ? "Official video from this card" : "Fight-week video"} eyebrow="Official channels" note="Embedded from YouTube, not hosted by PropBetEdge · no endorsement implied" />
        </section>
      )}

      <footer className="fw-sources fw-flagship-sources">
        <div>
          <h4>Sources</h4>
          <ul>{packet.sources.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
        <div>
          <h4>Last updated</h4>
          <p><strong>{fmtStamp(updated)}</strong></p>
          <p>Pregame Desk is evidence-led commentary, not a pick generator. Missing facts stay unpublished instead of being guessed. {packet.rankingsDate ? `Rankings reflect the official snapshot dated ${packet.rankingsDate}.` : ""}</p>
        </div>
        <div className="fw-source-mantra">Bet smarter.<br />Watch deeper.<br />Know more.</div>
      </footer>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "SportsEvent", "@id": `${url}#event`, name: event.name, startDate: event.event_date, endDate: event.event_date, sport: "Mixed Martial Arts", description: `${event.name} pregame intelligence: ${plural(live.length, "bout")}${main ? `, main event ${main.fighter_a.name} vs ${main.fighter_b.name}` : ""}.`, eventStatus: "https://schema.org/EventScheduled", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode", image: `${SITE.url}/events/${eventSlug(event)}/opengraph-image`, location: event.venue || event.city ? { "@type": "Place", name: event.venue || event.city, address: { "@type": "PostalAddress", addressLocality: event.city, addressRegion: event.region, addressCountry: event.country } } : undefined, organizer: { "@type": "SportsOrganization", name: "Ultimate Fighting Championship", url: UFC_OFFICIAL.home }, url, subjectOf: videos.length ? videoJsonLd(curatedEventVideos(videos, done ? "post" : "pre")) : undefined, subEvent: live.map((b) => ({ "@type": "SportsEvent", name: `${b.fighter_a.name} vs ${b.fighter_b.name}`, startDate: event.event_date, url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, event)}`, sport: "Mixed Martial Arts", competitor: [{ "@type": "Person", name: b.fighter_a.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_a)}` }, { "@type": "Person", name: b.fighter_b.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_b)}` }] })) }} />
      <JsonLd data={{ "@context": "https://schema.org", "@type": "ItemList", "@id": `${url}#matchups`, name: `${event.name} matchup intelligence`, numberOfItems: live.length, itemListOrder: "https://schema.org/ItemListOrderAscending", itemListElement: live.map((b, i) => ({ "@type": "ListItem", position: i + 1, name: `${b.fighter_a.name} vs ${b.fighter_b.name}`, url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, event)}` })) }} />
      <JsonLd data={{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: SITE.url }, { "@type": "ListItem", position: 2, name: "Fight Week", item: `${SITE.url}/fight-week` }, ...(archive ? [{ "@type": "ListItem", position: 3, name: event.name, item: url }] : [])] }} />
    </div>
  );
}

/* ---- between cards ----------------------------------------------------- */
export function FightWeekEmpty({ next, upcoming }: { next: Event | null; upcoming: Event[] }) {
  return (
    <div className="wrap fw-page">
      <Breadcrumbs items={[{ name: "Fight Week" }]} />
      <section className="fw-empty" aria-labelledby="fw-empty-title">
        <div className="fw-kicker"><i />Next fight week</div>
        <h1 id="fw-empty-title">{next ? next.name : "Next fight week"}</h1>
        <p>Intelligence desk opens as the card fills.</p>
        {next && <div className="fw-meta" style={{ marginTop: 10 }}><span><time dateTime={next.event_date || undefined}>{fmtDate(next.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</time></span><span>{locationLine(next) || "Venue TBA"}</span></div>}
        <div className="fw-actions">
          {next && <Link href={`/events/${eventSlug(next)}`} className="btn gold">Event page</Link>}
          <Link href="/events" className="btn">UFC schedule</Link>
          <a href={UFC_OFFICIAL.events} className="btn" target="_blank" rel="noopener">Official UFC events ↗</a>
        </div>
      </section>
      {upcoming.length > 0 && <section className="fw-sec"><div className="fw-sec-head"><div><div className="eyebrow">Schedule</div><h2>Coming up</h2></div></div><div className="elist">{upcoming.map((e) => <EventRow key={e.id} e={e} />)}</div></section>}
      <JsonLd data={{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: SITE.url }, { "@type": "ListItem", position: 2, name: "Fight Week", item: `${SITE.url}/fight-week` }] }} />
    </div>
  );
}

/* Teaser art: two portrait tiles (card slot, detector focal when known) with
 * the names set beneath the art instead of over it, so long names never clip
 * and the rights credit never collides with the records. */
function TeaserFaces({ brief, imgs, framing }: { brief: DeskBrief; imgs?: Portraits; framing?: Map<string, Framing> }) {
  const { bout, a, b } = brief;
  const sides = [{ f: bout.fighter_a, s: a, k: "a" as const }, { f: bout.fighter_b, s: b, k: "b" as const }];
  const credits = sides.map(({ f }) => imgs?.get(f.id)?.attribution_text).filter(Boolean) as string[];
  return (
    <div className="fw-teaser-art">
      <div className="fw-faces">
        {sides.map(({ f, s, k }) => {
          const img = imgs?.get(f.id) || null;
          const v = pickVariant(img, "card", img ? framing?.get(img.id) || null : null);
          const staged = !v || v.mode !== "cover" || v.confidence === "low";
          return (
            <div className={`fw-face ${k}${staged ? " staged" : ""}`} key={f.id}>
              <div className="fw-face-img">{v ? <img src={v.src} alt={f.name} width={v.width} height={v.height} loading="lazy" decoding="async" style={{ objectPosition: v.objectPosition }} /> : <div className="fw-face-fb"><Avatar f={f} img={img || undefined} size={96} /></div>}</div>
              <div className="fw-face-nm"><strong><Link href={`/fighters/${fighterSlug(f)}`}>{f.name}</Link></strong><span><b>{fmtRecord(f)}</b>{s.rank ? <em>{s.rank}</em> : <i>Unranked</i>}</span></div>
            </div>
          );
        })}
        <div className="fw-faces-vs" aria-hidden="true"><span>VS</span><small>{weightClassLabel(bout.weight_class, bout.is_womens)}{bout.is_title ? " · Title" : ""}</small></div>
      </div>
      {credits.length > 0 && <div className="fw-faces-credit">Portraits: {credits.join(" · ")}</div>}
    </div>
  );
}

/* ---- homepage FIGHT WEEK teaser ---------------------------------------- */
export function FightWeekTeaser({ event, brief, imgs, framing, fights, updated }: { event: Event; brief: DeskBrief; imgs?: Portraits; framing?: Map<string, Framing>; fights: number; updated: string | null }) {
  const read = fightRead(brief)[0] || whatToWatch(brief)[0];
  const facts = thingsThatMatter(brief, 3);
  const days = event.event_date ? Math.round((Date.UTC(Number(event.event_date.slice(0, 4)), Number(event.event_date.slice(5, 7)) - 1, Number(event.event_date.slice(8, 10))) - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / 86400e3) : null;
  const dna = brief.evidence.some((e) => /Fight DNA matchup comparison loaded/.test(e));
  return (
    <section className="fw-teaser" aria-labelledby="fw-teaser-title">
      <TeaserFaces brief={brief} imgs={imgs} framing={framing} />
      <div className="fw-teaser-copy">
        <div className="fw-kicker"><i className={days != null && days <= 0 && days >= -1 ? "live" : ""} />Fight week · Pregame Desk</div>
        <h2 id="fw-teaser-title">{event.name}</h2>
        <div className="fw-meta"><span>{fmtDate(event.event_date, { weekday: "short", month: "short", day: "numeric" })}</span><span>{locationLine(event) || "Venue TBA"}</span>{days != null && days >= 0 && <span><b>{days === 0 ? "Fight night" : days === 1 ? "Tomorrow" : `${days} days out`}</b></span>}</div>
        {read && <div className="fw-teaser-read"><div className="fw-h">{fightRead(brief).length ? "Fight read" : "What to watch"}</div>{read}</div>}
        {facts.length > 0 && <ul className="fw-facts">{facts.map((f) => <li key={f.key}><b>{f.label}</b><span><strong>{f.hook}</strong> {f.line}</span></li>)}</ul>}
        <div className="fw-teaser-actions"><Link href="/fight-week" className="btn gold">Open Pregame Desk →</Link><Link href={`/events/${eventSlug(event)}`} className="btn">Full card</Link></div>
        <div className="fw-teaser-proof"><span><b>{fights}</b> {fights === 1 ? "fight" : "fights"} analyzed</span>{dna && <span>Fight DNA</span>}{brief.tier !== "watch" && <span>Verified archive packet</span>}{updated && <span>Updated {fmtStamp(updated)}</span>}</div>
      </div>
    </section>
  );
}

/* ---- event-page PREGAME INTELLIGENCE module ---------------------------- */
export function PregameIntelligence({ event, brief, fights, updated, href, done = false, hub = false }: { event: Event; brief: DeskBrief | null; fights: number; updated: string | null; href: string; done?: boolean; hub?: boolean }) {
  const read = brief ? fightRead(brief)[0] || whatToWatch(brief)[0] : null;
  const dna = brief ? brief.evidence.some((e) => /Fight DNA matchup comparison loaded/.test(e)) : false;
  return (
    <section className="fw-cta" aria-label={done ? "Pregame archive" : "Pregame intelligence"}>
      <div>
        <div className="fw-kicker">{done ? "Pregame archive" : "Pregame intelligence"}</div>
        <h3>{brief ? `${brief.bout.fighter_a.name} vs ${brief.bout.fighter_b.name}: the fight read` : `${event.name} · Pregame Desk`}</h3>
        {read ? <p>{read}</p> : <p>{done ? "The pregame read as it stood before the card, kept as a permanent record." : "Fight reads, key comparisons, how each fighter wins and fight-phase intelligence for every announced bout."}</p>}
        <div className="fw-teaser-proof"><span><b>{fights}</b> {fights === 1 ? "fight" : "fights"} analyzed</span>{dna && <span>Fight DNA</span>}{brief && brief.tier !== "watch" && <span>Verified archive packet</span>}{updated && <span>Updated {fmtStamp(updated)}</span>}</div>
      </div>
      <div className="fw-cta-actions">
        <Link href={href} className="btn gold">{done ? "Open pregame archive →" : "Open Pregame Desk →"}</Link>
        {hub && !done && <Link href="/fight-week" className="btn">Fight Week hub</Link>}
      </div>
    </section>
  );
}
