import Link from "next/link";
import type { PortraitSet } from "@/lib/db";
import type { DwcsAlum, DwcsAppearance, GraphBout, GraphFighter, OutcomeClaim } from "@/lib/dwcsGraph";
import { CLAIM_LABEL } from "@/lib/dwcsGraph";
import { bestRank, rankStack, type FighterRankingContext } from "@/lib/rankingContext";
import { RankChip } from "@/components/RankBadge";
import { Avatar } from "@/components/ui";
import { eventSlug, fighterSlug } from "@/lib/slug";
import { fmtDate, fmtTime, METHOD_LABEL, METHOD_SHORT } from "@/lib/format";

/* Contender Series lineage components.
 *
 * Every line is a stored fact: a DWCS result, a UFC-card bout, a rank from the
 * official snapshot, or a claim carrying its source link. There is no
 * "active"/"retired" label (ufc_fighters.is_active is not a product truth) and
 * no "earned a contract" line unless a sourced claim names the fighter. */

const monthYear = (d: string | null | undefined) => (d ? fmtDate(d, { month: "short", year: "numeric" }) : "—");

const VERB: Record<string, string> = { W: "Def.", L: "Lost to", D: "Drew with", NC: "No contest vs" };

export function resultPhrase(b: GraphBout, opponent: Pick<GraphFighter, "name"> | null | undefined): string {
  const opp = opponent?.name || "opponent";
  if (!b.outcome) return b.status === "cancelled" ? `Cancelled vs ${opp}` : `vs ${opp}`;
  return `${VERB[b.outcome]} ${opp}`;
}

export function finishLine(b: GraphBout, short = false): string | null {
  if (!b.outcome || !b.method) return null;
  const m = (short ? METHOD_SHORT : METHOD_LABEL)[b.method] || b.method;
  const parts = [m];
  if (b.round) parts.push(`R${b.round}`);
  if (b.timeSec != null) parts.push(fmtTime(b.timeSec));
  return parts.join(" · ");
}

const record = (w: number, l: number, d: number, nc: number) => `${w}-${l}${d ? `-${d}` : ""}${nc ? ` (${nc} NC)` : ""}`;

function eventHref(a: GraphBout) {
  return `/events/${eventSlug({ name: a.event.name, event_date: a.event.eventDate })}`;
}

/** Division rank (or champion) first, P4P as its own labelled chip. */
export function AlumRanks({ ctx }: { ctx: FighterRankingContext | null | undefined }) {
  if (!ctx) return null;
  const best = bestRank(ctx);
  const p4p = rankStack(ctx).find((r) => r.kind === "p4p") || null;
  if (!best) return null;
  return (
    <span className="dwa-ranks">
      <RankChip rank={best} />
      {/* The chip already carries the number; the label names what it ranks. */}
      <span className="dwa-rank-l">{best.kind === "champion" ? best.full : best.divisionLabel}</span>
      {p4p && best.kind !== "p4p" ? <RankChip rank={p4p} /> : null}
    </span>
  );
}

export function ClaimChips({ claims }: { claims: OutcomeClaim[] | undefined }) {
  if (!claims?.length) return null;
  /* One badge per outcome, linked to its earliest source; further sources
   * saying the same thing are counted, not repeated. */
  const byType = new Map<string, OutcomeClaim[]>();
  for (const c of claims) byType.set(c.claim_type, [...(byType.get(c.claim_type) || []), c]);
  return (
    <span className="dwa-claims">
      {[...byType.values()].map((list) => {
        const first = [...list].sort((a, b) => String(a.source_date || "").localeCompare(String(b.source_date || "")))[0];
        const n = new Set(list.map((c) => c.source_url)).size;
        return (
          <a key={first.id} className="tag pos" href={first.source_url} target="_blank" rel="noopener" title={`${first.source_title || first.source_url}${first.source_excerpt_short ? ` — “${first.source_excerpt_short}”` : ""}${n > 1 ? ` (+${n - 1} more UFC.com ${n === 2 ? "source" : "sources"})` : ""}`}>
            {CLAIM_LABEL[first.claim_type]} · UFC.com ↗
          </a>
        );
      })}
    </span>
  );
}

