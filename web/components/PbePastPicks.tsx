import Link from "next/link";
import { Avatar } from "@/components/ui";
import { getImagesForFighters, type PortraitSet } from "@/lib/db";
import { getAlgoRecentGradedPicks, type AlgoArchiveEvent, type ArchivePick } from "@/lib/algo";
import { confidenceCopy, deltaText, lockedText, oddsText, pctText } from "@/lib/algoView";
import { fmtDate } from "@/lib/format";

/* Past Picks: the browsable half of the public track record.
 *
 * Server-rendered from sanitized ArchivePick rows, which exist only for picks
 * that are officially locked AND currently graded (lib/algo.ts archivePicks).
 * An event still awaiting grades shows counts, never a selection. Expansion is
 * native <details>: it needs no client state, survives the page's one-minute
 * server refresh (React leaves an unchanged `open` attribute alone) and works
 * with scripting off. Portraits are decoration: a missing one renders the
 * monogram avatar and never holds the row back. */

type Portraits = Map<string, PortraitSet>;

export const eventHref = (eventId: string) => `/algo/record?event=${encodeURIComponent(eventId)}#event-${eventId}`;
export const pickHref = (predictionId: string) => `/algo/record?pick=${encodeURIComponent(predictionId)}#pick-${predictionId}`;

export function unitsText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
}
const modelLabel = (v: string) => v.replace(/^pbe-fight-model-v/i, "PBE Fight Model V");
const stamp = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—");

const STATUS_COPY: Record<AlgoArchiveEvent["status"], string> = {
  AWAITING_RESULTS: "Locked · awaiting results",
  GRADING: "Grading in progress",
  GRADING_OVERDUE: "Grading overdue",
  GRADED: "Graded",
};

export function ResultBadge({ result }: { result: ArchivePick["result"] }) {
  return <span className={`pbe-proof-result ${result.toLowerCase()}`}>{result}</span>;
}

