import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { getUfcAccess } from "@/lib/access";
import { getAlgoPublicRecord, algoLive, algoCallsActive, getAlgoNextCardSummary } from "@/lib/algo";
import { MODEL, pct, num3 } from "@/lib/model";
import { REASON_COPY } from "@/lib/algoView";
import { SITE } from "@/lib/site";
import { PRO_OFFER } from "@/lib/proOffer";
import { MODEL_FACTS, RULE_TEXT } from "@/lib/pbeProduct";
import { fmtDate } from "@/lib/format";
import { PbeFamilyNav } from "@/components/PbeFamilyNav";

/* PUBLIC = ACCOUNTABILITY. This page proves the Algo exists, how it works and
 * how it has done in aggregate. It never renders, serializes or links an
 * individual call: lib/algo.ts only hands this page counts and proper scores.
 *
 * Order is product first, documentation second: what it is -> the live record
 * -> where the picks are -> how a call becomes official -> the evidence. Every
 * number on the page is read from the ledger or the release artifact; nothing
 * decorative is dressed as data. Styles: app/algo-flagship.css (.af-*). */

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

const FLOW = ["Fight discovered", "Identity verified", "Fight DNA features", "Model scores", "Eligibility gate", "Locked", "Graded"] as const;

const STEPS: Array<[string, string]> = [
  ["Card discovered", "Every UFC card inside a 14-day horizon is picked up hourly by a Cloudflare scheduler. Contender Series and non-UFC events are out of scope."],
  ["Identity verified", "Both corners must resolve to one reconciled fighter record, with no open same-name identity review."],
  ["Features assembled", `${MODEL_FACTS.featureCount} pre-fight difference features are rebuilt from Fight DNA as of the event date: nothing from the fight itself, and never a sportsbook price.`],
  ["Eligibility decided", "A deterministic rule set decides ELIGIBLE or NO MODEL CALL, and a no-call records its exact reasons."],
  ["Hourly regeneration", "Until the lock, an eligible call is re-scored every hour as the card changes. A provisional call is not part of the record."],
  ["Locked on the database clock", "The call locks once, on the database's own clock, before the fight. From that moment nothing about the prediction can be edited, and it becomes part of the official PBE record."],
  ["Graded after the fight", "Results are bound to the stored official result. Corrections are new, dated revisions that must give a reason; the original stays on file."],
];

/* The model's inputs, read off the release artifact rather than typed here: a
 * feature added to or dropped from the model changes this list by itself. */
const FAMILY_COPY: Record<string, string> = {
  age: "Age", reach: "Reach and height", experience: "UFC experience, five-round and title-fight experience",
  form: "Win rate, last-five form, streak and layoff", striking: "Striking volume, differential and knockdowns",
  accuracy: "Striking accuracy and defense", durability: "Durability: knockdowns absorbed, KO and submission losses",
  takedowns: "Takedown volume, accuracy and defense", control: "Control time and submission attempts",
  finishing: "Finish, KO and submission rates", pace: "Pace retention into later rounds", stance: "Stance matchup",
  opponent: "Strength of opposition and quality wins", confidence: "How much fight data each corner has",
};
const FAMILIES = [...new Set(MODEL.features.map((f) => f.family))];
const INPUTS = FAMILIES.map((fam) => ({ label: FAMILY_COPY[fam] || fam, n: MODEL.features.filter((f) => f.family === fam).length }));

/** The model graphic: octagon, two corners, signal lines into one locked call.
 *  Geometry only. No number in it, so nothing in it can read as a result. */
