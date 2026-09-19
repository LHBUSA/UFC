import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { PbeFamilyNav } from "@/components/PbeFamilyNav";
import { PbePerformanceTracker } from "@/components/PbePerformanceTracker";
import { PbePicksAutoRefresh } from "@/components/PbePicksAutoRefresh";
import { getAlgoPerformanceProof, getAlgoPublicGradedRecord } from "@/lib/algo";
import { confidenceCopy, deltaText, lockedText, oddsText, pctText, type AlgoBoutView } from "@/lib/algoView";

/* Public receipt ledger for official PBE Picks.
 *
 * Only already-graded, officially locked calls expose fighter identity here.
 * Pending/current calls remain behind UFC Pro on /algo/card. Locked predictions
 * are immutable; grade corrections remain revisioned instead of overwriting
 * history. Backtest output never appears on this page. */

export const metadata: Metadata = {
  title: "PBE Picks Track Record, Units & ROI — UFC",
  description: "The public receipt ledger for official PBE Picks: every graded locked UFC call, W-L record, hit rate, net units and ROI from stored lock-time prices.",
  alternates: { canonical: "/algo/record" },
  robots: { index: true, follow: true },
};

type Summary = { n: number; wins: number; losses: number; brier: number | null; logLoss: number | null; hit: number | null };

function summarize(rows: AlgoBoutView[]): Summary {
  const decided = rows.filter((r) => r.grade && (r.grade.result === "WIN" || r.grade.result === "LOSS"));
  const wins = decided.filter((r) => r.grade!.result === "WIN").length;
  const n = decided.length;
  if (!n) return { n: 0, wins: 0, losses: 0, brier: null, logLoss: null, hit: null };
  let b = 0, l = 0;
  for (const r of decided) {
    const p = r.prediction!.pick_probability;
    const y = r.grade!.result === "WIN" ? 1 : 0;
    b += (p - y) ** 2;
    l += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return { n, wins, losses: n - wins, brier: b / n, logLoss: l / n, hit: wins / n };
}

function oneUnitReturn(row: AlgoBoutView): number | null {
  const result = row.grade?.result;
  if (result !== "WIN" && result !== "LOSS") return null;
  const raw = row.market?.pick_best_odds;
  const price = raw == null ? null : Number(raw);
  if (price == null || !Number.isFinite(price) || price === 0) return null;
  if (result === "LOSS") return -1;
  return price > 0 ? price / 100 : 100 / Math.abs(price);
}

function unitsText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
}

const EDGE_BANDS: Array<[string, (d: number) => boolean]> = [
  ["PBE Edge +10 pts or more", (d) => d >= 10],
  ["PBE Edge +3 to +10 pts", (d) => d >= 3 && d < 10],
  ["PBE Edge within 3 pts", (d) => Math.abs(d) < 3],
  ["PBE Edge −3 pts or lower", (d) => d <= -3],
];

function SummaryRow({ label, s }: { label: string; s: Summary }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="r">{s.n ? `${s.wins}-${s.losses}` : "—"}</td>
      <td className="r">{pctText(s.hit)}</td>
      <td className="r">{s.brier == null ? "—" : s.brier.toFixed(3)}</td>
      <td className="r">{s.logLoss == null ? "—" : s.logLoss.toFixed(3)}</td>
    </tr>
  );
}

