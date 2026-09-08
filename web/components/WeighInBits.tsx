import Link from "next/link";
import {
  RESULT_LABEL, RESULT_TONE, SOURCE_KIND_LABEL,
  weightCell, limitCell, deltaCell, freshness, clockTime,
  type WeighIn, type WeighInSummary,
} from "@/lib/weighins-display";
import { fmtDate } from "@/lib/format";
import styles from "@/app/weigh-ins/weighins.module.css";

/* The weigh-in desk's two satellite surfaces.
 *
 * Both keep the same rule as the desk itself: a missing weight is a sentence
 * saying which kind of missing it is, never a blank and never a zero. On a
 * fight page especially, "0" under a fighter's name would read as a scale
 * reading, and "—" reads as broken UI rather than as "not weighed yet".
 */

/** Event page: live or final coverage for this card. */
export function EventWeighInPanel({
  summary, eventName, missed,
}: {
  summary: WeighInSummary | null;
  eventName: string;
  missed: WeighIn[];
}) {
  if (!summary || summary.expected === 0) return null;
  const live = summary.pending > 0;

  return (
    <section className="segment" id="weigh-ins">
      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <h3>
            <span className={live ? styles.dotLive : styles.dotIdle} aria-hidden="true" style={{ display: "inline-block", marginRight: 8 }} />
            {live ? "Weigh-ins live" : "Weigh-ins final"}
          </h3>
          <Link href="/weigh-ins">Full desk →</Link>
        </div>

        <div className={styles.panelCounts}>
          <div className={styles.panelCount}><b>{summary.expected}</b><span>expected</span></div>
          <div className={styles.panelCount}><b>{summary.weighed}</b><span>weighed</span></div>
          <div className={styles.panelCount} data-tone="ok"><b>{summary.made}</b><span>made</span></div>
          <div className={styles.panelCount} data-tone={summary.missed ? "alert" : undefined}><b>{summary.missed}</b><span>missed</span></div>
          <div className={styles.panelCount}><b>{summary.pending}</b><span>pending</span></div>
        </div>

        {missed.length > 0 && (
          <div className={styles.missStrip} style={{ marginTop: 14, marginBottom: 0 }}>
            <span className={styles.missLabel}>Missed weight</span>
            <ul>
              {missed.map((m) => (
                <li key={m.id}>
                  {m.fighter_name}
                  {m.official_weight_lbs != null ? ` — ${m.official_weight_lbs} lb` : ""}
                  {m.over_by_lbs != null ? ` — over by ${m.over_by_lbs} lb` : " — amount over not published"}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className={styles.panelNote}>
          Official readings for {eventName}. Last source update: {freshness(summary.last_source_update)}.
          {summary.limit_unsupported > 0 && ` ${summary.limit_unsupported} bout(s) have no published contracted limit, so no delta is shown for them.`}
          {summary.corrections > 0 && ` ${summary.corrections} reading(s) were later corrected; the desk shows the latest and keeps the earlier one.`}
        </p>
      </div>
    </section>
  );
}

/**
 * Fight page: the official weight under each corner.
 *
 * Renders even when nothing has been recorded, because "we have no reading"
 * is information a reader of a fight-week page actively wants — and the
 * alternative, omitting the section, is indistinguishable from the feature
 * being broken.
 */
export function BoutWeighIns({
  weighIns, cornerA, cornerB,
}: {
  weighIns: WeighIn[];
  cornerA: { id: string; name: string };
  cornerB: { id: string; name: string };
}) {
  const find = (id: string) => weighIns.find((w) => w.fighter_id === id) || null;
  const rows: Array<[{ id: string; name: string }, WeighIn | null]> = [
    [cornerA, find(cornerA.id)],
    [cornerB, find(cornerB.id)],
  ];
  const anyMiss = rows.some(([, w]) => w?.result === "missed");
  const anyCatch = rows.some(([, w]) => w?.catchweight_lbs != null);

  return (
    <section className="segment" id="weigh-in">
      <h3>
        Official weigh-in
        {anyMiss && <small style={{ color: "#f2879a" }}> · missed weight</small>}
        {anyCatch && <small style={{ color: "var(--pbe-gold-bright)" }}> · catchweight</small>}
      </h3>

      <div className={styles.fightWeights}>
        {rows.map(([corner, w]) => {
          if (!w) {
            return (
              <div key={corner.id} className={styles.fightCorner}>
                <span className={styles.fcName}>{corner.name}</span>
                <span className={styles.fcWeightUnknown}>Official weigh-in result not recorded yet.</span>
              </div>
            );
          }
          const weight = weightCell(w);
          const limit = limitCell(w);
          const delta = deltaCell(w);
          const tone = RESULT_TONE[w.result];
          return (
            <div key={corner.id} className={styles.fightCorner} data-tone={tone}>
              <span className={styles.fcName}>{corner.name}</span>
              <span className={weight.known ? styles.fcWeight : styles.fcWeightUnknown}>{weight.text}</span>
              <span className={styles.fcMeta}>
                {limit.known ? `Limit ${limit.text}` : limit.text}
                {delta.text !== "—" && ` · ${delta.text}`}
              </span>
              <span className={styles.fcBadge} data-tone={tone}>{RESULT_LABEL[w.result]}</span>
              {w.catchweight_lbs != null && <span className={styles.fcMeta}>Catchweight agreed at {w.catchweight_lbs} lb</span>}
              <a className={styles.fcSrc} href={w.source_url} target="_blank" rel="noopener noreferrer nofollow">
                {SOURCE_KIND_LABEL[w.source_kind]}
                {clockTime(w.source_published_at) ? ` · ${clockTime(w.source_published_at)}` : ""}
                {w.is_correction ? " · corrected" : ""} ↗
              </a>
            </div>
          );
        })}
      </div>
    </section>
  );
}
