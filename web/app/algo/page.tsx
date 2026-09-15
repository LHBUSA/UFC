import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, SectionHead, JsonLd } from "@/components/ui";
import { getUfcAccess } from "@/lib/access";
import { getAlgoPublicRecord } from "@/lib/algo";
import { MODEL, pct, num3 } from "@/lib/model";
import { REASON_COPY } from "@/lib/algoView";
import { SITE } from "@/lib/site";
import { PRO_OFFER } from "@/lib/proOffer";
import { MODEL_FACTS, RULE_TEXT } from "@/lib/pbeProduct";
import { PbeFamilyNav } from "@/components/PbeFamilyNav";

/* PUBLIC = ACCOUNTABILITY. This page proves the Algo exists, how it works and
 * how it has done in aggregate. It never renders, serializes or links an
 * individual call: lib/algo.ts only hands this page counts and proper scores. */

export const metadata: Metadata = {
  title: "PBE Algo — UFC Win Probabilities, Locked Before the Fight",
  description:
    "PBE Algo is the UFC Pro model: an independent win probability for every eligible UFC bout, locked on the database clock before the fight, graded after it and never edited. Method, eligibility rules and the aggregate live record.",
  alternates: { canonical: "/algo" },
  openGraph: {
    title: "PBE Algo — locked before the fight, graded after it",
    description: "Independent UFC win probabilities from pre-fight data only. Aggregate record, calibration and method, published in full.",
    url: `${SITE.url}/algo`,
    images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }],
  },
};

const STEPS: Array<[string, string]> = [
  ["Card discovered", "Every UFC card inside a 14-day horizon is picked up hourly by a Cloudflare scheduler. Contender Series and non-UFC events are out of scope."],
  ["Identity verified", "Both corners must resolve to one reconciled fighter record, with no open same-name identity review."],
  ["Features assembled", `${MODEL_FACTS.featureCount} pre-fight difference features are rebuilt from Fight DNA as of the event date: nothing from the fight itself, and never a sportsbook price.`],
  ["Eligibility decided", "A deterministic rule set decides ELIGIBLE or NO MODEL CALL, and a no-call records its exact reasons."],
  ["Hourly regeneration", "Until the lock, an eligible call is re-scored every hour as the card changes. A provisional call is not part of the record."],
  ["Locked on the database clock", "The call locks once, on the database's own clock, before the fight. From that moment nothing about the prediction can be edited, and it becomes part of the official PBE record."],
  ["Graded after the fight", "Results are bound to the stored official result. Corrections are new, dated revisions that must give a reason; the original stays on file."],
];

