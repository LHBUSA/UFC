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
import { eventSlug, fighterSlug } from "@/lib/slug";
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
    "Live official UFC weigh-in results: every fighter's scale reading against the contracted limit, misses, catchweights, withdrawals and corrections, each with the source that published it.",
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

export default async function WeighInsPage() {
  const [upcoming, covered] = await Promise.all([
    getUpcomingEvents(6).catch(() => []),
    getWeighInEvents(8).catch(() => []),
  ]);
  const desk = pickDeskEvent(upcoming.map((e) => ({ id: e.id, name: e.name, event_date: e.event_date })), covered);

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
              {desk.state === "recent" && <span className={styles.eventNote}> · most recent card with results</span>}
            </p>
          ) : (
            <p className={styles.event}>No card on file</p>
          )}
          <p className={styles.freshness}>
            Last source update: <strong>{freshness(summary?.last_source_update ?? null)}</strong>
            <span className={styles.freshNote}>
              {" "}— from the publisher&rsquo;s own timestamp, not this page&rsquo;s. Sources are fetched every few minutes during a weigh-in window.
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
        /* Impossible to overlook, without turning the page into an emergency
           screen: one banded strip at the top, the rest of the desk normal. */
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
            <h2>Live timeline</h2>
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
            The weigh-in tables are defined but not yet populated in this environment. Readings appear here as they
            are published — each one with the source that published it, and never a figure we inferred.
          </p>
        </Empty>
      )}

      <section className={styles.method}>
        <h2>How this desk works</h2>
        <ul>
          <li><strong>Official sources first.</strong> The promotion&rsquo;s own results, then the athletic commission, then established reporting. Every row carries its source and timestamp.</li>
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
