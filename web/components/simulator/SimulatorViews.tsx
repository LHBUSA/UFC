/* PBE Fight Simulator presentation (server components, no client JS).
 * Every number rendered here comes from lib/simulatorView.ts, which reads the
 * simulator artifact; outputs Phase 3 did not validate are never rendered. */
import Link from "next/link";
import type { SimArtifact } from "@/lib/vendor/sim-engine/simulate.mjs";
import {
  COVERAGE_LABEL, MODEL_CARD, RANGE_STATS, UNAVAILABLE_COPY, coverageLine, gateReasons, methodRows, pathView, pct, roundRanges, simGate, winView,
  type SimGate,
} from "@/lib/simulatorView";
import s from "@/app/simulator/simulator.module.css";

export type Side = "fighter_1" | "fighter_2";

const other = (x: Side): Side => (x === "fighter_1" ? "fighter_2" : "fighter_1");

export function GateBadge({ gate }: { gate: SimGate }) {
  const label = gate === "FULL" ? "FULL" : gate === "LIMITED" ? "LIMITED" : "INSUFFICIENT DATA";
  return <span className={`${s.gate} ${gate === "FULL" ? s.gateFull : gate === "LIMITED" ? s.gateLimited : s.gateNone}`} data-sim-gate={gate}>{label}</span>;
}

export function TierChip({ tier }: { tier: string | null }) {
  const t = tier || "none";
  return <span className={`${s.tier} ${s[`tier_${t}`] || ""}`} data-sim-tier={t}>{COVERAGE_LABEL[t] || t}</span>;
}

export function WinProbability({ a, left, names }: { a: SimArtifact; left: Side; names: Record<Side, string> }) {
  const w = winView(a);
  const lp = left === "fighter_1" ? w.f1 : w.f2, rp = left === "fighter_1" ? w.f2 : w.f1;
  return (
    <section className={`${s.card} ${s.win}`} aria-labelledby="sim-win">
      <div className={s.cardHead}><h2 id="sim-win" className={s.h2}>Win probability</h2><span className={s.model}>MODEL</span></div>
      <div className={s.winNums}>
        <div><div className={s.bigPct} data-sim-win={left}>{pct(lp)}</div><div className={s.winName}>{names[left]}</div></div>
        <div className={s.winR}><div className={s.bigPct} data-sim-win={other(left)}>{pct(rp)}</div><div className={s.winName}>{names[other(left)]}</div></div>
      </div>
      <div className={s.bar} role="img" aria-label={`${names[left]} ${pct(lp)}, draw ${pct(w.draw)}, ${names[other(left)]} ${pct(rp)}`}>
        <span className={s.barL} style={{ width: `${lp * 100}%` }} />
        <span className={s.barD} style={{ width: `${w.draw * 100}%` }} />
        <span className={s.barR} style={{ width: `${rp * 100}%` }} />
      </div>
      <p className={s.note}>Draw {pct(w.draw)} of 10,000 simulated fights. The simulator is anchored to the PBE Fight Model&apos;s pre-fight probability ({pct(a.anchor?.champion_probability)} for {names.fighter_1}), so the winner split and the official model agree; the fight engine adds how the fight tends to unfold.</p>
    </section>
  );
}

export function OutcomeDistribution({ a, left, names }: { a: SimArtifact; left: Side; names: Record<Side, string> }) {
  const { rows, draw } = methodRows(a);
  const side = (r: (typeof rows)[number], x: Side) => (x === "fighter_1" ? r.f1 : r.f2);
  return (
    <section className={s.card} aria-labelledby="sim-methods">
      <div className={s.cardHead}><h2 id="sim-methods" className={s.h2}>Outcome distribution</h2><span className={s.limited}>LIMITED</span></div>
      <table className={s.table}>
        <thead><tr><th scope="col">How it ends</th><th scope="col">All fights</th><th scope="col">{names[left]}</th><th scope="col">{names[other(left)]}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-sim-method={r.key}>
              <th scope="row">{r.label}</th>
              <td className={s.num}>{pct(r.total)}</td><td className={s.num}>{pct(side(r, left))}</td><td className={s.num}>{pct(side(r, other(left)))}</td>
            </tr>
          ))}
          <tr data-sim-method="DRAW"><th scope="row">Draw</th><td className={s.num}>{pct(draw)}</td><td /><td /></tr>
        </tbody>
      </table>
      <p className={s.note}>Share of 10,000 simulated fights ending each way. This is a distribution, not a method pick: the most common outcome is still usually less likely than all the others combined. Validated against weight-class base rates (method log loss {MODEL_CARD.rows[1].simulator} vs {MODEL_CARD.rows[1].baseline}); knockout shares still run slightly high.</p>
    </section>
  );
}