function ModelGraphic() {
  return (
    <svg className="af-graphic" viewBox="0 0 420 300" role="img" aria-label="Two corners scored by the model into one locked call">
      <defs>
        <linearGradient id="af-sig" x1="0" x2="1"><stop offset="0" stopColor="var(--pbe-model)" stopOpacity="0" /><stop offset="1" stopColor="var(--pbe-model)" stopOpacity=".9" /></linearGradient>
        <linearGradient id="af-sig-r" x1="1" x2="0"><stop offset="0" stopColor="var(--pbe-model)" stopOpacity="0" /><stop offset="1" stopColor="var(--pbe-model)" stopOpacity=".9" /></linearGradient>
      </defs>
      <polygon className="af-oct" points="150,20 270,20 355,105 355,195 270,280 150,280 65,195 65,105" />
      <polygon className="af-oct in" points="168,62 252,62 312,122 312,178 252,238 168,238 108,178 108,122" />
      {[96, 123, 150, 177, 204].map((y) => <path key={`l${y}`} className="af-line" stroke="url(#af-sig)" d={`M20 ${y} C 90 ${y}, 120 150, 178 150`} />)}
      {[96, 123, 150, 177, 204].map((y) => <path key={`r${y}`} className="af-line" stroke="url(#af-sig-r)" d={`M400 ${y} C 330 ${y}, 300 150, 242 150`} />)}
      {[96, 123, 150, 177, 204].flatMap((y) => [<circle key={`nl${y}`} className="af-node" cx="20" cy={y} r="2.5" />, <circle key={`nr${y}`} className="af-node" cx="400" cy={y} r="2.5" />])}
      <rect className="af-lock-body" x="186" y="140" width="48" height="38" rx="6" />
      <path className="af-lock-shackle" d="M196 140 v-12 a14 14 0 0 1 28 0 v12" />
      <circle className="af-lock-key" cx="210" cy="157" r="4" />
      <text className="af-tag" x="20" y="80">CORNER A</text>
      <text className="af-tag" x="400" y="80" textAnchor="end">CORNER B</text>
      <text className="af-tag gold" x="210" y="206" textAnchor="middle">LOCKED</text>
    </svg>
  );
}

