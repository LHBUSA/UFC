import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { ProPreview } from "@/components/ProPreview";
import { getUfcAccess } from "@/lib/access";
import { getAlgoRecord } from "@/lib/algo";
import { confidenceCopy, deltaText, lockedText, pctText, type AlgoBoutView } from "@/lib/algoView";

/* UFC Pro: the permanent PBE Algo track record. Every locked call, newest
 * first, with its current grade and every superseded revision. Locked rows are
 * frozen in the database; nothing here can make one disappear. Backtest output
 * never appears on this page. */

export const metadata: Metadata = {
  title: "PBE Algo Track Record — UFC Pro",
  description: "Every official PBE Algo call, locked before the fight and graded after it. UFC Pro.",
  alternates: { canonical: "/algo/record" },
  robots: { index: false, follow: true },
};

type Summary = { n: number; wins: number; losses: number; brier: number | null; logLoss: number | null; hit: number | null };

function summarize(rows: AlgoBoutView[]): Summary {
  const decided = rows.filter((r) => r.grade && (r.grade.result === "WIN" || r.grade.result === "LOSS"));
  const wins = decided.filter((r) => r.grade!.result === "WIN").length;
  const n = decided.length;
  if (!n) return { n: 0, wins: 0, losses: 0, brier: null, logLoss: null, hit: null };
  let b = 0, l = 0;
  for (const r of decided) {
    const p = r.prediction!.pick_probability, y = r.grade!.result === "WIN" ? 1 : 0;
    b += (p - y) ** 2;
    l += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return { n, wins, losses: n - wins, brier: b / n, logLoss: l / n, hit: wins / n };
}

const EDGE_BANDS: Array<[string, (d: number) => boolean]> = [
  ["Model above market by 10+ pts", (d) => d >= 10],
  ["Model above market by 3–10 pts", (d) => d >= 3 && d < 10],
  ["Within 3 pts of market", (d) => Math.abs(d) < 3],
  ["Model below market by 3+ pts", (d) => d <= -3],
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
  const access = await getUfcAccess();
  const rows = access.pro ? await getAlgoRecord(access) : [];
  const all = summarize(rows);
  const pending = rows.filter((r) => !r.grade).length;
  const noDecision = rows.filter((r) => r.grade && !["WIN", "LOSS"].includes(r.grade.result)).length;

  return (
    <div className="wrap page algo-page">
      <PageHead
        crumbs={[{ name: "PBE Algo", href: "/algo" }, { name: "Track record" }]}
        eyebrow="UFC Pro · PBE Algo"
        title="PBE Algo track record"
        lede="Every official call, locked on the database clock before its fight and graded after it. Nothing is removed and nothing is rewritten after the lock; corrected results appear as dated revisions beside the original."
      >
        {access.pro && <div className="row mt-3"><Link href="/algo/card" className="btn">Current PBE Picks</Link></div>}
      </PageHead>

      {!access.pro ? (
        <ProPreview feature="algo" access={access} returnPath="/algo/record" />
      ) : rows.length === 0 ? (
        <section className="card algo-record-empty">
          <div className="eyebrow">No locked calls yet</div>
          <p className="dim">The record begins with the first official lock. It is never backfilled from the backtest, and a provisional call never appears here.</p>
        </section>
      ) : (
        <>
          <div className="mdl-rec">
            <div className="stat model"><b>{rows.length}</b><span>Locked calls</span></div>
            <div className="stat model"><b>{all.n ? `${all.wins}-${all.losses}` : "—"}</b><span>Record</span></div>
            <div className="stat model"><b>{pctText(all.hit)}</b><span>Hit rate</span></div>
            <div className="stat model"><b>{all.brier == null ? "—" : all.brier.toFixed(3)}</b><span>Brier</span></div>
            <div className="stat model"><b>{all.logLoss == null ? "—" : all.logLoss.toFixed(3)}</b><span>Log loss</span></div>
            <div className="stat model"><b>{pending}</b><span>Awaiting result</span>{noDecision > 0 && <span className="faint">{noDecision} draw / NC / void</span>}</div>
          </div>

          <div className="tbl-wrap mt-4">
            <table className="tbl">
              <caption className="sr-only">Record by confidence tier and by model-vs-market delta</caption>
              <thead><tr><th>Slice</th><th className="r">W-L</th><th className="r">Hit</th><th className="r">Brier</th><th className="r">Log loss</th></tr></thead>
              <tbody>
                {(["HIGH", "MEDIUM", "LEAN"] as const).map((c) => <SummaryRow key={c} label={`${confidenceCopy(c)} confidence`} s={summarize(rows.filter((r) => r.confidence === c))} />)}
                {EDGE_BANDS.map(([label, f]) => <SummaryRow key={label} label={label} s={summarize(rows.filter((r) => r.prediction?.model_edge_pts != null && f(Number(r.prediction.model_edge_pts))))} />)}
                <SummaryRow label="No fresh market at lock (stale or no line)" s={summarize(rows.filter((r) => r.prediction?.model_edge_pts == null))} />
              </tbody>
            </table>
          </div>

          <div className="tbl-wrap mt-4">
            <table className="tbl algo-record">
              <caption className="sr-only">Every locked PBE Algo call</caption>
              <thead>
                <tr><th>Event</th><th>Bout</th><th>Pick</th><th className="r">Prob.</th><th>Conf.</th><th>Locked</th><th className="r">Market</th><th className="r">Delta</th><th>Result</th><th>Model</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const p = r.prediction!;
                  const pick = p.pick_fighter_id === r.fighter_a.id ? r.fighter_a.name : r.fighter_b.name;
                  const superseded = (r.grade_history || []).filter((h) => h.revision !== r.grade?.revision);
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
          <p className="note mt-4">ROI and closing-line value need the actual price at lock and at close; they are added to this page once both are captured for graded calls rather than estimated.</p>
        </>
      )}
    </div>
  );
}
