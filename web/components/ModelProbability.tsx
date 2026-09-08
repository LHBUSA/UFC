/* The PBE MODEL card.
 *
 * One rule governs everything in this file: a probability is only publishable
 * beside the evidence that says how much it is worth. So the card never shows
 * a bare number. It shows the split, the sample the split was computed from,
 * the band's measured out-of-sample hit rate, and - when a timestamp-compatible
 * price exists - the market beside it.
 *
 * ORDER MATTERS AND IS VISIBLE. The model probability is produced first, from
 * pre-fight information only. The market line is a comparison drawn afterwards.
 * The layout says so: the model split is the headline, the market is a
 * subordinate row underneath, and the edge is labelled as a difference between
 * the two rather than as a recommendation.
 *
 * The card refuses to invent. No market price means the market row states that
 * plainly instead of showing a placeholder, and a low-sample corner is labelled
 * low-sample rather than quietly averaged into confidence it has not earned.
 */
import { bandEvidence, marketProbForPick, modelEdgePts, pct, pickSide, pts, type ModelSide } from "@/lib/model";

export type ModelProbabilityProps = {
  a: ModelSide;
  b: ModelSide;
  /** De-vigged market implied probability for fighter A, or null when no
   *  timestamp-compatible observation exists. Never estimated. */
  marketImpliedA?: number | null;
  marketBooks?: number | null;
  modelVersion: string;
  featureVersion?: string;
  /** Prior bouts and stat-covered bouts for the thinner-sampled corner. */
  sample?: { minPriorBouts: number; minStatBouts: number; featuresAvailable?: number; featuresTotal?: number };
  /** Result, when the card is showing a bout that has already happened. */
  settled?: { winnerName: string; outcome: "WIN" | "LOSS"; method?: string | null };
  /** Rendered above the split. Used to mark a card as a backtest example. */
  kicker?: string;
  /** Set when this is not a published pick, which today is always. */
  disclaimer?: string;
};

const Bar = ({ a, b }: { a: number; b: number }) => (
  <div className="mp-bar" role="img" aria-label={`Model split: ${pct(a)} to ${pct(b)}`}>
    <span className="mp-bar-a" style={{ width: `${(a * 100).toFixed(2)}%` }} />
    <span className="mp-bar-b" style={{ width: `${(b * 100).toFixed(2)}%` }} />
  </div>
);

export function ModelProbability({
  a, b, marketImpliedA = null, marketBooks = null, modelVersion, featureVersion,
  sample, settled, kicker, disclaimer,
}: ModelProbabilityProps) {
  const { pick, aFavoured } = pickSide(a, b);
  const evidence = bandEvidence(a.prob);
  // The arithmetic lives in lib/model.ts, tested, so that the two figures on
  // screen and the number between them cannot drift apart.
  const marketPick = marketProbForPick(marketImpliedA, aFavoured);
  const edge = modelEdgePts(pick.prob, marketPick);

  const thin = sample && sample.minStatBouts < 3;

  return (
    <section className="mp" aria-label="PBE model probability">
      <header className="mp-head">
        <div className="mp-brand">
          <span className="mp-dot" aria-hidden="true" />
          PBE MODEL
        </div>
        {kicker && <span className="mp-kicker">{kicker}</span>}
      </header>

      <div className="mp-split">
        <div className={`mp-side${aFavoured ? " lead" : ""}`}>
          <span className="mp-name">{a.name}</span>
          <b className="mp-pc">{pct(a.prob)}</b>
        </div>
        <div className={`mp-side r${aFavoured ? "" : " lead"}`}>
          <span className="mp-name">{b.name}</span>
          <b className="mp-pc">{pct(b.prob)}</b>
        </div>
      </div>

      <Bar a={a.prob} b={b.prob} />

      <dl className="mp-rows">
        <div className="mp-row">
          <dt>Market implied</dt>
          <dd>
            {marketPick == null ? (
              <span className="mp-none">No timestamp-compatible price</span>
            ) : (
              <>
                {pct(marketPick)} <span className="mp-sub">on {pick.name}{marketBooks ? ` · ${marketBooks} book${marketBooks === 1 ? "" : "s"}` : ""} · de-vigged</span>
              </>
            )}
          </dd>
        </div>
        <div className="mp-row">
          <dt>Model edge</dt>
          <dd>
            {edge == null ? (
              <span className="mp-none">Not computed without a price</span>
            ) : (
              <>
                <span className={`mp-edge ${edge >= 0 ? "pos" : "neg"}`}>{pts(edge)}</span>
                <span className="mp-sub"> model minus market, on {pick.name}</span>
              </>
            )}
          </dd>
        </div>
        <div className="mp-row">
          <dt>Confidence</dt>
          <dd>
            {evidence.band}% band
            {evidence.n > 0 ? (
              <span className="mp-sub"> · picks in this band went {pct(evidence.hit_rate, 1)} across {evidence.n.toLocaleString()} backtested fights</span>
            ) : (
              <span className="mp-sub"> · no backtested sample in this band</span>
            )}
          </dd>
        </div>
        {sample && (
          <div className="mp-row">
            <dt>Sample</dt>
            <dd>
              {sample.minPriorBouts === 0
                ? "One corner is debuting — no prior bouts on record"
                : `Thinner corner: ${sample.minPriorBouts} prior bout${sample.minPriorBouts === 1 ? "" : "s"}, ${sample.minStatBouts} with round stats`}
              {sample.featuresTotal ? (
                <span className="mp-sub"> · {sample.featuresAvailable}/{sample.featuresTotal} features available</span>
              ) : null}
              {thin && <span className="mp-warn"> Low sample</span>}
            </dd>
          </div>
        )}
        {settled && (
          <div className="mp-row">
            <dt>Result</dt>
            <dd>
              <span className={`mp-res ${settled.outcome === "WIN" ? "win" : "loss"}`}>
                {settled.outcome === "WIN" ? "Model correct" : "Model wrong"}
              </span>
              <span className="mp-sub"> · {settled.winnerName} won{settled.method ? ` by ${settled.method.replace(/_/g, "/")}` : ""}</span>
            </dd>
          </div>
        )}
      </dl>

      <footer className="mp-foot">
        <span className="mp-ver">{modelVersion}{featureVersion ? ` · ${featureVersion}` : ""}</span>
        {disclaimer && <span className="mp-disc">{disclaimer}</span>}
      </footer>
    </section>
  );
}

/** Compact one-line form for a fight row or a card list. Same rules: the split
 *  and the version, nothing implied. */
export function ModelProbabilityInline({ a, b, modelVersion }: { a: ModelSide; b: ModelSide; modelVersion: string }) {
  return (
    <div className="mp-inline" aria-label="PBE model probability">
      <span className="mp-inline-tag">PBE MODEL</span>
      <span className="mp-inline-side"><span>{a.name}</span><b>{pct(a.prob, 1)}</b></span>
      <span className="mp-inline-sep" aria-hidden="true" />
      <span className="mp-inline-side"><span>{b.name}</span><b>{pct(b.prob, 1)}</b></span>
      <span className="mp-inline-ver">{modelVersion}</span>
    </div>
  );
}