export default async function AlgoPage() {
  const [rec, access] = await Promise.all([getAlgoPublicRecord(), getUfcAccess()]);
  const ev = MODEL.evidence;
  const live = rec.locked_predictions > 0;

  return (
    <div className="wrap page algo-page">
      <PageHead
        crumbs={[{ name: "PBE Algo" }]}
        eyebrow={`UFC Pro flagship · ${rec.model_version}`}
        title="PBE Algo"
        lede="An independent win probability for every eligible UFC bout, written down and locked before the fight, graded after it, and never edited in between. Public shows the proof. UFC Pro gets the calls."
      >
        <div className="row mt-3">
          {access.pro
            ? <><Link href="/algo/card" className="btn gold">Current PBE Picks</Link><Link href="/algo/record" className="btn">Full track record</Link></>
            : <><Link href="/pro" className="btn gold">Get PBE Algo with UFC Pro</Link><span className="faint sm">{PRO_OFFER.plans.monthly.display}/month or {PRO_OFFER.plans.weekly.display}/week. No free trial.</span></>}
        </div>
      </PageHead>

      <section className="mdl-sec" style={{ marginTop: 0 }} id="record">
        <SectionHead eyebrow="Live record · aggregate" title={live ? "What PBE Algo has actually done" : "The record starts at the first lock"} />
        <div className="mdl-rec">
          <div className="stat model"><b className={live ? undefined : "empty"}>{rec.locked_predictions}</b><span>Locked calls</span></div>
          <div className="stat model"><b className={rec.decided ? undefined : "empty"}>{rec.decided ? `${rec.wins}-${rec.losses}` : "—"}</b><span>Record</span>{rec.no_decision > 0 && <span className="faint">{rec.no_decision} draw / NC / void</span>}</div>
          <div className="stat model"><b className={rec.hit_rate == null ? "empty" : undefined}>{pct(rec.hit_rate)}</b><span>Hit rate</span></div>
          <div className="stat model"><b className={rec.brier == null ? "empty" : undefined}>{num3(rec.brier, 3)}</b><span>Brier</span><span className="faint">lower is better</span></div>
          <div className="stat model"><b className={live ? undefined : "empty"}>{rec.pending}</b><span>Awaiting result</span></div>
        </div>
        <p className="note">
          {live
            ? `Every call counted here was locked before its fight. First lock ${rec.first_locked_at?.slice(0, 10)}, latest ${rec.last_locked_at?.slice(0, 10)}. Individual calls, probabilities and the per-call history are UFC Pro.`
            : "No official PBE Algo call has been locked yet. Until one is, this record is empty rather than borrowed from the backtest, and it will never be backfilled."}
        </p>
        {rec.calibration.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <caption className="sr-only">Live calibration by probability band</caption>
              <thead><tr><th>Band</th><th className="r">Decided</th><th className="r">Claimed</th><th className="r">Happened</th></tr></thead>
              <tbody>{rec.calibration.map((c) => <tr key={c.band}><td>{c.band}%</td><td className="r">{c.decided}</td><td className="r">{pct(c.predicted)}</td><td className="r">{pct(c.observed)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mdl-sec" id="how">
        <SectionHead eyebrow="How a call is made" title="From card to locked call" />
        <ol className="algo-steps">
          {STEPS.map(([h, p], i) => <li key={h}><span>{i + 1}</span><div><b>{h}</b><p>{p}</p></div></li>)}
        </ol>
      </section>

      <section className="mdl-sec" id="eligibility">
        <SectionHead eyebrow="Eligibility" title="No forced picks" />
        <p className="note">Every eligible bout gets a call. A bout that fails any rule gets NO MODEL CALL with the reason on record, and a probability is never nudged to make a bout callable. The rules, in order:</p>
        <ul className="algo-rules">{Object.values(REASON_COPY).map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="note">Confidence: {RULE_TEXT.confidence}</p>
      </section>

      <section className="mdl-sec" id="market">
        <SectionHead eyebrow="Model vs market" title="Killing the vig" href="/model#edge" cta="See the PBE Edge explainer" />
        <p className="note">
          Sportsbook prices include a margin, so their implied probabilities add up to more than 100%. During fight week PBE Algo reads the
          current market, shows the consensus and best available American odds, removes the margin (a de-vigged consensus across books) and
          reports the difference between its own probability and the market&apos;s as PBE Edge. The market is compared with the model after
          scoring and is never a model input; a market older than its fight-week window shows its age and publishes no edge. Brier score, log
          loss and calibration are tracked by confidence tier and by PBE Edge band as the graded record accumulates.
        </p>
      </section>

      <section className="mdl-sec" id="evidence">
        <SectionHead eyebrow="Backtest · walk-forward, out of sample" title="Evidence before the first lock" href="/model" cta="Full method and backtest" />
        <div className="mdl-rec">
          <div className="stat model"><b>{ev.out_of_sample.n.toLocaleString("en-US")}</b><span>Fights scored</span></div>
          <div className="stat model"><b>{pct(ev.model.accuracy, 1)}</b><span>Accuracy</span></div>
          <div className="stat model"><b>{num3(ev.model.brier, 3)}</b><span>Brier</span><span className="faint">coin = 0.250</span></div>
          <div className="stat model"><b>{num3(ev.model.calibration_ece, 4)}</b><span>Calibration error</span></div>
        </div>
        <p className="note">Backtest results describe what the model would have done and are kept apart from the live record above. They are never added together.</p>
      </section>

      <section className="card hi mt-6 between" id="pro">
        <div>
          <div className="eyebrow">UFC Pro</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>The calls, the probabilities, the edge and the history.</div>
          <div className="faint sm">UFC Pro includes every PBE Algo call with win probability, confidence, data quality, fight-week odds, de-vigged market probability and PBE Edge, the model&apos;s drivers for and against, every no-call reason, and the complete per-call track record.</div>
        </div>
        <Link href={access.pro ? "/algo/card" : "/pro"} className="btn gold">{access.pro ? "Current PBE Picks" : "Unlock UFC Pro"}</Link>
      </section>

      <PbeFamilyNav current="algo" />

      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebPage", name: "PBE Algo", url: `${SITE.url}/algo`, description: "Method, eligibility rules and aggregate live record for PBE Algo, the PropBetEdge UFC Pro win-probability model.", isPartOf: { "@id": `${SITE.url}/#site` } }} />
    </div>
  );
}
