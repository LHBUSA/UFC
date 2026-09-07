"use client";

/* Round-by-Round Analysis.
 *
 * A broadcast-desk reading of a fight, reconstructed from stored round
 * observations. It never claims to be live, never shows a clock, and never
 * scores a round: the source publishes after the fact and there is no judge
 * feed, so the product says what the numbers say and stops there.
 *
 * The round selector is client state because it is the only interactive part;
 * everything it renders was computed on the server by lib/roundAnalysis.ts.
 * No number is derived in this file.
 */
import { useState } from "react";
import type { RoundStat } from "@/lib/db";
import {
  type AnalysisState, type Corner, type DnaCompare, type RoundEdge, type RoundSignal, type RoundView,
  STATE_COPY, controlShare, fightSummary, pacePerMin, phaseProfile, ratio, targetProfile,
} from "@/lib/roundAnalysis";

const NA = "—";
const num = (v: number | null | undefined, digits = 0) => (typeof v === "number" ? v.toFixed(digits) : NA);
const secs = (v: number | null | undefined) =>
  typeof v === "number" ? `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}` : NA;
const pctOf = (r: ReturnType<typeof ratio>) => (r ? `${r.pct.toFixed(0)}%` : NA);
const landedOf = (r: ReturnType<typeof ratio>, s: RoundStat | null, key: "sig_str_landed" | "total_str_landed", att: "sig_str_att" | "total_str_att") => {
  const l = s?.[key], a = s?.[att];
  if (typeof l !== "number" && typeof a !== "number") return NA;
  return `${typeof l === "number" ? l : NA} / ${typeof a === "number" ? a : NA}`;
};

/* A comparison bar pair. A null value renders as an em dash with no bar,
 * because a bar of width zero reads as "did nothing" rather than "unknown". */
function CompareRow({ label, a, b, aLabel, bLabel }: { label: string; a: number | null; b: number | null; aLabel: string; bLabel: string }) {
  const max = Math.max(a ?? 0, b ?? 0) || 1;
  return (
    <div className="rba-row">
      <span className="rba-v">{aLabel}</span>
      <span className={`rba-bar a${a !== null && b !== null && a < b ? " lose" : ""}`}>
        {a !== null && <i style={{ width: `${(a / max) * 100}%` }} />}
      </span>
      <span className="rba-k">{label}</span>
      <span className={`rba-bar b${a !== null && b !== null && b < a ? " lose" : ""}`}>
        {b !== null && <i style={{ width: `${(b / max) * 100}%` }} />}
      </span>
      <span className="rba-v rba-vb">{bLabel}</span>
    </div>
  );
}

function DistBar({ label, parts, total }: { label: string; parts: Array<{ key: string; pct: number | null; tone: string }>; total: number | null }) {
  const known = parts.filter((p) => p.pct !== null);
  if (!known.length) {
    /* Two different absences. The source recording zero landed strikes is a
     * fact about the round; the fields being missing is not. Saying "not
     * recorded" for a fighter who simply did not land would be wrong. */
    return (
      <div className="rba-dist">
        <span className="rba-dist-k">{label}</span>
        <span className="rba-dist-na">{total === 0 ? "No strikes landed this round" : "Not recorded"}</span>
      </div>
    );
  }
  return (
    <div className="rba-dist">
      <span className="rba-dist-k">{label}</span>
      <span className="rba-dist-track">
        {known.map((p) => <i key={p.key} className={`t-${p.tone}`} style={{ width: `${p.pct}%` }} title={`${p.key} ${p.pct!.toFixed(0)}%`} />)}
      </span>
      <span className="rba-dist-v">{known.map((p) => `${p.key} ${p.pct!.toFixed(0)}%`).join(" · ")}</span>
    </div>
  );
}

