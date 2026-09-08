import Link from "next/link";
import {
  STATUS_LABEL, SOURCE_KIND_LABEL, UNAVAILABLE,
  diagnosisLine, hasDiagnosis, statusHeadline, fighterRef,
  type StatusEvent, type CardChange,
} from "@/lib/status";
import { fighterSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import styles from "@/app/injuries/injuries.module.css";

/* The three places availability shows up outside /injuries.
 *
 * All of them share one rule with the tracker page: a missing diagnosis is
 * rendered as a sentence saying nobody stated one, never as a blank and never
 * as a placeholder that reads like a fact. The whole point of the system is
 * that a reader can tell what we know from what we do not.
 */

/** Fighter profile: current availability plus the history behind it. */
export function FighterStatusSection({ events }: { events: StatusEvent[] }) {
  if (!events.length) return null;
  const current = events.find((e) => e.state === "active" && UNAVAILABLE.has(e.status_type)) || null;
  const history = events.filter((e) => e !== current);

  return (
    <section className={styles.section} id="status">
      <div className={styles.sectionHead}>
        <h2>Status &amp; availability</h2>
        <p>Sourced availability changes. Where a report does not name an injury, this says so.</p>
      </div>

      {current && (
        <div className={styles.row} data-state="active" data-type={current.status_type} style={{ marginBottom: 10 }}>
          <div className={styles.rowMain}>
            <div className={styles.badges}>
              <span className={styles.type} data-type={current.status_type}>{STATUS_LABEL[current.status_type]}</span>
              <span className={styles.flag}>Currently unavailable</span>
              {current.source_kind === "official" && <span className={styles.official}>Official</span>}
            </div>
            <p className={styles.headline} style={{ marginTop: 8 }}>{statusHeadline(current)}</p>
            <p className={hasDiagnosis(current) ? styles.diagnosis : styles.noDiagnosis}>{diagnosisLine(current)}</p>
            {hasDiagnosis(current) && current.clinical_quote && (
              <blockquote className={styles.quote}>{current.clinical_quote}</blockquote>
            )}
            {current.expected_return_note && <p className={styles.rel}>Expected back: {current.expected_return_note}</p>}
          </div>
          <div className={styles.rowMeta}>
            <span className={styles.when}>{fmtDate(current.occurred_at)}</span>
            <a className={styles.source} href={current.source_url} target="_blank" rel="noopener noreferrer nofollow">
              {SOURCE_KIND_LABEL[current.source_kind]} · {current.source_name} ↗
            </a>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className={styles.list} style={{ margin: 0 }}>
          {history.map((e) => (
            <article key={e.id} className={styles.row} data-state={e.state} data-type={e.status_type}>
              <div className={styles.rowMain}>
                <div className={styles.badges}>
                  <span className={styles.type} data-type={e.status_type}>{STATUS_LABEL[e.status_type]}</span>
                  {e.state !== "active" && <span className={styles.state}>{e.state === "resolved" ? "Resolved" : "Expired"}</span>}
                </div>
                <p className={styles.headline} style={{ marginTop: 8 }}>{statusHeadline(e)}</p>
                {(e.status_type === "injury" || e.status_type === "illness" || e.status_type === "withdrawal") && (
                  <p className={hasDiagnosis(e) ? styles.diagnosis : styles.noDiagnosis}>{diagnosisLine(e)}</p>
                )}
              </div>
              <div className={styles.rowMeta}>
                {e.event_name && <span className={styles.event}>{e.event_name}</span>}
                <span className={styles.when}>{fmtDate(e.occurred_at)}</span>
                <a className={styles.source} href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">
                  {SOURCE_KIND_LABEL[e.source_kind]} ↗
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** Event page: what changed on this card. */
export function EventCardChanges({ changes }: { changes: CardChange[] }) {
  if (!changes.length) return null;
  return (
    <section className={styles.section} id="card-changes">
      <div className={styles.sectionHead}>
        <h2>Card changes</h2>
        <p>Withdrawals, replacements and other sourced changes to this card, newest first.</p>
      </div>
      <div className={styles.list} style={{ margin: 0 }}>
        {changes.map((c) => (
          <article key={c.id} className={styles.row} data-state={c.state} data-type={c.status_type}>
            <div className={styles.rowMain}>
              <div className={styles.badges}>
                <span className={styles.type} data-type={c.status_type}>{STATUS_LABEL[c.status_type]}</span>
                {c.state !== "active" && <span className={styles.state}>{c.state === "resolved" ? "Resolved" : "Expired"}</span>}
                {c.source_kind === "official" && <span className={styles.official}>Official</span>}
              </div>
              <h3><Link href={`/fighters/${fighterSlug(fighterRef(c))}`}>{c.fighter_name}</Link></h3>
              {c.replaced_fighter_name && <p className={styles.rel}>Stepping in for {c.replaced_fighter_name}</p>}
              {c.replacement_fighter_name && <p className={styles.rel}>Replaced by {c.replacement_fighter_name}</p>}
              {(c.status_type === "injury" || c.status_type === "illness" || c.status_type === "withdrawal") && (
                <p className={c.injury_type ? styles.diagnosis : styles.noDiagnosis}>
                  {diagnosisLine({ injury_type: c.injury_type, body_part: c.body_part, injury_side: null })}
                </p>
              )}
            </div>
            <div className={styles.rowMeta}>
              <span className={styles.when}>{fmtDate(c.occurred_at)}</span>
              <a className={styles.source} href={c.source_url} target="_blank" rel="noopener noreferrer nofollow">
                {SOURCE_KIND_LABEL[c.source_kind]} · {c.source_name} ↗
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * Matchup page: an alert when this specific bout has been affected.
 *
 * Only for bouts that have NOT happened. A withdrawal from a fight that was
 * contested six months ago is history and belongs on the fighter timeline; put
 * it at the top of a completed matchup page and it reads as though the fight
 * everyone can see the result of is in doubt.
 */
export function BoutStatusAlert({ events, settled }: { events: StatusEvent[]; settled: boolean }) {
  const live = events.filter((e) => e.state === "active");
  if (settled || !live.length) return null;

  return (
    <aside className={styles.row} data-type={live[0].status_type} role="status" style={{ marginBottom: 16 }}>
      <div className={styles.rowMain}>
        <div className={styles.badges}>
          <span className={styles.type} data-type={live[0].status_type}>Card change</span>
          {live[0].source_kind === "official" && <span className={styles.official}>Official</span>}
        </div>
        {live.map((e) => (
          <div key={e.id}>
            <p className={styles.headline} style={{ marginTop: 8 }}>{statusHeadline(e)}</p>
            {(e.status_type === "injury" || e.status_type === "illness" || e.status_type === "withdrawal") && (
              <p className={hasDiagnosis(e) ? styles.diagnosis : styles.noDiagnosis}>{diagnosisLine(e)}</p>
            )}
            {e.replacement_fighter_name && <p className={styles.rel}>Replaced by {e.replacement_fighter_name}</p>}
          </div>
        ))}
      </div>
      <div className={styles.rowMeta}>
        <span className={styles.when}>{fmtDate(live[0].occurred_at)}</span>
        <a className={styles.source} href={live[0].source_url} target="_blank" rel="noopener noreferrer nofollow">
          {SOURCE_KIND_LABEL[live[0].source_kind]} · {live[0].source_name} ↗
        </a>
        <Link className={styles.source} href="/injuries">All card changes →</Link>
      </div>
    </aside>
  );
}