export default async function AlgoPage() {
  const [rec, access, registered, active] = await Promise.all([getAlgoPublicRecord(), getUfcAccess(), algoLive(), algoCallsActive()]);
  /* Counts only, and only for Pro: see getAlgoNextCardSummary. */
  const nextCard = access.pro ? await getAlgoNextCardSummary(access).catch(() => null) : null;
  const ev = MODEL.evidence;
  const live = rec.locked_predictions > 0;
  const marketFree = MODEL_FACTS.sportsbookInputs === 0;

  return (
    <div className="wrap page algo-page af">
      <Breadcrumbs items={[{ name: "PBE Algo" }]} />

      {/* 1 — what it is */}
      <header className="af-hero">
        <div className="af-hero-copy">
          <div className="eyebrow">PBE Fight Model · UFC Pro</div>
          <h1>PBE Algo</h1>
          <p className="af-tagline">Pre-fight win probabilities. <span>Locked before the fight.</span> <span>Graded forever.</span></p>
          <p className="af-lede">
            PBE Algo independently evaluates eligible UFC matchups using pre-fight Fight DNA data. Every official call is locked
            before the bout begins, then graded against the official result. Picks are never rewritten after the fact.
          </p>
          <div className="af-actions">
            {access.pro
              ? <><Link href="/algo/card" className="btn gold af-cta">View Current PBE Picks</Link><Link href="/algo/record" className="btn">Full Track Record</Link></>
              : <><Link href="/pro" className="btn gold af-cta">Unlock PBE Picks</Link><a href="#record" className="btn">See Public Track Record</a></>}
            <a href="#how" className="af-textlink">How the Model Works</a>
          </div>
          {!access.pro && <p className="af-price">{PRO_OFFER.plans.monthly.display}/month or {PRO_OFFER.plans.weekly.display}/week. No free trial.</p>}
        </div>
        <div className="af-hero-art">
          <ModelGraphic />
          <div className="af-version"><span>Model version</span><code>{rec.model_version}</code></div>
        </div>
      </header>

      {/* 2 — system state, real values only */}
      <dl className="af-status" aria-label="PBE Algo system status">
        <div><dt>Model</dt><dd className="mono">{rec.model_version.toUpperCase()}</dd></div>
        <div><dt>Official calls</dt><dd>{rec.locked_predictions.toLocaleString("en-US")}</dd></div>
        <div><dt>Ledger</dt><dd className={registered ? "ok" : undefined}>{registered ? (active ? "Live · scheduler active" : "Live") : "Not registered"}</dd></div>
        <div><dt>Lock rule</dt><dd>Before the fight</dd></div>
        <div><dt>Market input</dt><dd>{marketFree ? "No" : `${MODEL_FACTS.sportsbookInputs} features`}</dd></div>
        <div><dt>Grading</dt><dd>Official result</dd></div>
      </dl>

      {/* 3 — the live record: prospective, locked calls only */}
      <section className="af-sec af-record" id="record" aria-labelledby="af-record-h">
        <div className="af-sec-head">
          <div className="af-kicker live"><i />Live record · real locked calls only</div>
          <h2 id="af-record-h">Live PBE Record</h2>
        </div>
        {live ? (
          <>
            <dl className="af-terminal">
              <div className="lead"><dt>Official locks</dt><dd>{rec.locked_predictions.toLocaleString("en-US")}</dd></div>
              <div><dt>Record</dt><dd>{rec.decided ? `${rec.wins}-${rec.losses}` : "—"}</dd>{rec.no_decision > 0 && <small>{rec.no_decision} draw / NC / void</small>}</div>
              <div><dt>Hit rate</dt><dd>{pct(rec.hit_rate)}</dd>{!rec.decided && <small>no graded call yet</small>}</div>
              <div><dt>Brier</dt><dd>{num3(rec.brier, 3)}</dd><small>lower is better · coin flip 0.250</small></div>
              <div><dt>Pending</dt><dd>{rec.pending.toLocaleString("en-US")}</dd><small>locked, awaiting result</small></div>
            </dl>
            <p className="af-note">
              Every call counted here was locked before its fight. First lock {rec.first_locked_at?.slice(0, 10)}, latest {rec.last_locked_at?.slice(0, 10)}.
              Individual calls, probabilities and the per-call history are UFC Pro.
            </p>
          </>
        ) : (
          <div className="af-await">
            <div className="af-await-mark" aria-hidden="true" />
            <div>
              <h3>Awaiting first official lock</h3>
              <p>PBE Algo&apos;s live record begins with the first production call. Backtest results are never inserted into the live ledger, and the record will never be backfilled.</p>
              <dl className="af-await-counts">
                <div><dt>Official locked calls</dt><dd>{rec.locked_predictions}</dd></div>
                <div><dt>Pending</dt><dd>{rec.pending}</dd></div>
              </dl>
            </div>
          </div>
        )}
        {rec.calibration.length > 0 && (
          <div className="tbl-wrap af-cal">
            <table className="tbl">
              <caption>Live calibration: when PBE Algo claimed a probability, how often it happened</caption>
              <thead><tr><th>Band</th><th className="r">Decided</th><th className="r">Claimed</th><th className="r">Happened</th></tr></thead>
              <tbody>{rec.calibration.map((c) => <tr key={c.band}><td>{c.band}%</td><td className="r">{c.decided}</td><td className="r">{pct(c.predicted)}</td><td className="r">{pct(c.observed)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4 — where the picks are */}
      <section className="af-sec af-picks" id="picks" aria-labelledby="af-picks-h">
        <div className="af-picks-copy">
          <div className="af-kicker gold">PBE Picks · UFC Pro</div>
          <h2 id="af-picks-h">{access.pro ? "This week's calls" : "The current calls live in PBE Picks"}</h2>
          {access.pro ? (
            nextCard ? (
              <>
                <p className="af-note"><b>{nextCard.event_name}</b> · {fmtDate(nextCard.event_date)}</p>
                <dl className="af-mini">
                  <div><dt>Fights on card</dt><dd>{nextCard.bouts}</dd></div>
                  <div><dt>Official locked calls</dt><dd>{nextCard.locked}</dd></div>
                  <div><dt>Provisional calls</dt><dd>{nextCard.provisional}</dd></div>
                  <div><dt>No model call</dt><dd>{nextCard.no_call}</dd></div>
                  {nextCard.pending > 0 && <div><dt>Not yet evaluated</dt><dd>{nextCard.pending}</dd></div>}
                </dl>
              </>
            ) : <p className="af-note">No UFC card is inside the 14-day horizon right now. The next card appears in PBE Picks as soon as it is.</p>
          ) : (
            <>
              <p className="af-note">This page is the method and the public proof. The calls themselves are UFC Pro. For every eligible fight on the next UFC card, PBE Picks shows:</p>
              <ul className="af-ticks">
                <li>The pick and its win probability</li>
                <li>Confidence tier and data quality</li>
                <li>Fight-week odds, de-vigged market probability and PBE Edge</li>
                <li>The model&apos;s drivers for and against</li>
                <li>Every NO MODEL CALL, with its reason</li>
              </ul>
            </>
          )}
        </div>
        <div className="af-picks-cta">
          <Link href={access.pro ? "/algo/card" : "/pro"} className="btn gold af-cta">{access.pro ? "Open Current PBE Picks" : "Unlock PBE Picks"}</Link>
          {access.pro && <Link href="/algo/record" className="af-textlink">Full track record</Link>}
        </div>
      </section>

      {/* 5 — how a call becomes official */}
      <section className="af-sec" id="how" aria-labelledby="af-how-h">
        <div className="af-sec-head">
          <div className="af-kicker">How a call becomes official</div>
          <h2 id="af-how-h">From fight card to graded call</h2>
        </div>
        <ol className="af-flow">{FLOW.map((f, i) => <li key={f} className={f === "Locked" ? "lock" : undefined}><span>{i + 1}</span>{f}</li>)}</ol>
        <details className="af-details">
          <summary>Read each step in detail</summary>
          <ol className="algo-steps">{STEPS.map(([h, p], i) => <li key={h}><span>{i + 1}</span><div><b>{h}</b><p>{p}</p></div></li>)}</ol>
        </details>

        <div className="af-locked">
          <div className="af-locked-head">
            <div className="af-kicker gold">The differentiator</div>
            <h3>Locked means locked</h3>
            <p>Once an official prediction locks, it is part of the record for good.</p>
          </div>
          <ul>
            <li><b>The prediction cannot be edited.</b> Pick, side and probability are fixed at the lock.</li>
            <li><b>The lock time is stored</b> from the database&apos;s own clock, before the fight.</li>
            <li><b>The model and feature version are stored</b> with the call, along with the inputs it was scored on.</li>
            <li><b>The result is graded later</b> against the stored official result.</li>
            <li><b>A correction never rewrites the call.</b> It is a new, dated revision that must give a reason; the original stays on file.</li>
          </ul>
        </div>
      </section>

      {/* 6 — eligibility, inputs and non-inputs */}
      <section className="af-sec" id="eligibility" aria-labelledby="af-elig-h">
        <div className="af-sec-head">
          <div className="af-kicker">Eligibility</div>
          <h2 id="af-elig-h">No forced picks</h2>
        </div>
        <p className="af-note">Every eligible bout gets a call. A bout that fails any rule gets NO MODEL CALL with the reason on record, and a probability is never nudged to make a bout callable.</p>
        <div className="af-io">
          <div className="af-io-col uses">
            <h3>What PBE Algo uses</h3>
            <p>{MODEL_FACTS.featureCount} pre-fight features, each one the difference between the two corners, rebuilt from Fight DNA as of the event date.</p>
            <ul>{INPUTS.map((f) => <li key={f.label}>{f.label}</li>)}</ul>
          </div>
          <div className="af-io-col not">
            <h3>What it does not use</h3>
            <ul>
              {marketFree && <li><b>Sportsbook prices.</b> {MODEL_FACTS.sportsbookInputs} of {MODEL_FACTS.featureCount} model features come from a market.</li>}
              <li><b>Anything from the fight itself.</b> Features are rebuilt as of the event date{MODEL.leakage_audit.all_passed ? `, and the release passed all ${MODEL.leakage_audit.checks.length} leakage checks` : ""}.</li>
              <li><b>Information after the lock.</b> A locked call is never re-scored.</li>
              <li><b>A human override.</b> No editor picks a side or adjusts a probability.</li>
            </ul>
          </div>
        </div>
        <details className="af-details">
          <summary>The no-call rules and confidence tiers</summary>
          <ul className="algo-rules">{Object.values(REASON_COPY).map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="af-note">Confidence: {RULE_TEXT.confidence}</p>
        </details>
      </section>

      {/* 7 — model vs market */}
      <section className="af-sec" id="market" aria-labelledby="af-market-h">
        <div className="af-sec-head">
          <div className="af-kicker">Model vs market</div>
          <h2 id="af-market-h">PBE Edge: the model against the price</h2>
          <Link href="/model#edge" className="af-textlink">See the PBE Edge explainer</Link>
        </div>
        <div className="af-eq" role="group" aria-label="How PBE Edge is calculated">
          <div className="af-eq-term model"><span>PBE probability</span><small>The model&apos;s own number, scored first</small></div>
          <div className="af-eq-op" aria-hidden="true">−</div>
          <div className="af-eq-term"><span>De-vigged market probability</span><small>Consensus across books, margin removed</small></div>
          <div className="af-eq-op" aria-hidden="true">=</div>
          <div className="af-eq-term edge"><span>PBE Edge</span><small>Where the model and the market disagree</small></div>
        </div>
        <p className="af-callout">Market prices are compared <b>after</b> the model has scored the fight. They are never a model input.</p>
        <p className="af-note">
          Sportsbook prices include a margin, so their implied probabilities add up to more than 100%. During fight week PBE Algo reads the current
          market, shows the consensus and best available American odds, and removes that margin before comparing. A market older than its
          fight-week window shows its age and publishes no edge ({RULE_TEXT.windows}). Brier score, log loss and calibration are tracked by
          confidence tier and by PBE Edge band as the graded record accumulates. PBE Edge describes a disagreement; it is not betting advice.
        </p>
      </section>

      {/* 8 — backtest: evidence, never the record */}
      <section className="af-sec af-evidence" id="evidence" aria-labelledby="af-ev-h">
        <div className="af-sec-head">
          <div className="af-kicker model">Backtest · not the live record</div>
          <h2 id="af-ev-h">Historical model evidence</h2>
          <Link href="/model" className="af-textlink">Full method and backtest</Link>
        </div>
        <p className="af-note">
          Before it made a single live call, the model was tested walk-forward: for each year from {MODEL_FACTS.outOfSampleFirst.slice(0, 4)}, it was
          trained only on earlier fights and scored on fights it had never seen. These numbers describe what the model would have done. They are kept
          apart from the live record above and are never added to it.
        </p>
        <dl className="af-ev-grid">
          <div><dt>Out-of-sample fights</dt><dd>{ev.out_of_sample.n.toLocaleString("en-US")}</dd><small>{MODEL_FACTS.outOfSampleFirst.slice(0, 4)}–{MODEL_FACTS.outOfSampleLast.slice(0, 4)}, each scored without being trained on.</small></div>
          <div><dt>Accuracy</dt><dd>{pct(ev.model.accuracy, 1)}</dd><small>How often the side the model favoured went on to win.</small></div>
          <div><dt>Brier score</dt><dd>{num3(ev.model.brier, 3)}</dd><small>Lower is better. 0.250 is coin-flip probability quality.</small></div>
          <div><dt>Calibration error</dt><dd>{num3(ev.model.calibration_ece, 4)}</dd><small>When the model says 70%, how far off is how often it actually happens? Closer to zero is better.</small></div>
        </dl>
        <p className="af-note">A modest, honest edge over a coin flip across thousands of fights. It does not predict any single fight with certainty, and nothing here is a promise about future results.</p>
      </section>

      {/* 9 — the family, one role each */}
      <PbeFamilyNav current="algo" title="One model, four pages: method here, calls in PBE Picks, grades in Track Record" />

      {/* 10 — UFC Pro */}
      <section className="card hi mt-6 between" id="pro">
        <div>
          <div className="eyebrow">UFC Pro</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>The calls, the probabilities, the edge and the history.</div>
          <div className="faint sm">UFC Pro includes every PBE Algo call with win probability, confidence, data quality, fight-week odds, de-vigged market probability and PBE Edge, the model&apos;s drivers for and against, every no-call reason, and the complete per-call track record.</div>
        </div>
        <Link href={access.pro ? "/algo/card" : "/pro"} className="btn gold">{access.pro ? "Current PBE Picks" : "Unlock UFC Pro"}</Link>
      </section>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebPage", name: "PBE Algo", url: `${SITE.url}/algo`, description: "Method, eligibility rules and aggregate live record for PBE Algo, the PropBetEdge UFC Pro win-probability model.", isPartOf: { "@id": `${SITE.url}/#site` } }} />
    </div>
  );
}
