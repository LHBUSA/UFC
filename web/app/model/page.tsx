import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, SectionHead, JsonLd } from "@/components/ui";
import { ModelProbability } from "@/components/ModelProbability";
import { PbeFamilyNav } from "@/components/PbeFamilyNav";
import {
  MODEL, getLiveState, pct, pts, num3, divisionLabel,
  type ModelExample,
} from "@/lib/model";
import { MODEL_FACTS, illustrativeEdge } from "@/lib/pbeProduct";
import { getUfcAccess } from "@/lib/access";
import { SITE } from "@/lib/site";

/* /model is the evidence page for the PBE Picks product family: what the model
 * is, why it is different, the proof, then the full method. It never renders a
 * current call. The live record and the backtest stay separate sections from
 * separate sources and are never combined. Every product number comes from the
 * release artifact or lib/pbeProduct.ts, never typed into prose. */

export const revalidate = 300;

const TITLE = "PBE Fight Model — UFC Win Probability Model vs Sportsbook Odds";
const DESCRIPTION = `${MODEL_FACTS.displayName} is PropBetEdge's independent UFC fight model: a win probability from ${MODEL_FACTS.featureCount} pre-fight Fight DNA features with ${MODEL_FACTS.sportsbookInputs} sportsbook inputs, compared with the de-vigged fight-week market to measure PBE Edge. Live record, walk-forward backtest, calibration and leakage proof.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: ["UFC prediction model", "UFC win probability model", "UFC fight model", "model vs sportsbook odds", "de-vigged market probability", "PBE Edge", "UFC analytics", "PBE Picks", "PropBetEdge"],
  alternates: { canonical: "/model" },
  openGraph: {
    title: "PBE Fight Model — an independent probability, a real market price, PBE Edge",
    description: `Independent UFC win probabilities from ${MODEL_FACTS.featureCount} pre-fight features, no sportsbook inputs. Compared with the de-vigged market after scoring. Live record and walk-forward evidence, published in full.`,
    url: `${SITE.url}/model`,
    images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", title: "PBE Fight Model — UFC win probability vs the market", description: "An independent probability. A real market price. The difference is PBE Edge.", images: [`${SITE.url}/opengraph-image`] },
};

const Stat = ({ label, value, sub, empty }: { label: string; value: string; sub?: string; empty?: boolean }) => (
  <div className="stat model">
    <b className={empty ? "empty" : undefined}>{value}</b>
    <span>{label}</span>
    {sub && <span style={{ color: "var(--pbe-subtle)", textTransform: "none", letterSpacing: 0 }}>{sub}</span>}
  </div>
);

function ExampleCard({ e }: { e: ModelExample }) {
  return (
    <div>
      <ModelProbability
        a={e.fighter_a}
        b={e.fighter_b}
        marketImpliedA={e.market ? (e.fighter_a.prob >= e.fighter_b.prob ? e.market.implied_pick : 1 - e.market.implied_pick) : null}
        marketBooks={e.market?.books ?? null}
        modelVersion={MODEL.model.model_version}
        featureVersion={MODEL.model.feature_version}
        sample={{
          minPriorBouts: e.sample_context.min_prior_bouts,
          minStatBouts: e.sample_context.min_stat_bouts,
          featuresAvailable: e.sample_context.features_available,
          featuresTotal: e.sample_context.features_total,
        }}
        settled={{ winnerName: e.winner_name, outcome: e.outcome, method: e.result_method }}
        kicker={`Backtest · ${e.event_date} · ${divisionLabel(e.weight_class, e.is_womens)}`}
        disclaimer="Backtest output. Not a PBE Pick."
      />
      {e.note && <p className="mdl-example-note">{e.note}</p>}
    </div>
  );
}

const LIFECYCLE: Array<[string, string]> = [
  ["Discover", "Every UFC card inside the horizon is picked up by the hourly scheduler."],
  ["Verify", "Both fighters resolve to one reconciled identity with current Fight DNA."],
  ["Score", `${MODEL_FACTS.featureCount} pre-fight features become an independent PBE probability.`],
  ["Compare", "The current fight-week market is de-vigged and PBE Edge is measured."],
  ["Regenerate", "Until lock, new pre-fight inputs can change the call, every hour."],
  ["Lock", "The prediction is written on the database clock and becomes immutable."],
  ["Grade", "The official result enters the record; corrections are dated revisions."],
];

export default async function ModelPage() {
  const [live, access] = await Promise.all([getLiveState(), getUfcAccess()]);
  const ev = MODEL.evidence;
  const m = ev.model;
  const audit = MODEL.leakage_audit;
  const x = illustrativeEdge();
  const locked = live.record?.locked_predictions ?? 0;

  return (
    <div className="wrap page mdl-page">
      {/* ------------------------------------------------------------------
          1. WHAT IT IS
      ------------------------------------------------------------------- */}
      <header className="mdl-hero" id="top">
        <Breadcrumbs items={[{ name: "PBE Model" }]} />
        <div className="mdl-hero-grid">
          <div className="mdl-hero-copy">
            <p className="mdl-hero-eyebrow"><i aria-hidden="true" />{MODEL_FACTS.displayName}</p>
            <h1 className="mdl-hero-title">
              <span>An independent probability.</span>
              <span>A real market price.</span>
              <span className="edge">The difference is PBE Edge.</span>
            </h1>
            <p className="mdl-hero-lede">
              PBE builds its own win probability from pre-fight Fight DNA. Sportsbook odds never enter the model. Once the
              probability exists, PropBetEdge independently reads the fight-week market, removes the vig and measures the disagreement.
            </p>
            <ul className="mdl-proof" aria-label="Model facts">
              <li><b>{MODEL_FACTS.featureCount}</b> pre-fight features</li>
              <li><b>{MODEL_FACTS.sportsbookInputs}</b> sportsbook inputs</li>
              <li>Hourly pre-lock</li>
              <li>Locked before the fight</li>
              <li>Public live record</li>
            </ul>
            <div className="mdl-hero-cta">
              {access.pro
                ? <Link href="/algo/card" className="btn gold mdl-cta-main">Open PBE Picks</Link>
                : <Link href="/pro" className="btn gold mdl-cta-main">Unlock PBE Picks</Link>}
              <Link href={access.pro ? "/algo/record" : "/algo#record"} className="btn">Track record</Link>
              <a href="#how-it-works" className="btn ghost">How the model works</a>
            </div>
          </div>

          <aside className="mdl-instrument" aria-label="Model identity">
            <div className="mdl-instrument-head"><span>Model identity</span><span className="mono">{MODEL_FACTS.modelVersion}</span></div>
            <dl>
              <div><dt>Inputs</dt><dd>{MODEL_FACTS.featureCount} pre-fight features · {MODEL_FACTS.sportsbookInputs} odds</dd></div>
              <div><dt>Trained on</dt><dd>{MODEL_FACTS.trainingBouts.toLocaleString("en-US")} graded bouts</dd></div>
              <div><dt>Out of sample</dt><dd>{MODEL_FACTS.outOfSampleFights.toLocaleString("en-US")} fights · Brier {num3(m.brier)}</dd></div>
              <div><dt>Calibration</dt><dd>ECE {num3(m.calibration_ece, 4)}</dd></div>
              <div><dt>Live record</dt><dd>{locked ? `${locked} locked call${locked === 1 ? "" : "s"}` : "Opens at the first lock"}</dd></div>
              <div><dt>Spec hash</dt><dd className="mono">{MODEL_FACTS.specSha256.slice(0, 12)}…</dd></div>
            </dl>
            <p className="mdl-instrument-foot">Walk-forward evidence and the live record are reported separately below and never combined.</p>
          </aside>
        </div>
        <nav className="mdl-jump" aria-label="On this page">
          <a href="#edge">Why it&apos;s different</a>
          <a href="#live">Proof</a>
          <a href="#method-deep">Methodology</a>
        </nav>
      </header>

      {/* ------------------------------------------------------------------
          2. WHY IT'S DIFFERENT
      ------------------------------------------------------------------- */}
      <section className="mdl-sec" id="edge">
        <SectionHead eyebrow="Why it's different" title="Probability → Market → PBE Edge" />
        <div className="mdl-flow" role="group" aria-label="Illustrative example, not a current pick">
          <p className="mdl-illus">Illustrative example — not a current pick</p>
          <ol className="mdl-flow-steps">
            <li className="model">
              <span className="mdl-flow-k">PBE probability</span>
              <b>{(x.modelProbability * 100).toFixed(1)}%</b>
              <span className="mdl-flow-s">Built independently</span>
            </li>
            <li className="market" aria-label="then">
              <span className="mdl-flow-k">Market</span>
              <b>{(x.devigPick * 100).toFixed(1)}%</b>
              <span className="mdl-flow-s">De-vigged consensus</span>
            </li>
            <li className="edge">
              <span className="mdl-flow-k">PBE Edge</span>
              <b>{pts(x.edgePts)}</b>
              <span className="mdl-flow-s">Model − Market</span>
            </li>
          </ol>
          <p className="mdl-flow-math">
            Books offer <b>{x.pickOdds > 0 ? `+${x.pickOdds}` : x.pickOdds}</b> / <b>+{x.opponentOdds}</b> → raw implied {(x.rawPick * 100).toFixed(1)}% + {(x.rawOpponent * 100).toFixed(1)}% = {(x.overround * 100).toFixed(1)}% → vig removed → <b>{(x.devigPick * 100).toFixed(1)}%</b> → {(x.modelProbability * 100).toFixed(1)}% − {(x.devigPick * 100).toFixed(1)}% = <b>{pts(x.edgePts)}</b>
          </p>
        </div>
        <ul className="mdl-explain">
          <li><b>American odds</b> are what the books actually offer. PBE Picks shows the consensus price and the best available price with its book.</li>
          <li><b>Raw implied probability contains vig.</b> Both sides of a fight add up to more than 100%; that excess is the book&apos;s margin.</li>
          <li><b>PBE removes the vig</b> across the current observed market: the median across books, normalised so both sides sum to 100%.</li>
          <li><b>PBE Edge</b> compares the model probability with that de-vigged market probability, in percentage points. It is never measured against a vigged price.</li>
          <li><b>Market data is read only after the model has scored the fight.</b> A price never changes a probability, and a stale price never publishes an edge.</li>
        </ul>
      </section>

      <section className="mdl-sec" id="how-it-works">
        <SectionHead eyebrow="The differentiator" title="The model doesn't follow the market" />
        <div className="mdl-lanes">
          <div className="mdl-lane model">
            <div className="mdl-lane-head">PBE model lane</div>
            <ol>
              <li><b>Fight DNA</b><span>As of the event date, from repaired fight history</span></li>
              <li><b>{MODEL_FACTS.featureCount} pre-fight features</b><span>Differences between the two corners</span></li>
              <li className="out"><b>PBE probability</b><span>Scored before any price is read</span></li>
            </ol>
          </div>
          <div className="mdl-lane-wall" aria-hidden="true"><span>No data crosses</span></div>
          <div className="mdl-lane market">
            <div className="mdl-lane-head">Market lane</div>
            <ol>
              <li><b>Sportsbook prices</b><span>Fight-week snapshots of American odds</span></li>
              <li><b>Multi-book consensus</b><span>Median across the books in one snapshot</span></li>
              <li className="out"><b>Vig removed</b><span>De-vigged market probability</span></li>
            </ol>
          </div>
          <div className="mdl-lane-join">
            <span className="model">PBE probability</span><i>−</i><span className="market">market probability</span><i>=</i><span className="edge">PBE Edge</span>
          </div>
        </div>
        <p className="note">
          The {MODEL_FACTS.featureCount} inputs are all pre-fight Fight DNA differences; {MODEL_FACTS.sportsbookInputs} of them come from a sportsbook.
          The two lanes meet only at the final subtraction, which is why PBE Edge can disagree with the market at all.
        </p>
      </section>

      <section className="mdl-sec" id="lifecycle">
        <SectionHead eyebrow="Product lifecycle" title="From card to graded record" href="/algo" cta="How PBE Algo calls a fight" />
        <ol className="mdl-life">
          {LIFECYCLE.map(([h, p], i) => (
            <li key={h}><span className="mdl-life-n">{i + 1}</span><b>{h}</b><p>{p}</p></li>
          ))}
        </ol>
      </section>

      {/* ------------------------------------------------------------------
          3. PROOF. The live record first, never mixed with the backtest.
      ------------------------------------------------------------------- */}
      <section className="mdl-sec" id="live">
        <SectionHead eyebrow="Proof · live record" title="What the model has actually done" />
        <div className="mdl-status">
          <div>
            <h2>
              {live.status === "publishing" ? `${live.record?.wins}-${live.record?.losses}${live.record?.no_decision ? `-${live.record.no_decision}` : ""}`
                : live.status === "publishing_ungraded" ? "Awaiting the first result"
                : "The record opens at the first lock"}
            </h2>
            <p>
              {live.reason ||
                `Locked before the fight, graded after it, never edited in between. ${live.record?.locked_predictions ?? 0} calls locked to date.`}
            </p>
            <p style={{ marginTop: "var(--s-3)" }}>
              A call enters this record only once it has been locked <em>before</em> the bout, and the lock time is the
              database&rsquo;s own clock, not a timestamp supplied by whatever wrote the row. From that moment the probability, the pick,
              the model version and the feature vector are frozen: there is no permitted edit to a locked prediction at all. That is a
              storage-layer guarantee rather than a promise made in application code. Pre-lock picks regenerate and are never counted.
            </p>
            <p style={{ marginTop: "var(--s-3)" }}>
              Results are kept separately, because a result is not a prediction. Combat-sports outcomes get overturned on appeal and
              corrected by commissions, so a grade can be revised, as a new entry that supersedes the last one and has to say why.
              The record you see follows the current entry; every superseded one stays on file.
              {live.record && live.record.revised_grades > 0
                ? ` ${live.record.revised_grades} result${live.record.revised_grades === 1 ? " has" : "s have"} been revised so far.`
                : ""}
            </p>
          </div>
        </div>

        <div className="mdl-rec">
          <Stat label="Locked calls" value={String(locked)} empty={!locked} sub={locked ? undefined : "none locked yet"} />
          <Stat label="Record" value={live.status === "publishing" ? `${live.record?.wins}-${live.record?.losses}` : "0-0"} empty={live.status !== "publishing"} />
          <Stat label="Hit rate" value={pct(live.record?.hit_rate)} empty={live.record?.hit_rate == null} />
          <Stat label="Brier" value={num3(live.record?.brier ?? null)} empty={live.record?.brier == null} sub="lower is better" />
          <Stat label="Awaiting result" value={live.record ? String(live.record.pending) : "—"} empty={!live.record?.pending} />
          <Stat label="Last 30" value={live.recent ? `${live.recent.wins}-${live.recent.losses}` : "—"} empty={!live.recent} />
          <Stat label="No contest / draw" value={live.record ? String(live.record.no_decision) : "—"} empty={!live.record?.no_decision} />
          <Stat label="Results revised" value={live.record ? String(live.record.revised_grades) : "—"} empty={!live.record?.revised_grades} sub="overturned or corrected" />
        </div>

        {live.calibration.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <caption className="sr-only">Live calibration by probability band</caption>
              <thead><tr><th>Band</th><th className="r">Decided</th><th className="r">Wins</th><th className="r">Claimed</th><th className="r">Happened</th></tr></thead>
              <tbody>{live.calibration.map((c) => <tr key={c.confidence_band}><td>{c.confidence_band}%</td><td className="r">{c.decided}</td><td className="r">{c.wins}</td><td className="r">{pct(c.predicted)}</td><td className="r">{pct(c.observed)}</td></tr>)}</tbody>
            </table>
          </div>
        )}

        <p className="mdl-split-note">
          <b>This record and the backtest below are never combined.</b> They answer different questions. A backtest says what the
          model would have done on fights whose results already existed somewhere; a live record says what it did with the future
          genuinely unknown. They are stored in separate tables, reported by separate views, and there is deliberately no query in
          this product that adds them together.
        </p>
      </section>

      <section className="mdl-sec" id="backtest">
        <SectionHead eyebrow="Proof · out-of-sample backtest" title="What the model would have done" />
        <p className="note">
          {ev.out_of_sample.n.toLocaleString()} bouts scored between {ev.out_of_sample.first_event} and {ev.out_of_sample.last_event}.
          Every fold trains only on bouts that had already happened and is scored only on bouts that had not; the model is refit from
          scratch each calendar year, and the ridge penalty is chosen on an inner chronological split of the training window, never on
          the year being scored. There is no random train/test split anywhere in this pipeline — with fighters recurring across years,
          a random split would let the model learn how a career turned out before predicting its middle.
        </p>

        <div className="mdl-rec">
          <Stat label="Brier" value={num3(m.brier)} sub={`${pct(ev.brier_skill_vs_coin, 2)} better than a coin`} />
          <Stat label="Log loss" value={num3(m.log_loss)} sub={`coin = ${num3(Math.log(2))}`} />
          <Stat label="Accuracy" value={pct(m.accuracy, 2)} />
          <Stat label="ROC AUC" value={num3(m.auc, 4)} />
          <Stat label="Calibration ECE" value={num3(m.calibration_ece, 4)} sub={`slope ${num3(m.calibration_slope, 3)}`} />
          <Stat label="Fights scored" value={ev.out_of_sample.n.toLocaleString()} />
        </div>

        <div className="tbl-wrap">
          <table className="tbl">
            <caption className="sr-only">Model against its baselines, same fights</caption>
            <thead>
              <tr><th>Benchmark</th><th className="r">Fights</th><th className="r">Brier</th><th className="r">Log loss</th><th className="r">Accuracy</th><th className="r">AUC</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><b style={{ color: "var(--pbe-model)" }}>{MODEL_FACTS.displayName}</b></td>
                <td className="r">{m.n.toLocaleString()}</td><td className="r">{num3(m.brier)}</td><td className="r">{num3(m.log_loss)}</td>
                <td className="r">{pct(m.accuracy, 2)}</td><td className="r">{num3(m.auc, 4)}</td>
              </tr>
              <tr>
                <td>50/50 baseline</td>
                <td className="r">{ev.coin.n.toLocaleString()}</td><td className="r">{num3(ev.coin.brier)}</td><td className="r">{num3(ev.coin.log_loss)}</td>
                <td className="r">{pct(ev.coin.accuracy, 2)}</td><td className="r">—</td>
              </tr>
              <tr>
                <td>Historical win-rate baseline</td>
                <td className="r">{ev.winrate.n.toLocaleString()}</td><td className="r">{num3(ev.winrate.brier)}</td><td className="r">{num3(ev.winrate.log_loss)}</td>
                <td className="r">{pct(ev.winrate.accuracy, 2)}</td><td className="r">{num3(ev.winrate.auc, 4)}</td>
              </tr>
              <tr>
                <td>Market implied (de-vigged)</td>
                <td className="r">{ev.market.n ? ev.market.n.toLocaleString() : "0"}</td>
                <td className="r" colSpan={4} style={{ textAlign: "left", color: "var(--pbe-faint)", fontFamily: "var(--pbe-font-ui)" }}>
                  {ev.market.n ? `${num3((ev.market as { brier?: number }).brier ?? null)}` : "No completed bout in the release backtest carries a market observation recorded before it started, so no market benchmark is shown here. It is not estimated."}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note">
          Brier and log loss lead because they are proper scoring rules: only the true probability minimises them, so a model cannot
          improve them by being confidently wrong. Accuracy is shown because people ask for it, but a model that says 51% and is right
          is not the same product as one that says 80% and is right, and accuracy cannot tell them apart.
        </p>
      </section>

      <section className="mdl-sec" id="calibration">
        <SectionHead eyebrow="Proof · calibration" title="Does 62% mean 62%" />
        <p className="note">
          Both corners of a bout are the same prediction stated two ways, so every row below is folded onto the side the model
          actually picked: confidence is max(p, 1−p) and a hit is that pick winning. The gold line is what happened; the blue block
          is what was claimed.
        </p>
        <div className="mdl-two">
          <div className="card">
            <div className="mdl-cal">
              {ev.calibration.bins.filter((b) => b.n > 0).map((b) => (
                <div className="mdl-cal-row" key={b.lo}>
                  <span className="mdl-cal-key">{(b.lo * 100).toFixed(0)}–{(b.hi * 100).toFixed(0)}%</span>
                  <span className="mdl-cal-track">
                    <span className="mdl-cal-pred" style={{ left: "50%", width: `${((b.predicted! - 0.5) * 200).toFixed(2)}%` }} />
                    <span className="mdl-cal-obs" style={{ left: `${(50 + (b.observed! - 0.5) * 200).toFixed(2)}%` }} />
                  </span>
                  <span className="mdl-cal-val">{pct(b.observed, 1)} · n={b.n}</span>
                </div>
              ))}
            </div>
            <div className="mdl-legend">
              <span><i className="pred" />Predicted confidence</span>
              <span><i className="obs" />Observed hit rate</span>
              <span>ECE {num3(m.calibration_ece, 4)} · slope {num3(m.calibration_slope, 3)}</span>
            </div>
          </div>

          <div className="tbl-wrap">
            <table className="tbl">
              <caption className="sr-only">Out-of-sample performance by confidence band</caption>
              <thead><tr><th>Band</th><th className="r">Fights</th><th className="r">Claimed</th><th className="r">Hit rate</th><th className="r">Brier</th></tr></thead>
              <tbody>
                {ev.by_confidence_band.filter((b) => b.n > 0).map((b) => (
                  <tr key={b.band}>
                    <td>{b.band}%</td>
                    <td className="r">{b.n.toLocaleString()}</td>
                    <td className="r">{pct(b.mean_confidence, 1)}</td>
                    <td className="r"><b>{pct(b.hit_rate, 1)}</b></td>
                    <td className="r">{num3(b.brier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mdl-sec" id="examples">
        <SectionHead eyebrow="Proof · worked examples" title="What a model call looks like" />
        <p className="note">
          Real bouts, real out-of-sample probabilities, real results — and a deliberate mix of right and wrong. These are backtest
          output, clearly marked as such, and never current PBE Picks; the current calls are in <Link href="/algo/card" style={{ color: "var(--pbe-gold)" }}>PBE Picks</Link> for UFC Pro.
        </p>
        <div className="mdl-examples">
          {MODEL.examples.map((e) => <ExampleCard key={e.bout_id} e={e} />)}
        </div>
      </section>

      {/* ------------------------------------------------------------------
          4. METHODOLOGY
      ------------------------------------------------------------------- */}
      <div className="mdl-divider" id="method-deep"><span>Methodology</span></div>

      <section className="mdl-sec" id="limits">
        <SectionHead eyebrow="Limits" title="Where the model has nothing to say" />
        <div className="mdl-two">
          <div className="tbl-wrap">
            <table className="tbl">
              <caption className="sr-only">Performance by evidence available</caption>
              <thead><tr><th>Evidence available</th><th className="r">Fights</th><th className="r">Brier</th><th className="r">Accuracy</th><th className="r">AUC</th></tr></thead>
              <tbody>
                {ev.by_sample_quality.map((s) => (
                  <tr key={s.key}>
                    <td>{s.key.replace(/^[a-d]\. /, "")}</td>
                    <td className="r">{s.n.toLocaleString()}</td><td className="r">{num3(s.brier)}</td>
                    <td className="r">{pct(s.accuracy, 2)}</td><td className="r">{num3(s.auc, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <caption className="sr-only">Performance by division</caption>
              <thead><tr><th>Division</th><th className="r">Fights</th><th className="r">Brier</th><th className="r">Accuracy</th><th className="r">AUC</th></tr></thead>
              <tbody>
                {ev.by_division.map((d) => (
                  <tr key={d.key}>
                    <td>{divisionLabel(d.key.replace(/^Women's /, ""), d.key.startsWith("Women's"))}</td>
                    <td className="r">{d.n.toLocaleString()}</td><td className="r">{num3(d.brier)}</td>
                    <td className="r">{pct(d.accuracy, 2)}</td><td className="r">{num3(d.auc, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="note">
          The debut row is the honest headline of this table. When one corner has never fought inside the promotion, the model has
          almost no signal beyond age, reach and stance, and its AUC there is barely above a coin. It says so by producing
          probabilities near 50% rather than by manufacturing confidence — which is why the calibration above survives including
          those fights rather than being computed on a flattering subset. PBE Picks does not call those fights at all.
        </p>
      </section>

      <section className="mdl-sec" id="by-year">
        <SectionHead eyebrow="Fold by fold" title="Every year, scored separately" />
        <div className="tbl-wrap">
          <table className="tbl">
            <caption className="sr-only">Walk-forward folds</caption>
            <thead><tr><th>Year</th><th className="r">Trained on</th><th className="r">Scored</th><th className="r">Penalty</th><th className="r">Brier</th><th className="r">Log loss</th><th className="r">Accuracy</th><th className="r">AUC</th></tr></thead>
            <tbody>
              {ev.folds.map((f) => (
                <tr key={f.year}>
                  <td>{f.year}</td>
                  <td className="r">{f.train_n?.toLocaleString()}</td>
                  <td className="r">{f.test_n?.toLocaleString()}</td>
                  <td className="r">{f.lambda}</td>
                  <td className="r">{num3(f.brier, 5)}</td>
                  <td className="r">{num3(f.log_loss, 5)}</td>
                  <td className="r">{pct(f.accuracy, 2)}</td>
                  <td className="r">{num3(f.auc, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mdl-sec" id="leakage">
        <SectionHead eyebrow="Leakage" title="Proof the model could not see the future" />
        <p className="note">
          A fight model that has quietly read the result is easy to build and worthless. Six independent checks run on every build,
          and the run fails if any one of them does.
        </p>
        <div className="card">
          <ul className="mdl-audit">
            {audit.checks.map((c) => (
              <li key={c.name}>
                <span className={c.pass ? "ok" : "bad"}>{c.pass ? "PASS" : "FAIL"}</span>
                <span>
                  {c.name === "source allowlist" && <>The extract never selects a present-day career total. <b>record_w</b>, <b>career_slpm</b> and every other accumulator that describes a fighter as they are today is absent from the pipeline, so it cannot leak into a 2015 bout.</>}
                  {c.name === "snapshot provenance" && <>Every as-of Fight DNA snapshot used for a bout was checked against its own provenance list. The bout under prediction never appears in it, and no bout inside it is dated on or after the event. Independent cross-check of the running record against every snapshot: <b>{audit.snapshot_record_check}</b>.</>}
                  {c.name === "truncation" && <>The decisive test. For <b>{audit.truncation_sample}</b> sampled bouts, every row dated on or after the bout was deleted and the feature vector rebuilt from what remained. Not one value changed.</>}
                  {c.name === "permutation" && <>Training labels were shuffled and the model refit. Skill collapsed to <b>{num3(audit.permuted_label_skill, 4)}</b> against a real-label skill of {pct(ev.brier_skill_vs_coin, 2)}. A pipeline reading the answer would have kept performing.</>}
                  {c.name === "antisymmetry" && <>Swapping the corners returns exactly the complementary probability, so no artifact of which fighter the source listed first can be doing work. In this database the first-listed fighter wins 93.5% of bouts, purely because the ingest lists the winner first — a model with an intercept would have learned that and reported it as skill.</>}
                  {c.name === "fold boundaries" && <>In every fold, the last training event is strictly earlier than the first scored event.</>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mdl-sec" id="features">
        <SectionHead eyebrow="Inputs" title={`${MODEL_FACTS.featureCount} features, and no odds among them`} />
        <p className="note">
          Every input is a difference between the two corners, and the model is fitted with no intercept, so swapping the corners
          negates the vector and the two probabilities are exactly complementary. Sportsbook prices are not an input at any stage;
          the market appears only after a probability exists.
        </p>
        <ul className="mdl-feat">
          {MODEL.features.map((f) => (
            <li key={f.key}>
              <b>{f.key}</b>
              <span className="fam">{f.family} · {f.source.replace(/_/g, " ")}</span>
              {f.doc}
            </li>
          ))}
        </ul>
      </section>

      <section className="mdl-sec" id="method">
        <SectionHead eyebrow="Method" title="How to argue with this" />
        <p className="note">
          Model {MODEL.model.model_version}, features {MODEL.model.feature_version}, spec hash{" "}
          <code style={{ fontFamily: "var(--pbe-font-data)", fontSize: "var(--fs-sm)", color: "var(--pbe-dim)" }}>{MODEL.model.spec_sha256.slice(0, 16)}…</code>.
          {" "}{MODEL.model.algorithm}, trained on {MODEL.model.training_bouts.toLocaleString()} graded bouts from{" "}
          {MODEL.model.training_window_start} to {MODEL.model.training_window_end}. The full methodology, the leakage argument and the
          complete backtest tables are in the repository under <code style={{ fontFamily: "var(--pbe-font-data)", fontSize: "var(--fs-sm)", color: "var(--pbe-dim)" }}>docs/model/</code>.
        </p>
        <p className="note">
          The underlying temporal feature source is the repaired historical Fight DNA snapshot layer.{" "}
          <Link href="/learn/fight-dna" style={{ color: "var(--pbe-gold)" }}>How Fight DNA works →</Link>
        </p>
      </section>

      <PbeFamilyNav current="model" />

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Dataset",
          name: `${MODEL_FACTS.displayName} — walk-forward backtest`,
          description: `Out-of-sample results for an independent UFC win-probability model over ${ev.out_of_sample.n} bouts, ${ev.out_of_sample.first_event} to ${ev.out_of_sample.last_event}. ${MODEL_FACTS.featureCount} pre-fight features; no sportsbook odds are used as model inputs.`,
          url: `${SITE.url}/model`,
          creator: { "@type": "Organization", name: SITE.name },
          variableMeasured: ["Brier score", "log loss", "accuracy", "ROC AUC", "calibration error"],
        }}
      />
    </div>
  );
}