export default async function AlgoRecordPage() {
  const [rows, proof] = await Promise.all([
    getAlgoPublicGradedRecord(),
    getAlgoPerformanceProof(),
  ]);
  const all = summarize(rows);
  const noDecision = rows.filter((r) => r.grade && !["WIN", "LOSS"].includes(r.grade.result)).length;

  return (
    <div className="wrap page algo-page">
      <PbePicksAutoRefresh intervalMs={60_000} />
      <PageHead
        crumbs={[{ name: "PBE Picks", href: "/algo/card" }, { name: "Track record" }]}
        eyebrow="PropBetEdge UFC · Official live record"
        title="PBE Picks track record"
        lede="The public receipt ledger. Every officially locked call stays in the record and every official grade stays attached to it. Current picks remain Pro; completed receipts are public."
      >
        <div className="row mt-3">
          <Link href="/algo/card" className="btn gold">Open Current PBE Picks</Link>
          <Link href="/algo" className="btn">How PBE Algo Works</Link>
        </div>
      </PageHead>

      <PbePerformanceTracker proof={proof} compact />

      {rows.length === 0 ? (
        <section className="card algo-record-empty mt-4">
          <div className="eyebrow">Awaiting the first official grade</div>
          <h2>The ledger is live before the result is.</h2>
          <p className="dim">Locked calls are already counted by the tracker above. Fighter identity appears in this public receipt table only after the official grading path records a result.</p>
        </section>
      ) : (
        <>
          <div className="mdl-rec mt-4">
            <div className="stat model"><b>{rows.length}</b><span>Graded receipts</span></div>
            <div className="stat model"><b>{all.n ? `${all.wins}-${all.losses}` : "—"}</b><span>Decided W-L</span></div>
            <div className="stat model"><b>{pctText(all.hit)}</b><span>Hit rate</span></div>
            <div className="stat model"><b>{all.brier == null ? "—" : all.brier.toFixed(3)}</b><span>Brier score</span></div>
            <div className="stat model"><b>{all.logLoss == null ? "—" : all.logLoss.toFixed(3)}</b><span>Log loss</span></div>
            <div className="stat model"><b>{proof.lifetime.priced_decided}</b><span>ROI-priced decisions</span>{noDecision > 0 && <span className="faint">{noDecision} draw / NC / void</span>}</div>
          </div>

          <section className="mdl-sec">
            <div className="eyebrow">Performance slices</div>
            <h2>Where the live record is hitting — and where it is not.</h2>
            <p className="note">These are live official calls only. They are not backtest rows and they are never blended with historical model research.</p>
            <div className="tbl-wrap mt-4">
              <table className="tbl">
                <caption className="sr-only">Record by confidence tier and by PBE Edge at lock</caption>
                <thead><tr><th>Slice</th><th className="r">W-L</th><th className="r">Hit</th><th className="r">Brier</th><th className="r">Log loss</th></tr></thead>
                <tbody>
                  {(["HIGH", "MEDIUM", "LEAN"] as const).map((c) => <SummaryRow key={c} label={`${confidenceCopy(c)} confidence`} s={summarize(rows.filter((r) => r.confidence === c))} />)}
                  {EDGE_BANDS.map(([label, predicate]) => <SummaryRow key={label} label={label} s={summarize(rows.filter((r) => r.prediction?.model_edge_pts != null && predicate(Number(r.prediction.model_edge_pts))))} />)}
                  <SummaryRow label="No current market at lock (stale or no line)" s={summarize(rows.filter((r) => r.prediction?.model_edge_pts == null))} />
                </tbody>
              </table>
            </div>
          </section>

          <section className="mdl-sec">
            <div className="eyebrow">Immutable receipt ledger</div>
            <h2>Every graded official PBE Pick.</h2>
            <p className="note">Price and unit return use the best available market price frozen with the official prediction at database lock. If no valid lock-time price exists, the call stays in W-L but shows no unit return.</p>
            <div className="tbl-wrap mt-4">
              <table className="tbl algo-record">
                <caption className="sr-only">Every graded locked PBE Algo call</caption>
                <thead>
                  <tr>
                    <th>Event</th><th>Bout</th><th>Pick</th><th className="r">Prob.</th><th>Conf.</th><th>Locked</th>
                    <th className="r">Market</th><th className="r">PBE Edge</th><th className="r">Lock price</th><th className="r">Units</th><th>Result</th><th>Model</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const p = r.prediction!;
                    const pick = p.pick_fighter_id === r.fighter_a.id ? r.fighter_a.name : r.fighter_b.name;
                    const superseded = (r.grade_history || []).filter((h) => h.revision !== r.grade?.revision);
                    const lockPrice = r.market?.pick_best_odds == null ? null : Number(r.market.pick_best_odds);
                    const lockBook = r.market?.pick_best_book || null;
                    const resultUnits = oneUnitReturn(r);
                    return (
                      <tr key={p.id} data-algo-bout={r.bout_id}>
                        <td><Link href={`/events/${r.event_slug}`}>{r.event_name}</Link><div className="faint sm">{r.event_date}</div></td>
                        <td><Link href={`/fights/${r.fight_slug}`}>{r.fighter_a.name} vs {r.fighter_b.name}</Link></td>
                        <td><b>{pick}</b></td>
                        <td className="r">{pctText(p.pick_probability)}</td>
                        <td>{confidenceCopy(r.confidence)}</td>
                        <td className="nowrap">{lockedText(p.locked_at)}</td>
                        <td className="r">{p.market_implied_prob_pick == null ? "—" : pctText(Number(p.market_implied_prob_pick))}</td>
                        <td className="r nowrap">{p.model_edge_pts == null ? "—" : deltaText(Number(p.model_edge_pts))}</td>
                        <td className="r nowrap">{oddsText(lockPrice)}{lockBook ? <div className="faint sm">{lockBook}</div> : null}</td>
                        <td className="r nowrap"><b>{unitsText(resultUnits)}</b></td>
                        <td>
                          {r.grade ? <span className={`algo-result ${r.grade.result.toLowerCase()}`}>{r.grade.result}</span> : <span className="faint">Pending</span>}
                          {superseded.length > 0 && (
                            <details className="algo-revisions">
                              <summary>{superseded.length} earlier revision{superseded.length === 1 ? "" : "s"}</summary>
                              <ul>{[...superseded, ...(r.grade ? [r.grade] : [])].map((h) => <li key={h.revision}>r{h.revision} {h.result} · {h.graded_at.slice(0, 10)}{h.revision_reason ? ` · ${h.revision_reason}` : ""}</li>)}</ul>
                            </details>
                          )}
                        </td>
                        <td className="mono sm">{r.model_version}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="mdl-split-note mt-4">
            <b>ROI methodology:</b> flat 1-unit stake on each decided call at the best available price captured in that call&apos;s frozen lock-time market snapshot. W/L calls without a valid stored price remain in record and hit-rate calculations but are excluded from the ROI denominator. Draws, no contests and voids are excluded from W-L and ROI. Closing-line value remains separate and will only appear when a verified closing snapshot exists.
          </div>
        </>
      )}

      <PbeFamilyNav current="record" />
    </div>
  );
}