export function RoundAnalysis({
  state, rounds, nameA, nameB, dnaA, dnaB, signals, edges, finalLine, updatedAt,
}: {
  state: AnalysisState;
  rounds: RoundView[];
  nameA: string;
  nameB: string;
  dnaA: DnaCompare[];
  dnaB: DnaCompare[];
  signals: Record<number, RoundSignal[]>;
  edges: Record<number, RoundEdge[]>;
  finalLine: string | null;
  updatedAt: string | null;
}) {
  const [active, setActive] = useState<number>(rounds.length ? rounds[rounds.length - 1].round : 1);

  if (state !== "final" || !rounds.length) {
    const copy = STATE_COPY[state];
    return (
      <section className="segment rba" aria-label="Round-by-round analysis">
        <h3>Round-by-Round Analysis</h3>
        <div className="card rba-empty">
          <div className="rba-state">{copy.label}</div>
          <p>{copy.body}</p>
        </div>
      </section>
    );
  }

  const view = rounds.find((r) => r.round === active) || rounds[rounds.length - 1];
  const sum = fightSummary(rounds);
  const paceMax = Math.max(0, ...sum.paceByRound.flatMap((p) => [p.a ?? 0, p.b ?? 0]));
  const sigA = ratio(view.a?.sig_str_landed, view.a?.sig_str_att);
  const sigB = ratio(view.b?.sig_str_landed, view.b?.sig_str_att);
  const totA = ratio(view.a?.total_str_landed, view.a?.total_str_att);
  const totB = ratio(view.b?.total_str_landed, view.b?.total_str_att);
  const tA = targetProfile(view.a), tB = targetProfile(view.b);
  const pA = phaseProfile(view.a), pB = phaseProfile(view.b);
  const roundSignals = signals[view.round] || [];
  const roundEdges = edges[view.round] || [];

  return (
    <section className="segment rba" aria-label="Round-by-round analysis">
      <div className="rba-head">
        <div>
          <h3>Round-by-Round Analysis</h3>
          <p className="rba-sub">Fight progression reconstructed from verified round-level observations.</p>
        </div>
        <div className="rba-status">
          <span className="rba-chip-final">{finalLine || "Final"}</span>
          {updatedAt && <span className="rba-updated">Round data updated {updatedAt}</span>}
        </div>
      </div>

      <div className="rba-tabs" role="tablist" aria-label="Rounds">
        {rounds.map((r) => (
          <button
            key={r.round}
            role="tab"
            aria-selected={r.round === view.round}
            className={`rba-tab${r.round === view.round ? " on" : ""}`}
            onClick={() => setActive(r.round)}
            type="button"
          >
            R{r.round}
          </button>
        ))}
      </div>

      <div className="card rba-card">
        <div className="rba-names"><span>{nameA}</span><span className="rba-round-no">Round {view.round}</span><span>{nameB}</span></div>

        <div className="rba-compare">
          <CompareRow label="Sig. strikes" a={view.a?.sig_str_landed ?? null} b={view.b?.sig_str_landed ?? null}
            aLabel={landedOf(sigA, view.a, "sig_str_landed", "sig_str_att")} bLabel={landedOf(sigB, view.b, "sig_str_landed", "sig_str_att")} />
          <CompareRow label="Accuracy" a={sigA?.pct ?? null} b={sigB?.pct ?? null} aLabel={pctOf(sigA)} bLabel={pctOf(sigB)} />
          <CompareRow label="Total strikes" a={view.a?.total_str_landed ?? null} b={view.b?.total_str_landed ?? null}
            aLabel={landedOf(totA, view.a, "total_str_landed", "total_str_att")} bLabel={landedOf(totB, view.b, "total_str_landed", "total_str_att")} />
          <CompareRow label="Knockdowns" a={view.a?.kd ?? null} b={view.b?.kd ?? null} aLabel={num(view.a?.kd)} bLabel={num(view.b?.kd)} />
          <CompareRow label="Takedowns" a={view.a?.td_landed ?? null} b={view.b?.td_landed ?? null}
            aLabel={`${num(view.a?.td_landed)} / ${num(view.a?.td_att)}`} bLabel={`${num(view.b?.td_landed)} / ${num(view.b?.td_att)}`} />
          <CompareRow label="Sub. attempts" a={view.a?.sub_att ?? null} b={view.b?.sub_att ?? null} aLabel={num(view.a?.sub_att)} bLabel={num(view.b?.sub_att)} />
          <CompareRow label="Control" a={view.a?.ctrl_sec ?? null} b={view.b?.ctrl_sec ?? null} aLabel={secs(view.a?.ctrl_sec)} bLabel={secs(view.b?.ctrl_sec)} />
          <CompareRow label="Pace / min" a={pacePerMin(view.a?.sig_str_landed, view.seconds)} b={pacePerMin(view.b?.sig_str_landed, view.seconds)}
            aLabel={num(pacePerMin(view.a?.sig_str_landed, view.seconds), 1)} bLabel={num(pacePerMin(view.b?.sig_str_landed, view.seconds), 1)} />
          <CompareRow label="Control share" a={controlShare(view, "a")?.pct ?? null} b={controlShare(view, "b")?.pct ?? null}
            aLabel={controlShare(view, "a") ? `${controlShare(view, "a")!.pct.toFixed(0)}%` : NA}
            bLabel={controlShare(view, "b") ? `${controlShare(view, "b")!.pct.toFixed(0)}%` : NA} />
        </div>

        <div className="rba-dists">
          <div>
            <div className="rba-dist-name">{nameA}</div>
            <DistBar label="Target" total={tA.total} parts={[{ key: "head", pct: tA.head?.pct ?? null, tone: "head" }, { key: "body", pct: tA.body?.pct ?? null, tone: "body" }, { key: "leg", pct: tA.leg?.pct ?? null, tone: "leg" }]} />
            <DistBar label="Phase" total={pA.total} parts={[{ key: "distance", pct: pA.distance?.pct ?? null, tone: "dist" }, { key: "clinch", pct: pA.clinch?.pct ?? null, tone: "clinch" }, { key: "ground", pct: pA.ground?.pct ?? null, tone: "ground" }]} />
          </div>
          <div>
            <div className="rba-dist-name">{nameB}</div>
            <DistBar label="Target" total={tB.total} parts={[{ key: "head", pct: tB.head?.pct ?? null, tone: "head" }, { key: "body", pct: tB.body?.pct ?? null, tone: "body" }, { key: "leg", pct: tB.leg?.pct ?? null, tone: "leg" }]} />
            <DistBar label="Phase" total={pB.total} parts={[{ key: "distance", pct: pB.distance?.pct ?? null, tone: "dist" }, { key: "clinch", pct: pB.clinch?.pct ?? null, tone: "clinch" }, { key: "ground", pct: pB.ground?.pct ?? null, tone: "ground" }]} />
          </div>
        </div>

        {roundEdges.length > 0 && (
          <div className="rba-edges">
            <div className="eyebrow">Statistical signals</div>
            <div className="rba-edge-list">
              {roundEdges.map((e) => (
                <span key={e.key} className={`rba-edge c-${e.corner}`}>
                  <b>{e.label}</b>
                  <span>{e.detail}</span>
                </span>
              ))}
            </div>
            <p className="rba-note">Descriptive only. These compare recorded output; they are not judge scores and do not say who won the round.</p>
          </div>
        )}

        {roundSignals.length > 0 && (
          <div className="rba-changed">
            <div className="eyebrow">What changed from R{view.round - 1}</div>
            <ul>
              {roundSignals.map((s, i) => (
                <li key={`${s.key}-${s.corner}-${i}`} className={`t-${s.tone}`}>
                  <b>{s.label}</b>
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Always shown on a completed fight. An absent comparison is itself
          information - it means the fighter's pre-fight sample was too thin to
          compare against - and hiding the section would leave the reader
          assuming we simply had not built it. */}
      {(
        <div className="card rba-dna mt-4">
          <div className="eyebrow">Observed fight vs historical Fight DNA</div>
          <p className="rba-note">Compares this fight against each fighter&apos;s pre-fight Fight DNA baseline. Shown only where the historical sample supports it.</p>
          <div className="rba-dna-grid">
            {([[nameA, dnaA], [nameB, dnaB]] as Array<[string, DnaCompare[]]>).map(([nm, list]) => (
              <div key={nm}>
                <div className="rba-dist-name">{nm}</div>
                {list.length === 0 ? (
                  <p className="rba-insufficient">Insufficient sample. This fighter&apos;s Fight DNA as of the event date did not have enough covered rounds to compare against, so no deviation is shown.</p>
                ) : list.map((d) => {
                  const delta = d.deltaPoints !== null ? `${d.deltaPoints > 0 ? "+" : ""}${d.deltaPoints.toFixed(0)} pts` : d.deltaPct !== null ? `${d.deltaPct > 0 ? "+" : ""}${d.deltaPct.toFixed(0)}%` : NA;
                  const up = (d.deltaPoints ?? d.deltaPct ?? 0) > 0;
                  return (
                    <div className="rba-dna-row" key={d.key}>
                      <span className="rba-dna-k">{d.label}</span>
                      <span className="rba-dna-obs"><em>Observed</em>{d.observed.toFixed(d.unit === "%" ? 0 : 1)}</span>
                      <span className="rba-dna-base"><em>Fight DNA</em>{d.baseline.toFixed(d.unit === "%" ? 0 : 1)}</span>
                      <span className={`rba-dna-d ${up ? "up" : "down"}`}>{delta}</span>
                      <span className="rba-dna-conf">{d.confidence} · {d.sample}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card rba-summary mt-4">
        <div className="eyebrow">Fight summary</div>
        <div className="rba-sum-grid">
          <div><b>{sum.totalSig.a ?? NA}</b><span>{nameA} sig. strikes</span></div>
          <div><b>{sum.totalSig.b ?? NA}</b><span>{nameB} sig. strikes</span></div>
          <div><b>{rounds.length}</b><span>rounds observed</span></div>
          {sum.biggestSwing && (
            <div>
              <b>{sum.biggestSwing.deltaPct > 0 ? "+" : ""}{sum.biggestSwing.deltaPct.toFixed(0)}%</b>
              <span>largest pace swing, R{sum.biggestSwing.from} to R{sum.biggestSwing.to} ({sum.biggestSwing.corner === "a" ? nameA : nameB})</span>
            </div>
          )}
        </div>
        <div className="rba-pace-track">
          {sum.paceByRound.map((p) => (
            <div key={p.round} className="rba-pace-col">
              <span className="rba-pace-bars">
                {/* Scaled to this fight's own busiest round. A fixed ceiling
                    flattens a grappling-heavy fight into invisible stubs and
                    makes a real difference between rounds unreadable. */}
                {p.a !== null && <i className="a" style={{ height: `${paceMax > 0 ? Math.max(2, (p.a / paceMax) * 100) : 2}%` }} />}
                {p.b !== null && <i className="b" style={{ height: `${paceMax > 0 ? Math.max(2, (p.b / paceMax) * 100) : 2}%` }} />}
              </span>
              <span className="rba-pace-lab">R{p.round}</span>
            </div>
          ))}
        </div>
        <p className="rba-note">Pace is significant strikes landed per minute of observed round time. A round with no recorded observation is left empty rather than drawn as zero.</p>
      </div>
    </section>
  );
}
