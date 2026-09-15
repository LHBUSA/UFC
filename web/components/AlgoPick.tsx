import Link from "next/link";
import type { PortraitSet } from "@/lib/db";
import { fighterSlug } from "@/lib/slug";
import { fmtRecord } from "@/lib/format";
import {
  FEATURES_TOTAL, REASON_COPY, algoStatus, pickOriented, bandEvidence, confidenceCopy, deltaText, drivers, lockedText, pctText, marketView, ageText, agoText, oddsText,
  type AlgoBoutView, type Driver,
} from "@/lib/algoView";

/* PBE Picks call card (the UFC Pro PBE Algo call). UFC Pro only: it is rendered
 * exclusively by pages that fetched the bout through lib/algo.ts, which refuses
 * a non-Pro caller, so a free render has no pick to pass in.
 *
 * Presentation only. Every value shown is read from the AlgoBoutView exactly
 * as before (pick, probability, confidence, lock state, market status and
 * delta); portraits come from getImagesForFighters() and records from the
 * fighter rows the page already reads. Nothing here scores, re-ranks or
 * decides eligibility.
 *
 * Market (owner decision 2026-09-15): the odds a customer can take (consensus
 * and best available, American, vig included) and the analytical comparison
 * (PBE Edge = PBE probability - de-vigged consensus probability) are separate
 * figures with separate labels, both in the primary hierarchy. */