export function GoesDistance({ a }: { a: SimArtifact }) {
  return (
    <section className={`${s.card} ${s.distance}`} aria-labelledby="sim-distance">
      <div className={s.cardHead}><h2 id="sim-distance" className={s.h2}>Goes the distance</h2><span className={s.limited}>LIMITED</span></div>
      <div className={s.bigPct} data-sim-distance="">{pct(a.probabilities?.goes_distance)}</div>
      <p className={s.note}>Share of simulated fights reaching the judges ({a.scheduled_rounds} rounds scheduled). Includes draws.</p>
    </section>
  );
}

export function VolumeRanges({ a, left, names }: { a: SimArtifact; left: Side; names: Record<Side, string> }) {
  const rows = roundRanges(a);
  if (!rows.length) return null;
  const pickSide = (r: (typeof rows)[number], x: Side) => (x === "fighter_1" ? r.f1 : r.f2);
  return (
    <section className={s.card} aria-labelledby="sim-rounds">
      <div className={s.cardHead}><h2 id="sim-rounds" className={s.h2}>Round volume ranges</h2><span className={s.limited}>LIMITED</span></div>
      <div className={s.rangeGrid}>
        {rows.map((r) => (
          <div key={r.round} className={s.rangeRound}>
            <div className={s.rangeHead}>Round {r.round}</div>
            {[left, other(left)].map((x) => (
              <div key={x} className={s.rangeSide}>
                <div className={s.rangeName}>{names[x as Side]}</div>
                {RANGE_STATS.map((st) => <div key={st.key} className={s.rangeRow}><span>{st.label}</span><b>{pickSide(r, x as Side)[st.key]}</b></div>)}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className={s.note}>Middle half (25th–75th percentile) of simulated rounds that were fought in full. Ranges, not predictions: strike and takedown-attempt volume beats simple Fight DNA averages in walk-forward testing but carries real spread.</p>
    </section>
  );
}

export function RepresentativePath({ a, left, names }: { a: SimArtifact; left: Side; names: Record<Side, string> }) {
  const p = pathView(a);
  if (!p) return null;
  return (
    <section className={s.card} aria-labelledby="sim-path">
      <div className={s.cardHead}><h2 id="sim-path" className={s.h2}>Representative simulated path</h2><span className={s.limited}>PATH DETAIL</span></div>
      <p className={s.pathLead}>In the representative path, <b>{p.winnerName}</b> wins by {p.methodLabel}.</p>
      <table className={s.table}>
        <thead><tr><th scope="col">Round</th><th scope="col">{names[left]}</th><th scope="col">{names[other(left)]}</th></tr></thead>
        <tbody>
          {p.rounds.map((r) => {
            const L = left === "fighter_1" ? r.f1 : r.f2, R = left === "fighter_1" ? r.f2 : r.f1;
            return <tr key={r.round}><th scope="row">{r.round}</th><td className={s.num}>{L.sig_l}/{L.sig_a} sig · {L.td_a} TD att</td><td className={s.num}>{R.sig_l}/{R.sig_a} sig · {R.td_a} TD att</td></tr>;
          })}
        </tbody>
      </table>
      <p className={s.note}>Simulation-path detail: one real simulated fight, chosen as the most typical fight of the most common outcome ({pct(p.cellShare)} of simulations). It illustrates the distribution above. It is not a prediction of how or when the fight ends, and the round it stops in is not a finish-round forecast.</p>
    </section>
  );
}

export function Provenance({ a, trainingWindow, asOfNames }: { a: SimArtifact; trainingWindow: { start: string; end: string }; asOfNames: Record<Side, string> }) {
  const g = simGate(a);
  return (
    <section className={`${s.card} ${s.provenance}`} aria-labelledby="sim-prov">
      <div className={s.cardHead}><h2 id="sim-prov" className={s.h2}>Model and data</h2></div>
      <dl className={s.dl}>
        <dt>Simulator</dt><dd data-sim-version="">{a.simulator_version}</dd>
        <dt>Winner anchor</dt><dd>{a.model_version || "—"}</dd>
        <dt>Coverage tier</dt><dd><GateBadge gate={g} /></dd>
        <dt>Fight DNA as of</dt><dd>{asOfNames.fighter_1}: {a.generated_from_as_of?.fighter_1 || "—"} · {asOfNames.fighter_2}: {a.generated_from_as_of?.fighter_2 || "—"}</dd>
        <dt>Fight DNA coverage</dt><dd>{asOfNames.fighter_1}: {coverageLine(a.coverage?.fighter_1)}<br />{asOfNames.fighter_2}: {coverageLine(a.coverage?.fighter_2)}</dd>
        <dt>Training window</dt><dd>{trainingWindow.start} to {trainingWindow.end}</dd>
        <dt>Simulations</dt><dd>{(a.n_sims || 0).toLocaleString("en-US")} (deterministic: the same matchup and data always return the same result)</dd>
        <dt>Simulation ID</dt><dd className={s.mono}>{a.simulation_id?.slice(0, 16)}</dd>
      </dl>
    </section>
  );
}

export function ModelCard() {
  return (
    <section className={`${s.card} ${s.modelCard}`} aria-labelledby="sim-card">
      <div className={s.cardHead}><h2 id="sim-card" className={s.h2}>Model card</h2><span className={s.model}>v1.0-rc1</span></div>
      <p className={s.note}>{MODEL_CARD.evaluation}. Lower is better on every score.</p>
      <table className={s.table}>
        <thead><tr><th scope="col">Score</th><th scope="col">Simulator</th><th scope="col">Baseline</th></tr></thead>
        <tbody>{MODEL_CARD.rows.map((r) => <tr key={r.metric}><th scope="row">{r.metric}</th><td className={s.num}>{r.simulator}</td><td className={s.num}>{r.baseline} <small className={s.faint}>{r.baselineLabel}</small></td></tr>)}</tbody>
      </table>
      <p className={s.note}>Not shown because they are not yet validated: {MODEL_CARD.notShown.join("; ")}.</p>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className={`${s.card} ${s.how}`} aria-labelledby="sim-how">
      <div className={s.cardHead}><h2 id="sim-how" className={s.h2}>How it works</h2></div>
      <ol className={s.howList}>
        <li><b>As-of Fight DNA.</b> Each fighter&apos;s striking, grappling, pace and finishing profile, built only from bouts before the fight date.</li>
        <li><b>Round-level UFC history.</b> Strike, takedown, control and finish components fitted on 4,899 bouts of per-round UFC statistics.</li>
        <li><b>Opponent interaction.</b> Each round is simulated against the specific opponent, carrying accumulated damage and state into the next round.</li>
        <li><b>Calibrated outcomes.</b> 10,000 simulated fights, with the winner split anchored to the PBE Fight Model so the two never disagree on who is favoured.</li>
      </ol>
      <p className={s.note}>Outputs are probabilities, not certainties. A 60% favourite loses four fights in ten.</p>
    </section>
  );
}

export function Unavailable({ a, error }: { a: SimArtifact | null; error?: boolean }) {
  const reasons = error ? [] : gateReasons(a);
  return (
    <section className={`${s.card} ${s.unavailable}`} data-sim-unavailable="" aria-live="polite">
      <GateBadge gate="INSUFFICIENT_DATA" />
      <p className={s.unavailableText}>{error ? "The simulator could not load this matchup right now. Nothing is shown rather than a partial result." : UNAVAILABLE_COPY}</p>
      {reasons.length > 0 && <ul className={s.reasons}>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </section>
  );
}

export function LimitedNote({ a }: { a: SimArtifact }) {
  const reasons = gateReasons(a);
  return (
    <div className={s.limitedNote} data-sim-limited="">
      <GateBadge gate="LIMITED" />
      <div>
        <p>Limited simulation: shown with reduced confidence.</p>
        {reasons.length > 0 && <ul className={s.reasons}>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      </div>
    </div>
  );
}

export function LockedPanel({ reason, loginHref }: { reason: "signed_out" | "no_membership" | "member"; loginHref: string }) {
  return (
    <section className={`${s.card} ${s.locked}`} data-sim-locked="" aria-labelledby="sim-locked">
      <div className={s.eyebrow}>PBE LABS PREVIEW</div>
      <h2 id="sim-locked" className={s.h2}>Simulation results are open to UFC Pro and All Access members during Labs</h2>
      <p className={s.note}>Members see the anchored win probability, the outcome distribution, goes-distance odds, round volume ranges and a representative simulated path for every upcoming UFC bout and any matchup they build.</p>
      <div className={s.lockedActions}>
        <Link href="/pro" className="btn gold">See membership options</Link>
        {reason === "signed_out" && <Link href={loginHref} className="btn">Member sign in</Link>}
      </div>
    </section>
  );
}