export function PastPickRow({ pick, imgs, focus = false, context }: { pick: ArchivePick; imgs: Portraits; focus?: boolean; context?: { event_name: string; event_date: string | null } }) {
  const matchup = `${pick.fighter_a.name} vs ${pick.fighter_b.name}`;
  const corrected = pick.revisions.length > 1;
  return (
    <article id={`pick-${pick.prediction_id}`} className={`pp-past-pick${focus ? " focus" : ""}`} data-result={pick.result}>
      <div className="pp-past-pick-main">
        <Avatar f={pick.pick} img={imgs.get(pick.pick.id)} size={44} />
        <div className="pp-past-pick-id">
          {context && <span className="pp-past-pick-event">{context.event_name}{context.event_date ? ` · ${fmtDate(context.event_date, { month: "short", day: "numeric", year: "numeric" })}` : ""}</span>}
          <span className="pp-past-pick-matchup">{pick.fight_slug ? <Link href={`/fights/${pick.fight_slug}`}>{matchup}</Link> : matchup}</span>
          <span className="pp-past-pick-sel"><i>PBE Pick</i><b>{pick.pick.name}</b></span>
        </div>
        <dl className="pp-past-pick-nums">
          <div><dt>Locked odds</dt><dd>{oddsText(pick.lock_price)}</dd></div>
          <div><dt>Result</dt><dd><ResultBadge result={pick.result} />{corrected && <em title="This grade has been corrected; every revision is listed in the details.">corrected</em>}</dd></div>
          <div><dt>Net units</dt><dd className={pick.net_units == null ? "" : pick.net_units > 0 ? "pos" : "neg"}>{unitsText(pick.net_units)}</dd></div>
        </dl>
      </div>
      <details className="pp-past-pick-more" open={focus || undefined}>
        <summary>Lock &amp; grading details</summary>
        <dl>
          <div><dt>Locked (database clock)</dt><dd>{lockedText(pick.locked_at)}<small>{stamp(pick.locked_at)}</small></dd></div>
          <div><dt>Model probability</dt><dd>{pctText(pick.pick_probability)}<small>band {pick.confidence_band}</small></dd></div>
          <div><dt>Confidence</dt><dd>{pick.confidence ? confidenceCopy(pick.confidence) : "—"}</dd></div>
          <div><dt>Model version</dt><dd>{modelLabel(pick.model_version)}<small>{pick.feature_version}</small></dd></div>
          <div><dt>Lock price source</dt><dd>{pick.lock_price == null ? "No valid lock-time price stored" : `${oddsText(pick.lock_price)}${pick.lock_book ? ` at ${pick.lock_book}` : ""}`}<small>{pick.lock_price == null ? "Counts in W-L; excluded from units and ROI" : `best available price in the frozen lock-time snapshot${pick.consensus_odds != null ? ` · consensus ${oddsText(pick.consensus_odds)}` : ""}`}</small></dd></div>
          <div><dt>Market snapshot</dt><dd>{pick.market_observed_at ? stamp(pick.market_observed_at) : "—"}<small>{[pick.market_source, pick.market_books != null ? `${pick.market_books} books` : null, pick.market_implied_prob != null ? `market ${pctText(pick.market_implied_prob)}` : null, pick.model_edge_pts != null ? `PBE Edge ${deltaText(pick.model_edge_pts)}` : null].filter(Boolean).join(" · ") || "no market comparison stored at lock"}</small></dd></div>
        </dl>
        <div className="pp-past-revisions">
          <h4>Grading revisions</h4>
          <ol>
            {pick.revisions.map((r) => (
              <li key={r.revision} className={r.revision === pick.revisions[pick.revisions.length - 1].revision ? "current" : "superseded"}>
                <b>r{r.revision} · {r.result}</b>
                <span>{stamp(r.graded_at)}{r.source ? ` · ${r.source}` : ""}{r.method ? ` · ${r.method}` : ""}</span>
                {r.revision_reason && <em>{r.revision_reason}</em>}
                {r.revision !== pick.revisions[pick.revisions.length - 1].revision && <small>superseded</small>}
              </li>
            ))}
          </ol>
        </div>
        <Link href={pickHref(pick.prediction_id)} className="pp-past-permalink">Permanent link to this pick</Link>
      </details>
    </article>
  );
}