export function AlumCard({ alum, img, ctx, opponents, claims }: {
  alum: DwcsAlum; img?: PortraitSet | null; ctx?: FighterRankingContext | null;
  opponents: Map<string, GraphFighter>; claims?: OutcomeClaim[];
}) {
  const f = alum.fighter;
  const last = alum.lastDwcs;
  const u = alum.ufc;
  return (
    <article className="dwa-card">
      <Link href={`/fighters/${fighterSlug(f)}`} className="dwa-top">
        <Avatar f={f} img={img} size={64} />
        <div className="dwa-id">
          <h3>{f.name}</h3>
          <AlumRanks ctx={ctx} />
        </div>
      </Link>
      <div className="dwa-block">
        <div className="dwa-k">Contender Series</div>
        <Link href={eventHref(last)} className="dwa-line">
          <b>{last.identity.label}</b>
          <span>{resultPhrase(last, opponents.get(last.opponentId))}{finishLine(last, true) ? ` · ${finishLine(last, true)}` : ""}</span>
        </Link>
        <div className="dwa-meta">
          {alum.appearances.length > 1 ? `${alum.appearances.length} DWCS appearances · ` : ""}DWCS {alum.dwcsW}-{alum.dwcsL}
        </div>
        <ClaimChips claims={claims} />
      </div>
      <div className="dwa-block">
        <div className="dwa-k">UFC</div>
        {u.fights ? (
          <>
            <div className="dwa-stats">
              <div><b>{u.fights}</b><span>UFC fights</span></div>
              <div><b>{record(u.w, u.l, u.d, u.nc)}</b><span>UFC record</span></div>
            </div>
            <div className="dwa-meta">
              UFC debut · {monthYear(u.debut?.event.eventDate)}{u.beforeDwcs ? " (before DWCS)" : ""}
              <br />Last UFC fight · {monthYear(u.last?.event.eventDate)}
              {u.titleWins ? <><br />{u.titleWins} UFC title {u.titleWins === 1 ? "win" : "wins"}</> : null}
            </div>
          </>
        ) : (
          <div className="dwa-meta">No UFC-card bout on record</div>
        )}
        {u.next ? <div className="dwa-next">Booked · <Link href={eventHref(u.next)}>{u.next.event.name}</Link> · {fmtDate(u.next.event.eventDate, { month: "short", day: "numeric", year: "numeric" })}</div> : null}
      </div>
    </article>
  );
}

