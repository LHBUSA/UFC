import Link from "next/link";
import type { AlgoPerformanceProof, AlgoPerformanceSlice } from "@/lib/algo";
import { oddsText } from "@/lib/algoView";

function pct(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

function units(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}u`;
}

function record(slice: AlgoPerformanceSlice): string {
  return slice.decided ? `${slice.wins}-${slice.losses}` : "0-0";
}

function streak(slice: AlgoPerformanceSlice): string {
  return slice.streak ? `${slice.streak.result === "WIN" ? "W" : "L"}${slice.streak.count}` : "—";
}

function Scope({
  eyebrow,
  title,
  slice,
}: {
  eyebrow: string;
  title: string;
  slice: AlgoPerformanceSlice;
}) {
  return (
    <article className="pbe-proof-scope">
      <div className="pbe-proof-scope-head">
        <span>{eyebrow}</span>
        <strong>{title}</strong>
      </div>
      <div className="pbe-proof-metrics">
        <div><b>{record(slice)}</b><span>Record</span></div>
        <div><b>{pct(slice.hit_rate)}</b><span>Hit rate</span></div>
        <div><b>{units(slice.net_units)}</b><span>Net units</span></div>
        <div><b>{pct(slice.roi)}</b><span>ROI</span></div>
        <div><b>{streak(slice)}</b><span>Streak</span></div>
        <div><b>{slice.pending}</b><span>Pending</span></div>
      </div>
      <div className="pbe-proof-priced">
        {slice.priced_decided} of {slice.decided} decided call{slice.decided === 1 ? "" : "s"} currently have a valid frozen lock-time price for ROI.
      </div>
    </article>
  );
}

export function PbePerformanceTracker({
  proof,
  compact = false,
}: {
  proof: AlgoPerformanceProof;
  compact?: boolean;
}) {
  const week = proof.fight_week;
  const last = proof.last_result;

  return (
    <section className={`pbe-proof-tracker${compact ? " compact" : ""}`} aria-label="PBE Picks live performance tracker">
      <header className="pbe-proof-head">
        <div>
          <span className="pbe-proof-live"><i aria-hidden="true" /> LIVE PBE PICKS TRACKER</span>
          <h2>Every call. Every result. No edits.</h2>
          <p>Official locked PBE Picks are graded into the ledger as results arrive. Current calls stay Pro; the receipts stay visible.</p>
        </div>
        <Link href="/algo/record" className="btn gold">Full Record &amp; ROI →</Link>
      </header>

      <div className="pbe-proof-grid">
        {week ? (
          <Scope eyebrow="THIS FIGHT WEEK" title={week.event_name} slice={week} />
        ) : (
          <article className="pbe-proof-scope">
            <div className="pbe-proof-scope-head"><span>THIS FIGHT WEEK</span><strong>No locked card yet</strong></div>
            <p className="pbe-proof-empty">The event tracker opens automatically with the next official lock.</p>
          </article>
        )}

        <Scope eyebrow="LIFETIME OFFICIAL" title="PBE Algo live record" slice={proof.lifetime} />

        <article className="pbe-proof-last">
          <div className="pbe-proof-scope-head">
            <span>LAST OFFICIAL RESULT</span>
            <strong>{last ? last.event_name : "Awaiting first grade"}</strong>
          </div>
          {last ? (
            <>
              <div className="pbe-proof-last-call">
                <span className={`pbe-proof-result ${last.result.toLowerCase()}`}>{last.result}</span>
                <div>
                  <b>{last.pick_name}</b>
                  <span>vs {last.opponent_name}</span>
                </div>
              </div>
              <div className="pbe-proof-last-meta">
                <span>Locked price <b>{oddsText(last.best_odds)}</b></span>
                <span>Return <b>{units(last.net_units)}</b></span>
              </div>
            </>
          ) : (
            <p className="pbe-proof-empty">The first officially graded locked call will appear here automatically.</p>
          )}
        </article>
      </div>

      <footer className="pbe-proof-note">
        <b>ROI standard:</b> flat 1-unit stake per decided call using the best available price stored in the immutable lock-time market snapshot. A decided call without a valid stored price remains in W-L and hit rate but is excluded from ROI. Draws, no contests and voids are not wins or losses.
      </footer>
    </section>
  );
}