export function PastPicksEvent({ event, open, imgs, focusPick }: { event: AlgoArchiveEvent; open: boolean; imgs: Portraits; focusPick: string | null }) {
  const graded = event.locked - event.pending;
  return (
    <details id={`event-${event.event_id}`} className={`pp-past-event status-${event.status.toLowerCase()}`} open={open || undefined}>
      <summary>
        <span className="pp-past-event-head">
          <span className="pp-past-event-date">{event.event_date ? fmtDate(event.event_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Date not resolved"}</span>
          <strong>{event.event_name}</strong>
          <span className={`pp-past-status ${event.status.toLowerCase()}`}>{STATUS_COPY[event.status]}</span>
        </span>
        <span className="pp-past-event-stats">
          {([
            ["Official picks", String(event.locked), ""],
            ["W-L", event.decided ? `${event.wins}-${event.losses}` : "—", ""],
            ["Pending", String(event.pending), ""],
            ["No decision", String(event.no_decision), ""],
            ["Net units", unitsText(event.net_units), event.net_units == null ? "" : event.net_units > 0 ? "pos" : event.net_units < 0 ? "neg" : ""],
            ["ROI", pctText(event.roi), ""],
            ["Priced", `${event.priced_decided}/${event.decided}`, ""],
          ] as const).map(([label, value, tone]) => <span key={label}><i>{label}</i><b className={tone}>{value}</b></span>)}
        </span>
        <span className="pp-past-toggle" aria-hidden="true" />
      </summary>
      <div className="pp-past-event-body">
        {event.pending > 0 && (
          <p className={`pp-past-pending${event.status === "GRADING_OVERDUE" ? " overdue" : ""}`}>
            {event.status === "AWAITING_RESULTS"
              ? `${event.pending} official pick${event.pending === 1 ? " is" : "s are"} locked for this card. Selections stay with UFC Pro until each bout is officially graded, then appear here automatically.`
              : event.status === "GRADING_OVERDUE"
                ? `${event.pending} official pick${event.pending === 1 ? " is" : "s are"} still ungraded after this card's date. They remain pending in every total on this page; nothing is assumed until the official grade is recorded.`
                : `${graded} of ${event.locked} official picks graded so far. The remaining ${event.pending} appear${event.pending === 1 ? "s" : ""} automatically with ${event.pending === 1 ? "its" : "their"} official grade; this card is not complete.`}
          </p>
        )}
        {event.picks.length > 0 && <div className="pp-past-list">{event.picks.map((p) => <PastPickRow key={p.prediction_id} pick={p} imgs={imgs} focus={p.prediction_id === focusPick} />)}</div>}
        <div className="pp-past-event-foot">
          {event.event_slug && <Link href={`/events/${event.event_slug}`}>Event page</Link>}
          <Link href={eventHref(event.event_id)}>Permanent link to this event</Link>
          {event.corrected > 0 && <span>{event.corrected} corrected grade{event.corrected === 1 ? "" : "s"}</span>}
          {event.model_versions.length > 0 && <span>{event.model_versions.map(modelLabel).join(" · ")}</span>}
        </div>
      </div>
    </details>
  );
}

export function PastPicksPager({ page, pages, model }: { page: number; pages: number; model: string | null }) {
  if (pages <= 1) return null;
  const href = (n: number) => { const q = new URLSearchParams(); if (n > 1) q.set("page", String(n)); if (model) q.set("model", model); const s = q.toString(); return `/algo/record${s ? `?${s}` : ""}#past-picks`; };
  const near = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <nav className="pp-past-pager" aria-label="Past picks pages">
      {page > 1 ? <Link href={href(page - 1)} rel="prev">← Newer</Link> : <span aria-disabled="true">← Newer</span>}
      <ol>
        {near.map((n, i) => (
          <li key={n}>
            {i > 0 && n - near[i - 1] > 1 && <span className="gap" aria-hidden="true">…</span>}
            {n === page ? <b aria-current="page">{n}</b> : <Link href={href(n)}>{n}</Link>}
          </li>
        ))}
      </ol>
      {page < pages ? <Link href={href(page + 1)} rel="next">Older →</Link> : <span aria-disabled="true">Older →</span>}
    </nav>
  );
}

/** PBE Picks page: the five latest graded results under the tracker. Reads only
 *  publicly graded picks (and shares the request's archive index with the tracker
 *  through React cache), so it renders the same rows for every reader. */
export async function RecentGradedPicks({ count = 5 }: { count?: number }) {
  const picks = await getAlgoRecentGradedPicks(count);
  const imgs: Portraits = picks?.length ? await getImagesForFighters([...new Set(picks.map((p) => p.pick.id))]).catch(() => new Map<string, PortraitSet>()) : new Map();
  return (
    <section className="pp-recent" aria-labelledby="pp-recent-h">
      <header>
        <div>
          <span className="eyebrow">Latest official results</span>
          <h2 id="pp-recent-h">Recent graded picks</h2>
        </div>
        <Link href="/algo/record#past-picks" className="btn">Browse All Past Picks →</Link>
      </header>
      {picks == null ? (
        <p className="pp-past-pending overdue">Recent results could not be read right now. The record itself is unchanged; this list returns on the next refresh.</p>
      ) : picks.length === 0 ? (
        <p className="pp-past-pending">The first officially graded pick appears here automatically.</p>
      ) : (
        <div className="pp-past-list">{picks.map((p) => <PastPickRow key={p.prediction_id} pick={p} imgs={imgs} context={{ event_name: p.event_name, event_date: p.event_date }} />)}</div>
      )}
      <p className="pp-recent-note">The latest results in the order they were graded, wins and losses alike. Current picks stay with UFC Pro until they are graded.</p>
    </section>
  );
}
