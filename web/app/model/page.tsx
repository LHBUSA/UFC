import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, SectionHead, JsonLd } from "@/components/ui";
import { ModelProbability } from "@/components/ModelProbability";
import {
  MODEL, getLiveState, pct, pts, num3, divisionLabel,
  type ModelExample,
} from "@/lib/model";
import { SITE } from "@/lib/site";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "PBE Fight Model — Record, Calibration & Method",
  description:
    "The PBE Fight Model v1: an independent UFC win-probability model built from pre-fight Fight DNA only, with no sportsbook odds as an input. Walk-forward backtest, calibration, leakage audit, and a live record that starts at zero.",
  alternates: { canonical: "/model" },
  openGraph: {
    title: "PBE Fight Model — Record, Calibration & Method",
    description: "Independent UFC win probabilities from pre-fight data only. Walk-forward evidence, published in full, including where the model is weak.",
    url: `${SITE.url}/model`,
    images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", title: "PBE Fight Model", images: [`${SITE.url}/opengraph-image`] },
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
        disclaimer="Backtest output. Not a published pick."
      />
      {e.note && <p className="mdl-example-note">{e.note}</p>}
    </div>
  );
}

export default async function ModelPage() {
  const live = await getLiveState();
  const ev = MODEL.evidence;
  const m = ev.model;
  const audit = MODEL.leakage_audit;

  const highConf = live.record ? live.record.high_conf_wins + live.record.high_conf_losses : 0;

  return (
    <div className="wrap page">
      <PageHead
        crumbs={[{ name: "PBE Model" }]}
        eyebrow={`${MODEL.model.model_version} · ${MODEL.model.feature_version} · candidate`}
        title="The PBE Fight Model"
        lede="An independent win-probability model for UFC bouts. It reads only what was knowable before the fight, from the repaired Fight DNA history, and it never takes a sportsbook price as an input. The market is compared to the model afterwards, never the other way round."
      />

      {/* ------------------------------------------------------------------
          LIVE RECORD. First on the page, because it is the claim that would
          matter most - and today it is empty, which is the honest thing for it
          to say. Nothing from the backtest is allowed to fill this space.
      ------------------------------------------------------------------- */}
      <section className="mdl-sec" style={{ marginTop: 0 }} id="live">
        <SectionHead eyebrow="Live record" title="What the model has actually done" />
        <div className="mdl-status">
          <div>
            <h2>
              {live.status === "publishing" ? `${live.record?.wins}-${live.record?.losses}${live.record?.no_decision ? `-${live.record.no_decision}` : ""}`
                : live.status === "publishing_ungraded" ? "Awaiting the first result"
                : "Not publishing yet"}
            </h2>
            <p>
              {live.reason ||
                `Locked before the fight, graded after it, never edited in between. ${live.record?.locked_predictions ?? 0} picks locked to date.`}
            </p>
            <p style={{ marginTop: "var(--s-3)" }}>
              A pick enters this record only once it has been written down and locked <em>before</em> the bout — and the lock time
              is the database&rsquo;s own clock, not a timestamp supplied by whatever wrote the row. From that moment the
              probability, the pick, the model version and the feature vector are frozen: there is no permitted edit to a published
              prediction at all. That is a storage-layer guarantee rather than a promise made in application code.
            </p>
            <p style={{ marginTop: "var(--s-3)" }}>
              Results are kept separately, because a result is not a prediction. Combat-sports outcomes get overturned on appeal and
              corrected by commissions, so a grade can be revised — as a new entry that supersedes the last one and has to say why.
              The record you see follows the current entry; every superseded one stays on file.
              {live.record && live.record.revised_grades > 0
                ? ` ${live.record.revised_grades} result${live.record.revised_grades === 1 ? " has" : "s have"} been revised so far.`
                : ""}
            </p>
          </div>
        </div>

        <div className="mdl-rec">
          <Stat label="Record" value={live.status === "publishing" ? `${live.record?.wins}-${live.record?.losses}` : "0-0"} empty={live.status !== "publishing"} sub={live.status === "publishing" ? undefined : "no locked picks yet"} />
          <Stat label="Hit rate" value={pct(live.record?.hit_rate)} empty={live.record?.hit_rate == null} />
          <Stat label="High confidence" value={highConf ? `${live.record?.high_conf_wins}-${live.record?.high_conf_losses}` : "—"} empty={!highConf} sub="picks at 65% or better" />
          <Stat label="Brier" value={num3(live.record?.brier ?? null)} empty={live.record?.brier == null} sub="lower is better" />
          <Stat label="Last 30" value={live.recent ? `${live.recent.wins}-${live.recent.losses}` : "—"} empty={!live.recent} />
          <Stat label="No contest / draw" value={live.record ? String(live.record.no_decision) : "—"} empty={!live.record?.no_decision} />
          <Stat label="Results revised" value={live.record ? String(live.record.revised_grades) : "—"} empty={!live.record?.revised_grades} sub="overturned or corrected" />
        </div>

        <p className="mdl-split-note">
          <b>This record and the backtest below are never combined.</b> They answer different questions. A backtest says what the
          model would have done on fights whose results already existed somewhere; a live record says what it did with the future
          genuinely unknown. They are stored in separate tables, reported by separate views, and there is deliberately no query in
          this product that adds them together.
        </p>
      </section>

      {/* ------------------------------------------------------------------
          BACKTEST
      ------------------------------------------------------------------- */}
      <section className="mdl-sec" id="backtest">
        <SectionHead eyebrow="Backtest · walk-forward, out of sample" title="What the model would have done" />
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
                <td><b style={{ color: "var(--pbe-model)" }}>PBE Fight Model v1</b></td>
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
                  {ev.market.n ? `${num3((ev.market as { brier?: number }).brier ?? null)}` : "No completed bout in this database yet carries a market observation recorded before it started. The comparison is built and stays empty until the market ingest has accumulated history against fights that are then graded. It is not estimated in the meantime."}
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

      {/* ---- calibration + bands ---- */}
      <section className="mdl-sec" id="calibration">
        <SectionHead eyebrow="Calibration" title="Does 62% mean 62%" />
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

      {/* ---- worked examples ---- */}
      <section className="mdl-sec" id="examples">
        <SectionHead eyebrow="The card" title="What a model call looks like" />
        <p className="note">
          Real bouts, real out-of-sample probabilities, real results — and a deliberate mix of right and wrong. These are backtest
          output, clearly marked as such. No live pick is published anywhere on this site yet.
        </p>
        <div className="mdl-examples">
          {MODEL.examples.map((e) => <ExampleCard key={e.bout_id} e={e} />)}
        </div>

      </section>

      {/* ---- where it is weak ---- */}
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
          those fights rather than being computed on a flattering subset.
        </p>
      </section>

      {/* ---- year by year ---- */}
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

      {/* ---- leakage ---- */}
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

      {/* ---- features ---- */}
      <section className="mdl-sec" id="features">
        <SectionHead eyebrow="Inputs" title={`${MODEL.model.feature_count} features, and no odds among them`} />
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

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Dataset",
          name: "PBE Fight Model v1 — walk-forward backtest",
          description: `Out-of-sample results for an independent UFC win-probability model over ${ev.out_of_sample.n} bouts, ${ev.out_of_sample.first_event} to ${ev.out_of_sample.last_event}. No sportsbook odds are used as model inputs.`,
          url: `${SITE.url}/model`,
          creator: { "@type": "Organization", name: SITE.name },
          variableMeasured: ["Brier score", "log loss", "accuracy", "ROC AUC", "calibration error"],
        }}
      />
    </div>
  );
}
