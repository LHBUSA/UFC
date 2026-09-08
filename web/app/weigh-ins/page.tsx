import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, Empty, JsonLd } from "@/components/ui";
import { getUpcomingEvents } from "@/lib/db";
import {
  getWeighIns, getWeighInSummary, getWeighInHistory, getWeighInEvents, pickDeskEvent,
  RESULT_LABEL, RESULT_TONE, SOURCE_KIND_LABEL,
  weightCell, limitCell, deltaCell, classCell, sortForTable, isLive, freshness,
  updateLine, timelineKind, clockTime, WEIGHIN_REVALIDATE,
  type WeighIn,
} from "@/lib/weighins";
import { fighterSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";
import { WeighInAutoRefresh } from "@/components/WeighInAutoRefresh";
import styles from "./weighins.module.css";

/* The desk re-reads its own cache this often. It bounds cache staleness, NOT
 * data freshness — the source is fetched every few minutes, and the header
 * shows the source's own timestamp rather than this page's render time. */
export const revalidate = 15;

export const metadata: Metadata = {
  title: "UFC Official Weigh-In Results — Live Desk",
  description:
    "Live and recent official UFC weigh-in results: every fighter's scale reading against the applicable limit, misses, catchweights, withdrawals and corrections, each with its source.",
  alternates: { canonical: "/weigh-ins" },
  openGraph: { title: "UFC Weigh-Ins — PropBetEdge", description: "Structured official weigh-in results, updated from sourced readings.", url: `${SITE.url}/weigh-ins` },
  twitter: { card: "summary_large_image", title: "UFC Weigh-Ins — PropBetEdge" },
};

function Row({ w }: { w: WeighIn }) {
  const weight = weightCell(w);
  const limit = limitCell(w);
  const delta = deltaCell(w);
  const tone = RESULT_TONE[w.result];

  return (
    <tr className={styles.row} data-tone={tone}>
      <td className={styles.cFighter}>
        <Link href={`/fighters/${fighterSlug({ name: w.fighter_name, espn_athlete_id: w.fighter_espn_athlete_id, ufcstats_id: w.fighter_ufcstats_id })}`}>
          {w.fighter_name}
        </Link>
        {w.attempt_number > 1 && <span className={styles.attempt}>attempt {w.attempt_number}</span>}
        {w.is_correction && <span className={styles.corrected}>Corrected</span>}
      </td>

      <td className={styles.cBout}>
        {w.card_position && <span className={styles.pos}>{w.card_position}</span>}
        {w.bout_id ? <Link href={`/weigh-ins#bout-${w.bout_id}`}>{w.weight_class_raw || classCell(w)}</Link> : (w.weight_class_raw || "Bout not on file")}
      </td>

      <td className={styles.cClass}>
        <span className={styles.className}>{classCell(w)}</span>
        <span className={limit.known ? styles.limit : styles.limitUnknown}>{limit.text}</span>
        {limit.note && <span className={styles.limitNote}>{limit.note}</span>}
      </td>

      <td className={styles.cWeight}>
        <span className={weight.known ? styles.weight : styles.weightUnknown}>{weight.text}</span>
      </td>

      <td className={styles.cDelta}>
        <span className={delta.over ? styles.over : styles.under}>{delta.text}</span>
      </td>

      <td className={styles.cStatus}>
        <span className={styles.badge} data-tone={tone}>{RESULT_LABEL[w.result]}</span>
        {w.catchweight_lbs != null && <span className={styles.catch}>Catchweight agreed</span>}
      </td>

      <td className={styles.cWhen}>
        {clockTime(w.weighed_at || w.source_published_at) ? (
          <span className={styles.time}>{clockTime(w.weighed_at || w.source_published_at)}</span>
        ) : (
          <span className={styles.timeUnknown}>no timestamp published</span>
        )}
        <a className={styles.src} href={w.source_url} target="_blank" rel="noopener noreferrer nofollow">
          {SOURCE_KIND_LABEL[w.source_kind]} ↗
        </a>
      </td>
    </tr>
  );
}

export default async function WeighInsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const sp = await searchParams;
  const [upcoming, covered] = await Promise.all([
    getUpcomingEvents(6).catch(() => []),
    getWeighInEvents(12).catch(() => []),
  ]);
  const upcomingDesk = upcoming.map((e) => ({ id: e.id, name: e.name, event_date: e.event_date }));
  const selected = sp.event ? covered.find((e) => e.event_id === sp.event) : null;
  const desk = selected
    ? {
        eventId: selected.event_id,
        eventName: selected.event_name,
        eventDate: selected.event_date,
        state: upcomingDesk.some((e) => e.id === selected.event_id) ? "upcoming" as const : "recent" as const,
      }
    : pickDeskEvent(upcomingDesk, covered);

  const [rows, summary, history] = desk
    ? await Promise.all([
        getWeighIns(desk.eventId).catch(() => []),
        getWeighInSummary(desk.eventId).catch(() => null),
        getWeighInHistory(desk.eventId, 40).catch(() => []),
      ])
    : [[], null, []];

  const table = sortForTable(rows);
  const live = isLive(summary);
  const missed = table.filter((r) => r.result === "missed");
  const cutoff = new Date(Date.now() - 21 * 86400e3).toISOString().slice(0, 10);
  const recentCovered = covered.filter((e) => e.event_date && e.event_date >= cutoff);
  const sourceStamp = summary?.newest_source_published_at || summary?.last_source_update || null;
  const sourceStampIsPublisher = Boolean(summary?.newest_source_published_at);

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Weigh-Ins" }]} />
      {/* Browser polls OUR route only. It never touches a publisher: source
          cadence is what determines freshness, and a page that fanned out to
          third parties would multiply their load by our readership. */}
      <WeighInAutoRefresh seconds={WEIGHIN_REVALIDATE} enabled={live} />

      <section className={styles.hero}>
        <div className={styles.heroMain}>
          <div className={styles.eyebrow}>
            <span className={live ? styles.dotLive : styles.dotIdle} aria-hidden="true" />
            {live ? "Live · official weigh-ins" : "Official weigh-ins"}
          </div>
          <h1>Official Weigh-Ins</h1>
          {desk ? (
            <p className={styles.event}>
              {desk.eventName}
              {desk.eventDate && <span className={styles.eventDate}> · {fmtDate(desk.eventDate)}</span>}
              {desk.state === "recent" && <span className={styles.eventNote}> · covered archive</span>}
            </p>
          ) : (
            <p className={styles.event}>No card on file</p>
          )}
          <p className={styles.freshness}>
            {sourceStampIsPublisher ? "Latest source publication" : "Latest verified capture"}: <strong>{freshness(sourceStamp)}</strong>
            <span className={styles.freshNote}>
              {sourceStampIsPublisher
                ? " — from the publisher's retained timestamp."
                : " — the historical source is verified, but its publication time was not retained."}
            </span>
          </p>
        </div>

        <aside className={styles.counters} aria-label="Weigh-in coverage">
          {[
            { n: summary?.expected ?? 0, l: "expected" },
            { n: summary?.weighed ?? 0, l: "weighed" },
            { n: summary?.made ?? 0, l: "made weight", tone: "ok" },
            { n: summary?.missed ?? 0, l: "missed", tone: summary?.missed ? "alert" : undefined },
            { n: summary?.pending ?? 0, l: "pending", tone: "neutral" },
          ].map((c) => (
            <div key={c.l} className={styles.counter} data-tone={c.tone}>
              <b>{c.n}</b><span>{c.l}</span>
            </div>
          ))}
        </aside>
      </section>

      {missed.length > 0 && (
        <section className={styles.missStrip} aria-label="Missed weight">
          <span className={styles.missLabel}>Missed weight</span>
          <ul>{missed.map((m) => <li key={m.id}>{updateLine(m)}</li>)}</ul>
        </section>
      )}

      {table.length ? (
        <div className={styles.layout}>
          <section className={styles.tableWrap} aria-label="Weigh-in results">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Fighter</th><th>Bout</th><th>Weight class / limit</th>
                  <th>Official weight</th><th>Delta</th><th>Status</th><th>Time</th>
                </tr>
              </thead>
              <tbody>{table.map((w) => <Row key={w.id} w={w} />)}</tbody>
            </table>
          </section>

          <aside className={styles.timeline} aria-label="Live timeline">
            <h2>Timeline</h2>
            {history.length ? (
              <ol>
                {history.map((h) => (
                  <li key={h.id} data-kind={h.result}>
                    <span className={styles.tKind}>{timelineKind({ ...(h as unknown as WeighIn), is_correction: Boolean(h.supersedes_id) })}</span>
                    <span className={styles.tLine}>
                      {updateLine({ ...(h as unknown as WeighIn), fighter_name: h.fighter_name })}
                    </span>
                    <span className={styles.tMeta}>
                      {clockTime(h.occurred_at) ?? "time not published"} ·{" "}
                      <a href={h.source_url} target="_blank" rel="noopener noreferrer nofollow">{h.source_name}</a>
                      {h.superseded_at && <em> · later corrected</em>}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.tEmpty}>No readings recorded yet.</p>
            )}
          </aside>
        </div>
      ) : (
        <Empty title="Official weigh-in result not recorded yet">
          <p>
            No sourced scale readings are on file for this card yet. Once an official or verified source publishes them,
            they appear here without guessing a weight or contractual limit.
          </p>
        </Empty>
      )}

      <section className={styles.method} aria-labelledby="recent-weighins-heading">
        <div className="eyebrow">21-day archive · official results</div>
        <h2 id="recent-weighins-heading">Recent official weigh-ins</h2>
        <p className={styles.panelNote}>
          The current desk does not erase the previous card. These are the covered weigh-ins from the last three weeks; select any card to reopen its full fighter table and source trail.
        </p>
        {recentCovered.length ? (
          <div className="grid-3" style={{ marginTop: 16 }}>
            {recentCovered.map((e) => (
              <Link key={e.event_id} href={`/weigh-ins?event=${encodeURIComponent(e.event_id)}`} className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3>{e.event_name}</h3>
                  <span className={styles.eventNote}>{e.event_date ? fmtDate(e.event_date) : "date unavailable"}</span>
                </div>
                <div className={styles.panelCounts}>
                  <span className={styles.panelCount}><b>{e.weighed}</b><span>weighed</span></span>
                  <span className={styles.panelCount} data-tone="ok"><b>{e.made}</b><span>made</span></span>
                  <span className={styles.panelCount} data-tone={e.missed ? "alert" : undefined}><b>{e.missed}</b><span>missed</span></span>
                </div>
                <p className={styles.panelNote}>
                  {e.newest_source_published_at
                    ? `Official source timestamp retained · ${fmtDate(e.newest_source_published_at)}`
                    : "Official source retained · original publication time not retained"}
                </p>
              </Link>
            ))}
          </div>
        ) : (
          <p className={styles.tEmpty}>No official weigh-in cards are on file in the last 21 days.</p>
        )}
      </section>

      <section className={styles.method}>
        <h2>How this desk works</h2>
        <ul>
          <li><strong>Official sources first.</strong> The promotion&rsquo;s own results, then the athletic commission, then established reporting. Every row carries its source and timestamp when the source supplied one.</li>
          <li><strong>A weight class is not a limit.</strong> A lightweight title fight is 155 lb; a non-title bout is 156 with the one-pound allowance; a catchweight is whatever was agreed. Where the contracted limit is not published, this says so and shows no delta.</li>
          <li><strong>Nothing is inferred from a picture of a scale</strong> or from commentary. If a source reports a miss without a figure, the miss is recorded and the number stays empty.</li>
          <li><strong>Corrections are kept.</strong> A revised weight becomes a new reading; the earlier one stays readable and the row is marked corrected.</li>
          <li><strong>Never a blank where it matters.</strong> Not-yet-weighed, withdrew, cancelled and not-published are four different things and each says which.</li>
        </ul>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "UFC Official Weigh-In Results",
        url: `${SITE.url}/weigh-ins`,
        description: "Official UFC weigh-in results with contracted limits, misses, catchweights and corrections.",
        isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
        ...(desk?.eventName ? { about: { "@type": "SportsEvent", name: desk.eventName, startDate: desk.eventDate ?? undefined } } : {}),
      }} />
    </div>
  );
}