/** Canonical fighter profile: the Contender Series lineage and what followed. */
export function DwcsLineage({ alum, ctx, opponents, claims }: {
  alum: DwcsAlum; ctx?: FighterRankingContext | null; opponents: Map<string, GraphFighter>; claims?: OutcomeClaim[];
}) {
  const u = alum.ufc;
  const claimsFor = (a: DwcsAppearance) => claims?.filter((c) => c.event_id === a.event.id);
  return (
    <section className="segment dwl" id="contender-series">
      <h3>Contender Series <small>{alum.appearances.length === 1 ? "one appearance" : `${alum.appearances.length} appearances`} · canonical fight record</small></h3>
      <div className="dwl-grid">
        <div className="dwl-apps">
          {alum.appearances.map((a) => (
            <Link key={a.boutId} href={eventHref(a)} className="dwl-app">
              <span className="dwl-when">{a.identity.series === "brazil" ? "Contender Series Brazil" : "Dana White's Contender Series"}<b>{a.identity.label}</b><small>{fmtDate(a.event.eventDate, { month: "short", day: "numeric", year: "numeric" })}</small></span>
              <span className="dwl-res">
                <b className={`dwl-o ${a.outcome || ""}`}>{resultPhrase(a, opponents.get(a.opponentId))}</b>
                {finishLine(a) ? <small>{finishLine(a)}</small> : null}
                <ClaimChips claims={claimsFor(a)} />
              </span>
            </Link>
          ))}
        </div>
        <div className="dwl-ufc">
          <div className="dwa-k">UFC trajectory</div>
          {u.fights ? (
            <ul>
              <li><span>UFC debut</span><b>{u.debut ? <Link href={eventHref(u.debut)}>{monthYear(u.debut.event.eventDate)}</Link> : "—"}</b></li>
              <li><span>UFC fights</span><b>{u.fights} · {record(u.w, u.l, u.d, u.nc)}</b></li>
              <li><span>Last UFC fight</span><b>{monthYear(u.last?.event.eventDate)}</b></li>
              {u.titleWins ? <li><span>UFC title wins</span><b>{u.titleWins}</b></li> : null}
              {bestRank(ctx) ? <li><span>Current rank</span><b><AlumRanks ctx={ctx} /></b></li> : null}
              {u.next ? <li><span>Booked</span><b><Link href={eventHref(u.next)}>{fmtDate(u.next.event.eventDate, { month: "short", day: "numeric", year: "numeric" })}</Link></b></li> : null}
            </ul>
          ) : (
            <p className="dim">No UFC-card bout on record{u.next ? "" : " yet"}.{u.next ? <> Booked for <Link href={eventHref(u.next)}>{u.next.event.name}</Link>.</> : null}</p>
          )}
          {u.beforeDwcs ? <p className="dwl-note">{u.beforeDwcs} UFC {u.beforeDwcs === 1 ? "bout" : "bouts"} predate this fighter&apos;s first Contender Series appearance.</p> : null}
          <Link href="/contender-series/alumni" className="dwl-link">DWCS Alumni →</Link>
        </div>
      </div>
    </section>
  );
}

/** DWCS event page: where this week's fighters went, by canonical fighter_id. */
export function WhereTheyWent({ alumni, imgs, ranks, eventId }: {
  alumni: DwcsAlum[]; imgs: Map<string, PortraitSet>; ranks: Map<string, FighterRankingContext>; eventId: string;
}) {
  const rows = alumni
    .map((a) => ({ a, onThisCard: a.appearances.find((x) => x.event.id === eventId) }))
    .filter((x) => x.onThisCard)
    .sort((x, y) => y.a.ufc.sinceDwcsFights - x.a.ufc.sinceDwcsFights || x.a.fighter.name.localeCompare(y.a.fighter.name));
  if (!rows.length) return null;
  const reached = rows.filter((x) => x.a.reachedUfc).length;
  return (
    <section className="segment">
      <h3>Where they went <small>{reached} of {rows.length} fighters from this card have fought on a UFC card since</small></h3>
      <div className="dwt">
        {rows.map(({ a }) => (
          <Link key={a.fighter.id} href={`/fighters/${fighterSlug(a.fighter)}`} className={`dwt-row${a.reachedUfc ? " reached" : ""}`}>
            <Avatar f={a.fighter} img={imgs.get(a.fighter.id)} size={40} />
            <span className="dwt-n">{a.fighter.name}<AlumRanks ctx={ranks.get(a.fighter.id)} /></span>
            <span className="dwt-u">
              {a.ufc.sinceDwcsFights
                ? <>{a.ufc.sinceDwcsFights} UFC {a.ufc.sinceDwcsFights === 1 ? "fight" : "fights"} · {a.ufc.sinceDwcsWins} {a.ufc.sinceDwcsWins === 1 ? "win" : "wins"} · last {monthYear(a.ufc.last?.event.eventDate)}</>
                : a.ufc.next ? <>UFC debut booked · {monthYear(a.ufc.next.event.eventDate)}</> : <>No UFC-card bout since</>}
            </span>
          </Link>
        ))}
      </div>
      <p className="dwl-note">Linked by canonical fighter identity, never by name. <Link href="/contender-series/alumni">Every DWCS alum →</Link></p>
    </section>
  );
}
