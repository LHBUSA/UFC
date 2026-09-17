import Link from "next/link";
import type { UfcAccess } from "@/lib/accessDecision";
import { getAlgoCards, type AlgoUpsetProof } from "@/lib/algo";
import { deltaText, marketView, oddsText, pctText } from "@/lib/algoView";

type CurrentUnderdog = {
  boutId: string;
  eventName: string;
  eventDate: string;
  pickName: string;
  opponentName: string;
  odds: number;
  bestOdds: number | null;
  probability: number;
  edgePts: number | null;
  locked: boolean;
};

function eventDateLabel(v: string): string {
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export async function PbeUpsetRadar({ access, proof }: { access: Pick<UfcAccess, "pro">; proof: AlgoUpsetProof }) {
  let current: CurrentUnderdog[] = [];

  // Critical boundary: upcoming fighter identities are read only after the
  // verified server-side Pro entitlement has already resolved true.
  if (access.pro === true) {
    const cards = await getAlgoCards(access);
    current = cards.flatMap((card) => card.bouts.flatMap((b) => {
      const p = b.prediction;
      if (!p || !b.pick_fighter_id || b.decision !== "ELIGIBLE") return [];
      const mv = marketView(b.market, { lockedAt: p.locked_at });
      const odds = mv.pick.consensus;
      if (mv.state !== "CURRENT" || odds == null || odds <= proof.threshold_odds) return [];
      const pick = b.pick_fighter_id === b.fighter_a.id ? b.fighter_a : b.fighter_b;
      const opponent = pick.id === b.fighter_a.id ? b.fighter_b : b.fighter_a;
      return [{
        boutId: b.bout_id,
        eventName: card.event_name,
        eventDate: card.event_date,
        pickName: pick.name,
        opponentName: opponent.name,
        odds,
        bestOdds: mv.pick.best,
        probability: Number(p.pick_probability),
        edgePts: p.model_edge_pts == null ? mv.delta : Number(p.model_edge_pts),
        locked: Boolean(p.locked_at),
      }];
    }))
      .sort((a, b) => b.odds - a.odds)
      .slice(0, 3);
  }

  return (
    <section className="pbe-upset-radar" aria-labelledby="pbe-upset-title">
      <div className="pbe-upset-head">
        <div>
          <div className="eyebrow">PBE Upset Radar · market disagreement</div>
          <h3 id="pbe-upset-title">When the model backs the underdog.</h3>
          <p>
            The favorite is not automatically the PBE Pick. Upset Radar isolates calls where the model&apos;s selected fighter
            was a market underdog at the recorded decision point.
          </p>
        </div>
        <div className="pbe-upset-rule">
          <b>UNDERDOG = +101 OR LONGER</b>
          <span>Mechanical rule. Not an editorial label.</span>
        </div>
      </div>

      {proof.total > 0 ? (
        <>
          <div className="pbe-upset-proof" aria-label="Graded PBE underdog record">
            <div><b>{proof.total}</b><span>Graded underdog calls</span></div>
            <div><b>{proof.decided ? `${proof.wins}-${proof.losses}` : "—"}</b><span>Decided record</span></div>
            <div><b>{proof.hit_rate == null ? "—" : `${(proof.hit_rate * 100).toFixed(1)}%`}</b><span>Hit rate</span></div>
            <div><b>{proof.average_consensus_odds == null ? "—" : oddsText(Math.round(proof.average_consensus_odds))}</b><span>Avg locked price</span></div>
          </div>

          {proof.biggest_wins.length > 0 && (
            <div className="pbe-upset-showcase">
              <div className="pbe-upset-label">BIGGEST GRADED UNDERDOG WINS · +{proof.showcase_threshold_odds} OR LONGER</div>
              <div className="pbe-upset-grid">
                {proof.biggest_wins.map((x) => (
                  <article className="pbe-upset-card" key={x.prediction_id}>
                    <div className="pbe-upset-card-top">
                      <span className="pbe-upset-win">RESULT · WIN</span>
                      <b>{oddsText(x.consensus_odds)} UNDERDOG</b>
                    </div>
                    <h4>{x.pick_name}</h4>
                    <p className="pbe-upset-vs">vs {x.opponent_name}</p>
                    <p className="pbe-upset-event">{x.event_name} · {eventDateLabel(x.event_date)}</p>
                    <dl>
                      <div><dt>Model win probability</dt><dd>{pctText(x.pick_probability)}</dd></div>
                      <div><dt>Market implied</dt><dd>{pctText(x.market_implied_prob)}</dd></div>
                      <div><dt>PBE Edge</dt><dd>{deltaText(x.model_edge_pts)}</dd></div>
                    </dl>
                    <div className="pbe-upset-lock">LOCKED BEFORE THE FIGHT · PERMANENT RECORD</div>
                  </article>
                ))}
              </div>
              <p className="pbe-upset-disclosure">
                Showcase cards are the largest graded wins only. The record above includes every graded PBE underdog call,
                including losses and no-decisions.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="pbe-upset-empty">
          <b>THE LIVE UPSET LEDGER OPENS WITH THE FIRST GRADED UNDERDOG CALL.</b>
          <span>No backtest winner is being passed off as live proof, and no provisional pick is counted here.</span>
        </div>
      )}

      {access.pro === true ? (
        <div className="pbe-upset-current">
          <div className="pbe-upset-current-head">
            <div>
              <span className="eyebrow">UFC Pro only · current board</span>
              <strong>Current PBE underdog calls</strong>
            </div>
            <Link href="/algo/card" className="btn gold">Open full PBE Picks</Link>
          </div>
          {current.length > 0 ? (
            <div className="pbe-upset-current-grid">
              {current.map((x) => (
                <div className="pbe-upset-current-card" key={x.boutId}>
                  <div className="between">
                    <span className={x.locked ? "pbe-upset-state locked" : "pbe-upset-state"}>{x.locked ? "LOCKED" : "PROVISIONAL"}</span>
                    <b>{oddsText(x.odds)}</b>
                  </div>
                  <h4>{x.pickName}</h4>
                  <p>vs {x.opponentName}</p>
                  <small>{x.eventName} · {eventDateLabel(x.eventDate)}</small>
                  <div className="pbe-upset-current-metrics">
                    <span><b>{pctText(x.probability)}</b> model</span>
                    <span><b>{deltaText(x.edgePts)}</b> edge</span>
                    <span><b>{x.bestOdds == null ? "—" : oddsText(x.bestOdds)}</b> best</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="pbe-upset-current-none">No current PBE call is a live market underdog right now. Upset Radar does not force one.</p>
          )}
        </div>
      ) : (
        <div className="pbe-upset-gate">
          <div>
            <span className="eyebrow">Current upset calls stay Pro</span>
            <strong>Historical receipts are public. Upcoming fighter calls are not.</strong>
            <p>UFC Pro unlocks the current underdog board with the model probability, recorded market price and PBE Edge.</p>
          </div>
          <Link href="#pro" className="btn gold">Unlock current PBE Picks</Link>
        </div>
      )}

      <div className="pbe-upset-receipt">
        <b>No hindsight. No backfill. No edited losses.</b>
        <span>Official calls lock before the fight; grades come from the stored result and revisions remain auditable.</span>
      </div>
    </section>
  );
}
