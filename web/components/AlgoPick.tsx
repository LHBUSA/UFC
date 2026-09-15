import Link from "next/link";
import {
  FEATURES_TOTAL, REASON_COPY, algoStatus, pickOriented, bandEvidence, confidenceCopy, deltaText, drivers, lockedText, pctText, marketView, ageText,
  type AlgoBoutView, type Driver,
} from "@/lib/algoView";

/* PBE Algo call card. UFC Pro only: it is rendered exclusively by pages that
 * fetched the bout through lib/algo.ts, which refuses a non-Pro caller, so a
 * free render has no pick to pass in. */

const LOG_FEATURES = /log|quality_wins|five_round|title_exp/;
const RATE_FEATURES = new Set(["winrate_diff", "recent5_winrate_diff", "sig_accuracy_diff", "sig_defense_diff", "td_accuracy_diff", "td_defense_diff", "control_share_diff", "finish_rate_diff", "ko_rate_diff", "sub_rate_diff", "ko_loss_rate_diff", "sub_loss_rate_diff", "sos_diff", "pace_retention_diff"]);
const signed = (v: number, dp: number, unit = "") => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}${unit}`;

function driverValue(d: Driver): string | null {
  if (LOG_FEATURES.test(d.key)) return null;
  if (d.key === "southpaw_edge") return d.pickMinusOpponent > 0 ? "only southpaw" : d.pickMinusOpponent < 0 ? "opponent only southpaw" : null;
  if (RATE_FEATURES.has(d.key)) return signed(d.pickMinusOpponent * 100, 1, " pts");
  if (d.key === "age_diff_years") return signed(d.pickMinusOpponent, 1, " yrs");
  if (d.key === "reach_diff_in" || d.key === "height_diff_in") return signed(d.pickMinusOpponent, 1, " in");
  if (d.key === "streak_diff") return signed(d.pickMinusOpponent, 0);
  return signed(d.pickMinusOpponent, 2);
}

function DriverList({ title, items, tone, max }: { title: string; items: Driver[]; tone: "for" | "against"; max: number }) {
  return (
    <div className={`algo-drivers ${tone}`}>
      <h4>{title}</h4>
      {items.length ? (
        <ol>
          {items.map((d) => {
            const v = driverValue(d);
            return (
              <li key={d.key} title={d.doc}>
                <div className="algo-driver-top"><span>{d.label}</span>{v && <b>{v}</b>}</div>
                <span className="algo-driver-bar" aria-hidden><i style={{ width: `${Math.min(100, (Math.abs(d.contribution) / max) * 100)}%` }} /></span>
                <p>{d.doc}</p>
              </li>
            );
          })}
        </ol>
      ) : <p className="algo-empty">No feature pushed {tone === "for" ? "toward" : "against"} this pick.</p>}
    </div>
  );
}

export function AlgoPick({ b, detail = false, showEvent = false }: { b: AlgoBoutView; detail?: boolean; showEvent?: boolean }) {
  const status = algoStatus(b);
  const pickName = b.pick_fighter_id === b.fighter_a.id ? b.fighter_a.name : b.pick_fighter_id === b.fighter_b.id ? b.fighter_b.name : null;
  const oppName = pickName === b.fighter_a.name ? b.fighter_b.name : b.fighter_a.name;
  const p = b.prediction;
  const prob = p ? p.pick_probability : b.pick_probability;
  /* A locked call's official comparison is its stored FRESH columns; anything
   * else is shown with its status and age, never as a current edge. */
  const mv = marketView(b.market);
  const lockedOfficial = p?.locked_at && p.model_edge_pts != null;
  const marketPick = lockedOfficial ? p!.market_implied_prob_pick : mv.implied;
  const delta = lockedOfficial ? p!.model_edge_pts : mv.delta;
  const marketStatus = lockedOfficial ? "FRESH" : mv.status;
  const called = b.decision === "ELIGIBLE" && pickName && prob != null;
  const dr = p && called ? drivers(p, b.fighter_a.id, b.fighter_b.id) : null;
  const maxC = dr ? Math.max(1e-9, ...dr.supporting.map((d) => d.contribution), ...dr.opposing.map((d) => -d.contribution)) : 1;
  const ev = called ? bandEvidence(prob) : null;
  const features = p ? Object.values(p.feature_availability || {}).filter(Boolean).length : b.features_available;

  return (
    <article className={`algo-card ${status.tone}${detail ? " detail" : ""}`} data-algo-bout={b.bout_id}>
      <header className="algo-card-head">
        <div className="algo-card-kicker">
          {showEvent && <><Link href={`/events/${b.event_slug}`}>{b.event_name}</Link> · </>}
          {b.card_position === "main" ? "Main card" : b.card_position === "prelim" ? "Prelims" : b.card_position === "early" ? "Early prelims" : "Card"}
        </div>
        <span className={`algo-status ${status.tone}`}>{status.label}</span>
      </header>
      <h3 className="algo-matchup"><Link href={`/fights/${b.fight_slug}`}>{b.fighter_a.name} <span>vs</span> {b.fighter_b.name}</Link></h3>

      {called ? (
        <>
          <dl className="algo-grid">
            <div className="algo-cell pick"><dt>Pick</dt><dd>{pickName}</dd></div>
            <div className="algo-cell"><dt>Win probability</dt><dd>{pctText(prob)}</dd></div>
            <div className="algo-cell"><dt>Confidence</dt><dd>{confidenceCopy(b.confidence)}</dd></div>
            <div className="algo-cell"><dt>Data quality</dt><dd>{features ?? "—"}/{FEATURES_TOTAL}</dd></div>
            <div className="algo-cell"><dt>Model</dt><dd className="mono">{b.model_version ?? "—"}</dd></div>
            <div className="algo-cell"><dt>Locked</dt><dd>{p?.locked_at ? lockedText(p.locked_at) : "Not yet locked"}</dd></div>
            <div className="algo-cell"><dt>Market implied</dt><dd>{marketStatus === "UNAVAILABLE" || marketPick == null ? "No line" : marketStatus === "STALE" ? <>Stale <span className="algo-stale">({ageText(mv.age)} old)</span></> : pctText(marketPick)}</dd></div>
            <div className={`algo-cell delta ${delta == null ? "" : delta >= 0 ? "pos" : "neg"}`}><dt>PBE delta</dt><dd>{delta != null ? deltaText(delta) : "—"}</dd></div>
          </dl>
          <div className="algo-probbar" role="img" aria-label={`${pickName} ${pctText(prob)}, ${oppName} ${pctText(1 - (prob as number))}`}>
            <span style={{ width: `${(prob as number) * 100}%` }}>{pickName}</span>
            <span>{oppName} {pctText(1 - (prob as number))}</span>
          </div>
          {!p?.locked_at && <p className="algo-note">Provisional. The call regenerates hourly from the latest pre-fight data and locks once, on the database clock, the afternoon before fight day (after official weigh-ins). A provisional call is not part of the record.</p>}
          {marketStatus === "FRESH" && mv.books != null && <p className="algo-note">Market: de-vigged consensus of {mv.books} book{mv.books === 1 ? "" : "s"} (raw implied {pctText(mv.raw)}), prices observed {mv.observedAt ? lockedText(mv.observedAt) : "—"}. The market is compared with the model after scoring and is never a model input.</p>}
          {marketStatus === "STALE" && <p className="algo-note algo-market-stale">Market comparison stale: the newest price on file is {ageText(mv.age)} old{mv.observedAt ? ` (observed ${lockedText(mv.observedAt)})` : ""}, beyond the 60-minute limit. No PBE delta is published from it. The model call does not depend on the market.</p>}
        </>
      ) : b.decision === "NO_MODEL_CALL" ? (
        <div className="algo-nocall">
          <b>Why there is no call</b>
          <ul>{b.reasons.map((r) => <li key={r}>{REASON_COPY[r] || r}</li>)}</ul>
        </div>
      ) : (
        <p className="algo-note">Not evaluated yet. Every UFC bout inside the 14-day horizon is scored hourly; this one has no evaluation on record.</p>
      )}

      {b.grade && (
        <p className={`algo-grade ${b.grade.result.toLowerCase()}`}>
          Graded <b>{b.grade.result}</b>{b.grade.revision > 1 ? ` · revision ${b.grade.revision}${b.grade.revision_reason ? `: ${b.grade.revision_reason}` : ""}` : ""}
        </p>
      )}

      {called && (
        <details className="algo-why" open={detail}>
          <summary>Why the Algo leans this way</summary>
          {dr ? (
            <div className="algo-why-grid">
              <DriverList title="Strongest drivers" items={dr.supporting} tone="for" max={maxC} />
              <DriverList title="Factors against" items={dr.opposing} tone="against" max={maxC} />
            </div>
          ) : <p className="algo-note">Feature-level drivers appear once a draft with its stored feature vector exists.</p>}
          <div className="algo-facts">
            <div><h4>Sample completeness</h4><p>{features ?? "—"} of {FEATURES_TOTAL} features available. Thinnest corner: {b.sample?.min_prior_bouts ?? "—"} prior bouts on record, {b.sample?.min_stat_bouts ?? "—"} with round statistics.</p></div>
            {ev && (
              <div>
                <h4>Uncertainty</h4>
                <p>In the walk-forward backtest, {ev.n.toLocaleString("en-US")} picks in the {ev.band}% band won {pctText(ev.hitRate)} (95% interval {pctText(ev.lo)}–{pctText(ev.hi)}). Backtest evidence, not the live record.</p>
              </div>
            )}
            {p && (() => {
              const sos = pickOriented(p, b.fighter_a.id, b.fighter_b.id, "sos_diff");
              return sos == null ? null : (
                <div><h4>Opponent quality</h4><p>{pickName}&apos;s past opponents carried a pre-fight win rate {Math.abs(sos * 100).toFixed(1)} pts {sos >= 0 ? "higher" : "lower"} than {oppName}&apos;s, each measured on the date they were fought.</p></div>
              );
            })()}
            <div><h4>Fight DNA matchup</h4><p><Link href={`/fights/${b.fight_slug}#dna-matchup`}>Open the full Fight DNA matchup</Link> for the style profile behind these numbers.</p></div>
          </div>
        </details>
      )}
    </article>
  );
}
