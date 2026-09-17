import Link from "next/link";
import type { UfcAccess } from "@/lib/accessDecision";
import type { PortraitSet } from "@/lib/db";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import { getAlgoCards, type AlgoUpsetProof } from "@/lib/algo";
import { agoText, deltaText, drivers, marketView, oddsText, pctText } from "@/lib/algoView";

type CurrentUnderdog = {
  boutId: string;
  eventName: string;
  eventDate: string;
  fighterId: string;
  pickName: string;
  opponentName: string;
  odds: number;
  bestOdds: number | null;
  probability: number;
  marketImplied: number | null;
  edgePts: number | null;
  locked: boolean;
  marketState: "CURRENT" | "LAST_OBSERVED";
  generatedAt: string;
  marketAgeMinutes: number | null;
  supporting: Array<{ key: string; label: string; doc: string; pickMinusOpponent: number }>;
  opposing: Array<{ key: string; label: string; doc: string; pickMinusOpponent: number }>;
};

function eventDateLabel(v: string): string {
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function modelTimeLabel(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

function driverDeltaText(d: { key: string; pickMinusOpponent: number; doc: string }): string {
  const v = Number(d.pickMinusOpponent);
  if (!Number.isFinite(v)) return d.doc;
  const signed = (n: number, dp = 1) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}`;
  if (d.key === "reach_diff_in" || d.key === "height_diff_in") return `${signed(v)} in vs opponent`;
  if (d.key === "age_diff_years") return `${Math.abs(v).toFixed(1)} yrs ${v >= 0 ? "older" : "younger"}`;
  if (d.key === "streak_diff") return `${signed(v, 0)} fight streak gap`;
  if (d.key.includes("per15")) return `${signed(v, 2)} per 15 vs opponent`;
  if (d.key.includes("per_min") || d.key === "slpm_diff" || d.key === "sapm_diff") return `${signed(v, 2)} per min vs opponent`;
  if (/rate|accuracy|defense|share|retention/.test(d.key)) return `${signed(v * 100)} pts vs opponent`;
  return d.doc;
}

type AlgoCards = Awaited<ReturnType<typeof getAlgoCards>>;
type Surface = "pro" | "picks";

export async function PbeUpsetRadar({
  access,
  proof,
  cards: providedCards,
  imgs,
  surface = "pro",
}: {
  access: Pick<UfcAccess, "pro">;
  proof: AlgoUpsetProof;
  cards?: AlgoCards;
  imgs?: Map<string, PortraitSet>;
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
      if (mv.state === "UNAVAILABLE" || odds == null || odds <= proof.threshold_odds) return [];
      const pick = b.pick_fighter_id === b.fighter_a.id ? b.fighter_a : b.fighter_b;
      const opponent = pick.id === b.fighter_a.id ? b.fighter_b : b.fighter_a;
      const modelDrivers = drivers(p, b.fighter_a.id, b.fighter_b.id);
      return [{
        boutId: b.bout_id,
        eventName: card.event_name,
        eventDate: card.event_date,
        fighterId: pick.id,
        pickName: pick.name,
        opponentName: opponent.name,
        odds,
        bestOdds: mv.pick.best,
        probability: Number(p.pick_probability),
        marketImplied: mv.implied,
        edgePts: mv.state === "CURRENT" ? (mv.delta ?? (p.model_edge_pts == null ? null : Number(p.model_edge_pts))) : mv.historicalDelta,
        locked: Boolean(p.locked_at),
        marketState: mv.state,
        generatedAt: p.generated_at,
        marketAgeMinutes: mv.age,
        supporting: modelDrivers.supporting.slice(0, 3).map((d) => ({ key: d.key, label: d.label, doc: d.doc, pickMinusOpponent: d.pickMinusOpponent })),
        opposing: modelDrivers.opposing.slice(0, 1).map((d) => ({ key: d.key, label: d.label, doc: d.doc, pickMinusOpponent: d.pickMinusOpponent })),
      }];
    }))
      .sort((a, b) => Number(b.marketState === "CURRENT") - Number(a.marketState === "CURRENT") || (b.edgePts ?? -999) - (a.edgePts ?? -999) || b.odds - a.odds)
      .slice(0, 3);
  }

  const onPicksPage = surface === "picks";
  const primary = current[0] ?? null;
  let primaryImg = primary ? imgs?.get(primary.fighterId) ?? null : null;

  // The sidecar is a high-visibility surface. If the page-level portrait map
  // missed the selected underdog, make one targeted identity-verified lookup
  // rather than degrading a real signal into a text-only placeholder.
  if (primary && !primaryImg) {
    const fallback = await getVerifiedDisplayImagesForFighters([primary.fighterId]);
    primaryImg = fallback.get(primary.fighterId) ?? null;
  }

  const primaryDisplay = primaryImg && (primaryImg.kind === "display_fallback" || primaryImg.source_family === "espn");

  if (onPicksPage) {
    return (
      <section className="pbe-upset-rail-window" aria-labelledby="pbe-upset-rail-title">
        <div className="pbe-upset-rail-tab">
          <i aria-hidden="true" />
          <span>UPSET RADAR</span>
          <b>AUTO · 60S</b>
        </div>

        <div className="pbe-upset-rail-body">
          <div className={`pbe-upset-radar-visual compact${primary ? " signal" : " idle"}`}>
            <div className="pbe-upset-radar-pane">
              <svg className="pbe-upset-radar-svg" viewBox="0 0 240 240" aria-hidden="true">
                <circle cx="120" cy="120" r="92" className="scope-ring outer" />
                <circle cx="120" cy="120" r="68" className="scope-ring" />
                <circle cx="120" cy="120" r="44" className="scope-ring" />
                <circle cx="120" cy="120" r="20" className="scope-ring" />
                <line x1="28" y1="120" x2="212" y2="120" className="scope-axis" />
                <line x1="120" y1="28" x2="120" y2="212" className="scope-axis" />
                <g className="scope-sweep">
                  <path d="M120 120 L120 28 A92 92 0 0 1 190 60 Z" className="scope-beam" />
                  <line x1="120" y1="120" x2="190" y2="60" className="scope-sweep-line" />
                </g>
                <circle cx="76" cy="145" r="4" className="scope-blip" />
                <circle cx="164" cy="82" r="3" className="scope-blip faint" />
                <circle cx="120" cy="120" r="5" className="scope-origin" />
              </svg>

              <div className="pbe-upset-radar-visual-label">
                <i />
                <span>{primary ? `${primary.marketState === "CURRENT" ? "LIVE" : "LAST"} · ${oddsText(primary.odds)}` : "CLEAR"}</span>
              </div>
            </div>

            <div className="pbe-upset-radar-photo-pane">
              {primary && primaryImg ? (
                <div className={`pbe-upset-radar-fighter${primaryDisplay ? " display" : ""}`}>
                  <img src={primaryImg.card || primaryImg.portrait} alt={primary.pickName} width={260} height={325} loading="eager" decoding="async" />
                </div>
              ) : null}
            </div>

            {primary ? (
              <div className="pbe-upset-radar-visual-name">
                <b>{primary.pickName}</b>
                <span>vs {primary.opponentName}</span>
              </div>
            ) : (
              <div className="pbe-upset-radar-visual-name quiet">
                <b>Radar clear</b>
                <span>No plus-money PBE pick on the active board.</span>
              </div>
            )}
          </div>

          <header className="pbe-upset-rail-head">
            <div className="eyebrow">PBE Picks · model vs market</div>
            <h3 id="pbe-upset-rail-title">Upset Radar</h3>
            <p>Plus-money PBE picks only. The visual lights up when the model and market split.</p>
          </header>

          <div className="pbe-upset-rail-rule">
            <span><b>+101+</b> consensus</span>
            <span><b>PBE PICK</b> required</span>
            <span><b>AUTO</b> freshness</span>
          </div>

          {access.pro ? (
            current.length > 0 ? (
              <div className="pbe-upset-rail-signals">
                {current.slice(0, 2).map((x, i) => (
                  <article className="pbe-upset-rail-signal" key={x.boutId}>
                    <div className="pbe-upset-rail-signal-top">
                      <span>#{i + 1} · {x.locked ? "LOCKED" : "PROVISIONAL"} · {x.marketState === "CURRENT" ? "CURRENT" : "LAST OBSERVED"}</span>
                      <b>{oddsText(x.odds)}</b>
                    </div>
                    <h4>{x.pickName}</h4>
                    <p>vs {x.opponentName}</p>
                    <small>{x.eventName} · {eventDateLabel(x.eventDate)}</small>
                    <div className="pbe-upset-rail-metrics">
                      <span><em>MODEL</em><b>{pctText(x.probability)}</b></span>
                      <span><em>MARKET</em><b>{pctText(x.marketImplied)}</b></span>
                      <span><em>{x.marketState === "CURRENT" ? "EDGE" : "LAST EDGE"}</em><b>{deltaText(x.edgePts)}</b></span>
                    </div>

                    {i === 0 ? (
                      <div className="pbe-upset-rail-why">
                        <div className="pbe-upset-rail-why-head">
                          <span>WHY PBE SEES THE UPSET</span>
                          <b>MODEL DRIVERS</b>
                        </div>
                        <div className="pbe-upset-rail-gap">
                          <b>{pctText(x.probability)} PBE</b>
                          <span>vs {pctText(x.marketImplied)} market · {deltaText(x.edgePts)} {x.marketState === "CURRENT" ? "edge" : "stored gap"}</span>
                        </div>
                        {x.supporting.length > 0 ? (
                          <div className="pbe-upset-rail-driver-list">
                            {x.supporting.map((d, n) => (
                              <div className="pbe-upset-rail-driver" key={`${d.key}-${n}`}>
                                <i>{n + 1}</i>
                                <span>
                                  <b>{d.label}</b>
                                  <small>{driverDeltaText(d)}</small>
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="pbe-upset-rail-driver-none">No individual feature driver is available for this stored prediction.</p>
                        )}
                        {x.opposing[0] ? (
                          <div className="pbe-upset-rail-counter">
                            <span>COUNTER-SIGNAL</span>
                            <b>{x.opposing[0].label}</b>
                          </div>
                        ) : null}
                        <p className="pbe-upset-rail-method">Derived from the stored pre-fight feature vector × the live model coefficients. No generated narrative.</p>
                      </div>
                    ) : null}

                    <div className="pbe-upset-rail-freshness">
                      <span>MODEL {modelTimeLabel(x.generatedAt)}</span>
                      <span>MARKET {agoText(x.marketAgeMinutes)}</span>
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
