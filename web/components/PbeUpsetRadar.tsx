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
  marketImplied: number | null;
  edgePts: number | null;
  locked: boolean;
};

function eventDateLabel(v: string): string {
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

type AlgoCards = Awaited<ReturnType<typeof getAlgoCards>>;
type Surface = "pro" | "picks";

export async function PbeUpsetRadar({
  access,
  proof,
  cards: providedCards,
  surface = "pro",
}: {
  access: Pick<UfcAccess, "pro">;
  proof: AlgoUpsetProof;
  cards?: AlgoCards;
  surface?: Surface;
}) {
  let current: CurrentUnderdog[] = [];

  // Critical boundary: upcoming fighter identities are read only after the
  // verified server-side Pro entitlement has already resolved true. The PBE
  // Picks page can pass its already-gated cards to avoid a duplicate read.
  if (access.pro === true) {
    const cards = providedCards ?? await getAlgoCards(access);
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
        marketImplied: mv.implied,
        edgePts: p.model_edge_pts == null ? mv.delta : Number(p.model_edge_pts),
        locked: Boolean(p.locked_at),
      }];
    }))
      .sort((a, b) => (b.edgePts ?? -999) - (a.edgePts ?? -999) || b.odds - a.odds)
      .slice(0, 3);
  }

  const onPicksPage = surface === "picks";

  if (onPicksPage) {
    return (
      <section className="pbe-upset-rail-window" aria-labelledby="pbe-upset-rail-title">
        <div className="pbe-upset-rail-tab">
          <i aria-hidden="true" />
          <span>UPSET RADAR</span>
          <b>{access.pro && current.length ? `${current.length} LIVE` : "WATCHING"}</b>
        </div>

        <div className="pbe-upset-rail-body">
          <header className="pbe-upset-rail-head">
            <div className="eyebrow">PBE Picks · model vs market</div>
            <h3 id="pbe-upset-rail-title">Upset Radar</h3>
            <p>Only plus-money fighters that PBE independently selects. No forced dog pick.</p>
          </header>

          <div className="pbe-upset-rail-rule">
            <span><b>+101+</b> consensus</span>
            <span><b>PBE PICK</b> required</span>
            <span><b>CURRENT</b> market</span>
          </div>

          {access.pro ? (
            current.length > 0 ? (
              <div className="pbe-upset-rail-signals">
                {current.slice(0, 2).map((x, i) => (
                  <article className="pbe-upset-rail-signal" key={x.boutId}>
                    <div className="pbe-upset-rail-signal-top">
                      <span>#{i + 1} · {x.locked ? "LOCKED" : "PROVISIONAL"}</span>
                      <b>{oddsText(x.odds)}</b>
                    </div>
                    <h4>{x.pickName}</h4>
                    <p>vs {x.opponentName}</p>
                    <small>{x.eventName} · {eventDateLabel(x.eventDate)}</small>
                    <div className="pbe-upset-rail-metrics">
                      <span><em>MODEL</em><b>{pctText(x.probability)}</b></span>
                      <span><em>MARKET</em><b>{pctText(x.marketImplied)}</b></span>
                      <span><em>EDGE</em><b>{deltaText(x.edgePts)}</b></span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="pbe-upset-rail-empty">
                <b>NO LIVE UPSET SIGNAL</b>
                <span>The active PBE board is not backing a plus-money fighter right now.</span>
              </div>
            )
          ) : (
            <div className="pbe-upset-rail-gate">
              <b>LIVE SIGNALS ARE UFC PRO</b>
              <span>Historical proof stays public. Current fighter calls stay behind the Pro entitlement.</span>
              <Link href="#pro" className="btn gold">Unlock Radar</Link>
            </div>
          )}

          <div className="pbe-upset-rail-ledger">
            <div>
              <span>GRADED UNDERDOG LEDGER</span>
              <b>{proof.total > 0 ? (proof.decided ? `${proof.wins}-${proof.losses}` : `${proof.total} graded`) : "First grade pending"}</b>
            </div>
            {proof.total > 0 && proof.hit_rate != null ? <strong>{(proof.hit_rate * 100).toFixed(1)}%</strong> : <strong>—</strong>}
          </div>

          <div className="pbe-upset-rail-foot">
            <span>No hindsight · no backfill · losses stay.</span>
            <Link href="/algo/record">Receipt ledger →</Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`pbe-upset-radar ${onPicksPage ? "picks-surface" : "pro-surface"}`} aria-labelledby="pbe-upset-title">
      <div className="pbe-upset-signalbar">
        <span>PBE UPSET RADAR</span>
        <i aria-hidden="true" />
        <b>{access.pro ? "LIVE MODEL DISAGREEMENT" : "HISTORICAL PROOF + PRO LIVE BOARD"}</b>
      </div>

      <div className="pbe-upset-head">
        <div>
          <div className="eyebrow">{onPicksPage ? "PBE Picks · plus-money model calls" : "PBE Upset Radar · market disagreement"}</div>
          <h3 id="pbe-upset-title">{onPicksPage ? "The market says underdog. PBE may still say pick." : "When the model backs the underdog."}</h3>
          <p>
            {onPicksPage
              ? "This is not a list of underdogs. It is the subset of official PBE selections where the model independently backs a fighter the market prices at plus money. If the signal is not there, the board stays empty."
              : "The favorite is not automatically the PBE Pick. Upset Radar isolates calls where the model's selected fighter was a market underdog at the recorded decision point."}
          </p>
        </div>
        <div className="pbe-upset-rule">
          <b>TRIGGER · +101 OR LONGER</b>
          <span>Consensus price at the recorded model snapshot. Mechanical rule — never an editorial label.</span>
        </div>
      </div>

      <div className="pbe-upset-standard" aria-label="Upset Radar signal standard">
        <span><i>01</i><b>PBE PICK</b><small>The model independently selects the fighter.</small></span>
        <span><i>02</i><b>PLUS MONEY</b><small>Consensus market price is +101 or longer.</small></span>
        <span><i>03</i><b>CURRENT SNAPSHOT</b><small>The comparison uses a recorded, still-current market.</small></span>
      </div>

      {access.pro === true ? (
        <div className="pbe-upset-current">
          <div className="pbe-upset-current-head">
            <div>
              <span className="eyebrow">{onPicksPage ? "Live on this PBE Picks board" : "UFC Pro only · current board"}</span>
              <strong>{onPicksPage ? "Plus-money PBE Picks with real model disagreement." : "Current PBE underdog calls"}</strong>
              {onPicksPage ? <small>Ranked by PBE Edge, then market price. No forced upset pick.</small> : null}
            </div>
            {onPicksPage
              ? <span className="pbe-upset-mode-chip">AUTO-RANKED · EDGE FIRST</span>
              : <Link href="/algo/record" className="btn">Full Track Record</Link>}
          </div>

          {current.length > 0 ? (
            <div className="pbe-upset-current-grid">
              {current.map((x, i) => (
                <article className="pbe-upset-current-card" key={x.boutId}>
                  <div className="pbe-upset-current-rank">#{String(i + 1).padStart(2, "0")} · UPSET SIGNAL</div>
                  <div className="between pbe-upset-current-top">
                    <span className={x.locked ? "pbe-upset-state locked" : "pbe-upset-state"}>{x.locked ? "OFFICIAL · LOCKED" : "PROVISIONAL"}</span>
                    <b>PBE PICK · {oddsText(x.odds)}</b>
                  </div>
                  <h4>{x.pickName}</h4>
                  <p>vs {x.opponentName}</p>
                  <small>{x.eventName} · {eventDateLabel(x.eventDate)}</small>

                  <div className="pbe-upset-current-metrics">
                    <span><em>MODEL</em><b>{pctText(x.probability)}</b></span>
                    <span><em>MARKET</em><b>{pctText(x.marketImplied)}</b></span>
                    <span><em>PBE EDGE</em><b>{deltaText(x.edgePts)}</b></span>
                    <span><em>BEST LINE</em><b>{x.bestOdds == null ? "—" : oddsText(x.bestOdds)}</b></span>
                  </div>

                  <div className="pbe-upset-thesis">
                    <span>MODEL VS MARKET</span>
                    <b>{x.edgePts == null ? "Price disagreement recorded" : `${deltaText(x.edgePts)} probability-point gap`}</b>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="pbe-upset-current-none">
              <b>NO LIVE UPSET SIGNAL RIGHT NOW.</b>
              <span>The model is not currently backing a plus-money fighter on the active board. That is a valid output — Upset Radar never invents a dog just to fill the module.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="pbe-upset-gate">
          <div>
            <span className="eyebrow">Current signals stay UFC Pro</span>
            <strong>See the fighter, model probability, market probability and PBE Edge when a live upset signal appears.</strong>
            <p>The public ledger shows only already-graded historical proof. Upcoming fighter calls remain behind the verified UFC Pro entitlement.</p>
          </div>
          <Link href="#pro" className="btn gold">Unlock Live Upset Radar</Link>
        </div>
      )}

      <div className="pbe-upset-history-head">
        <div>
          <span className="eyebrow">Permanent proof</span>
          <strong>Every graded underdog call stays on the ledger.</strong>
        </div>
        <span>No cherry-picked record. Showcase wins sit on top of the complete graded result set.</span>
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
        <div className="pbe-upset-empty compact">
          <b>LIVE LEDGER · WAITING FOR THE FIRST GRADED UNDERDOG CALL</b>
          <span>The model has not produced a graded official underdog call yet. We are not substituting a backtest winner for live proof.</span>
        </div>
      )}

      <div className="pbe-upset-receipt">
        <b>No hindsight. No backfill. No edited losses.</b>
        <span>Official calls lock before the fight; grades come from the stored result and revisions remain auditable.</span>
      </div>
    </section>
  );
}