const LOG_FEATURES = /log|quality_wins|five_round|title_exp/;
const RATE_FEATURES = new Set(["winrate_diff", "recent5_winrate_diff", "sig_accuracy_diff", "sig_defense_diff", "td_accuracy_diff", "td_defense_diff", "control_share_diff", "finish_rate_diff", "ko_rate_diff", "sub_rate_diff", "ko_loss_rate_diff", "sub_loss_rate_diff", "sos_diff", "pace_retention_diff"]);
const signed = (v: number, dp: number, unit = "") => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}${unit}`;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

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

export type AlgoFighterContext = { record_w: number | null; record_l: number | null; record_d: number | null; record_nc?: number | null; espn_athlete_id?: string | null; ufcstats_id?: string | null };

function Corner({ f, img, record, picked, called, odds }: { f: { id: string; name: string }; img?: PortraitSet | null; record?: AlgoFighterContext | null; picked: boolean; called: boolean; odds?: { value: number; current: boolean } | null }) {
  const display = img && (img.kind === "display_fallback" || img.source_family === "espn");
  const slugId = record?.espn_athlete_id || record?.ufcstats_id;
  const inner = (
    <>
      <span className={`pp-photo${display ? " display" : ""}`}>
        {img
          ? <img src={img.card} alt="" width={320} height={400} loading="lazy" decoding="async" />
          : <span className="pp-initials" aria-hidden="true">{initials(f.name)}</span>}
        {picked && <span className="pp-pick-tag">PBE Pick</span>}
      </span>
      <span className="pp-corner-name">{f.name}</span>
      {record && record.record_w != null && <span className="pp-corner-rec">{fmtRecord(record)}</span>}
      {odds && <span className={`pp-corner-odds${odds.current ? "" : " last"}`} title={odds.current ? "Current consensus odds" : "Last observed consensus odds"}>{oddsText(odds.value)}</span>}
    </>
  );
  const cls = `pp-corner${picked ? " picked" : ""}${called && !picked ? " other" : ""}`;
  const label = `${f.name}${picked ? ", the PBE pick" : ""}`;
  return slugId
    ? <Link href={`/fighters/${fighterSlug({ name: f.name, espn_athlete_id: record?.espn_athlete_id ?? null, ufcstats_id: record?.ufcstats_id ?? null })}`} className={cls} aria-label={label}>{inner}</Link>
    : <span className={cls} aria-label={label}>{inner}</span>;
}

export function AlgoPick({ b, detail = false, showEvent = false, imgs, fighters }: {
  b: AlgoBoutView; detail?: boolean; showEvent?: boolean;
  /** getImagesForFighters() result for this card, if the page read it. */
  imgs?: Map<string, PortraitSet>;
  /** Authoritative fighter rows (record) for this card, if the page read them. */
  fighters?: Map<string, AlgoFighterContext>;
}) {
  const status = algoStatus(b);
  const pickName = b.pick_fighter_id === b.fighter_a.id ? b.fighter_a.name : b.pick_fighter_id === b.fighter_b.id ? b.fighter_b.name : null;
  const oppName = pickName === b.fighter_a.name ? b.fighter_b.name : b.fighter_a.name;
  const p = b.prediction;
  const prob = p ? p.pick_probability : b.pick_probability;
  const locked = Boolean(p?.locked_at);
  /* A locked call's official comparison is its stored columns; anything else is
   * CURRENT only inside its fight-week window and never shows a stale edge. */
  const mv = marketView(b.market, { lockedAt: p?.locked_at ?? null });
  const lockedOfficial = locked && p!.model_edge_pts != null;
  const marketPick = lockedOfficial ? p!.market_implied_prob_pick : mv.implied;
  const delta = lockedOfficial ? p!.model_edge_pts : mv.delta;
  const marketState = lockedOfficial ? "CURRENT" : mv.state;
  const current = marketState === "CURRENT" && marketPick != null;
  const called = b.decision === "ELIGIBLE" && pickName && prob != null;
  const oddsFor = (id: string) => {
    const v = id === b.pick_fighter_id ? mv.pick.consensus : id === mv.opponent.fighterId ? mv.opponent.consensus : null;
    return called && v != null && marketState !== "UNAVAILABLE" ? { value: v, current } : null;
  };
  const windowText = mv.limitMinutes != null ? `${mv.band ? `${mv.band} ` : ""}${mv.limitMinutes >= 120 ? `${Math.floor(mv.limitMinutes / 60)}h${mv.limitMinutes % 60 ? ` ${mv.limitMinutes % 60}m` : ""}` : `${mv.limitMinutes}-minute`} window` : "freshness window";
  const dr = p && called ? drivers(p, b.fighter_a.id, b.fighter_b.id) : null;
  const maxC = dr ? Math.max(1e-9, ...dr.supporting.map((d) => d.contribution), ...dr.opposing.map((d) => -d.contribution)) : 1;
  const ev = called ? bandEvidence(prob) : null;
  const features = p ? Object.values(p.feature_availability || {}).filter(Boolean).length : b.features_available;
  const pickIsA = b.pick_fighter_id === b.fighter_a.id;
  const probA = called ? (pickIsA ? (prob as number) : 1 - (prob as number)) : null;
  const segment = b.card_position === "main" ? "Main card" : b.card_position === "prelim" ? "Prelims" : b.card_position === "early" ? "Early prelims" : "Card";

  const state = b.grade
    ? { label: `OFFICIAL PBE PICK · ${b.grade.result}`, sub: `Locked ${lockedText(p?.locked_at ?? null)} · graded`, tone: "graded" }
    : called && locked
      ? { label: "OFFICIAL PBE PICK", sub: `LOCKED · ${lockedText(p!.locked_at)}`, tone: "locked" }
      : called
        ? { label: "PRE-LOCK PBE PICK", sub: "Updates with new pre-fight data until lock", tone: "provisional" }
        : b.decision === "NO_MODEL_CALL"
          ? { label: "NO PBE PICK", sub: "Model passed on this fight", tone: "nocall" }
          : { label: status.label, sub: "Not evaluated yet", tone: "pending" };

  return (
    <article className={`pp ${called ? "pp-call" : "pp-pass"} ${state.tone}${detail ? " detail" : ""}`} data-algo-bout={b.bout_id} data-algo-status={status.label}>
      <header className="pp-top">
        <span className={`pp-state ${state.tone}`}>{state.label}</span>
        <span className="pp-state-sub">{state.sub}</span>
        <span className="pp-pos">{showEvent && <><Link href={`/events/${b.event_slug}`}>{b.event_name}</Link> · </>}{segment}</span>
      </header>

      <div className="pp-face">
        <Corner f={b.fighter_a} img={imgs?.get(b.fighter_a.id)} record={fighters?.get(b.fighter_a.id)} picked={Boolean(called) && pickIsA} called={Boolean(called)} odds={oddsFor(b.fighter_a.id)} />
        <div className="pp-center">
          {called ? (
            <>
              <div className="pp-kicker">PBE Pick</div>
              <div className="pp-name">{pickName}</div>
              <div className="pp-prob"><b>{pctText(prob)}</b> win probability</div>
              <div className={`pp-conf c-${(b.confidence || "").toLowerCase()}`}>{confidenceCopy(b.confidence)} confidence</div>
            </>
          ) : b.decision === "NO_MODEL_CALL" ? (
            <>
              <div className="pp-kicker muted">No PBE Pick</div>
              <div className="pp-pass-line">Model passed on this fight</div>
            </>
          ) : (
            <div className="pp-pass-line">Not evaluated yet</div>
          )}
        </div>
        <Corner f={b.fighter_b} img={imgs?.get(b.fighter_b.id)} record={fighters?.get(b.fighter_b.id)} picked={Boolean(called) && !pickIsA} called={Boolean(called)} odds={oddsFor(b.fighter_b.id)} />
      </div>

      <h3 className="pp-matchup"><Link href={`/fights/${b.fight_slug}`}>{b.fighter_a.name} <span>vs</span> {b.fighter_b.name}</Link></h3>

      {called ? (
        <>
          <div className="pp-bar" role="img" aria-label={`${pickName} ${pctText(prob)}, ${oppName} ${pctText(1 - (prob as number))}`}>
            <span className={`seg a${pickIsA ? " pick" : ""}`} style={{ flexBasis: `${(probA as number) * 100}%` }}><em>{b.fighter_a.name}</em><b>{pctText(probA, 0)}</b></span>
            <span className={`seg b${!pickIsA ? " pick" : ""}`} style={{ flexBasis: `${(1 - (probA as number)) * 100}%` }}><b>{pctText(1 - (probA as number), 0)}</b><em>{b.fighter_b.name}</em></span>
          </div>

          <dl className={`pp-primary market-${marketState.toLowerCase()}`}>
            <div className="pp-cell pick"><dt>PBE Pick</dt><dd>{pickName}</dd></div>
            <div className="pp-cell"><dt>PBE probability</dt><dd>{pctText(prob)}</dd></div>
            <div className="pp-cell odds"><dt>{marketState === "LAST_OBSERVED" ? "Last observed" : "Market"}</dt><dd>{marketState !== "UNAVAILABLE" && mv.pick.consensus != null ? <>{oddsText(mv.pick.consensus)} <small>consensus</small></> : marketState === "LAST_OBSERVED" ? <span className="algo-stale">Not recorded</span> : "No current market"}</dd></div>
            <div className="pp-cell odds"><dt>Best odds</dt><dd>{marketState !== "UNAVAILABLE" && mv.pick.best != null ? <>{oddsText(mv.pick.best)}{mv.pick.book && <small className="book">{mv.pick.book}</small>}</> : "\u2014"}</dd></div>
            <div className="pp-cell"><dt>Market implied</dt><dd>{current ? pctText(marketPick) : marketState === "LAST_OBSERVED" ? <span className="algo-stale">Not current</span> : "\u2014"}</dd></div>
            <div className={`pp-cell delta ${delta == null ? "" : delta >= 0 ? "pos" : "neg"}`}><dt>PBE Edge</dt><dd>{current && delta != null ? deltaText(delta) : marketState === "LAST_OBSERVED" ? <span className="algo-stale">Hidden</span> : "\u2014"}</dd></div>
          </dl>

          <div className={`pp-market ${marketState === "CURRENT" ? "fresh" : marketState === "LAST_OBSERVED" ? "stale" : "unavailable"}`}>
            {current ? (
              <span className="pp-market-flag"><b>{lockedOfficial ? "Market at lock" : "Current market"}</b>{lockedOfficial ? `observed ${ageText(mv.age)} before lock` : `Observed ${agoText(mv.age)}`}{mv.books != null ? ` · ${mv.books} book${mv.books === 1 ? "" : "s"}` : ""}{mv.opponent.consensus != null ? ` · ${oppName} ${oddsText(mv.opponent.consensus)}${mv.opponent.best != null ? ` (best ${oddsText(mv.opponent.best)}${mv.opponent.book ? ` ${mv.opponent.book}` : ""})` : ""}` : ""}</span>
            ) : marketState === "LAST_OBSERVED" ? (
              <span className="pp-market-flag"><b>Last observed</b>{agoText(mv.age)}, outside the {windowText}. No PBE Edge is published from it.</span>
            ) : (
              <span className="pp-market-flag"><b>No current market</b>no two-sided price is on file for this bout.</span>
            )}
          </div>

          <dl className="pp-secondary">
            <div><dt>Data quality</dt><dd>{features ?? "\u2014"}/{FEATURES_TOTAL} features</dd></div>
            <div><dt>Confidence</dt><dd>{confidenceCopy(b.confidence)}</dd></div>
            <div><dt>Locked</dt><dd>{locked ? lockedText(p!.locked_at) : "Not yet locked"}</dd></div>
            <div><dt>Model</dt><dd className="mono">{b.model_version ?? "\u2014"}</dd></div>
          </dl>

          {!locked && <p className="algo-note">Pre-lock. The pick regenerates hourly from the latest eligible pre-fight data and can change until it locks on the database clock. Once locked, it becomes part of the official PBE record.</p>}
          {current && delta != null && (
            <p className="algo-note">PBE Edge = PBE probability {pctText(prob)} − de-vigged market probability {pctText(marketPick)} = {deltaText(delta)}. Odds are prices you could take: consensus is the median implied probability across {mv.books ?? "the"} book{mv.books === 1 ? "" : "s"} converted back to American odds, vig included (raw implied {pctText(mv.raw)}); best odds is the most favourable price in the same snapshot. The edge is measured against the de-vigged consensus, never the vigged price. The market is compared after scoring and is never a model input.</p>
          )}
          {marketState === "LAST_OBSERVED" && <p className="algo-note algo-market-stale">These are the last odds PropBetEdge observed{mv.observedAt ? ` (${lockedText(mv.observedAt)})` : ""}. A fight-week snapshot is current for 12h 10m until 72 hours before lock, 6h 10m until the final day, and 60 minutes in the final 24 hours; past that no PBE Edge is published. The model call does not depend on the market.</p>}
        </>
      ) : b.decision === "NO_MODEL_CALL" ? (
        <div className="algo-nocall">
          <b>Why there is no pick</b>
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
          <summary>Why PBE Picks this fighter</summary>
          {dr ? (
            <div className="algo-why-grid">
              <DriverList title="Strongest factors" items={dr.supporting} tone="for" max={maxC} />
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
