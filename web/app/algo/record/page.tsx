import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { PbeFamilyNav } from "@/components/PbeFamilyNav";
import { PbePerformanceTracker } from "@/components/PbePerformanceTracker";
import { PbePicksAutoRefresh } from "@/components/PbePicksAutoRefresh";
import { PastPicksEvent, PastPicksPager } from "@/components/PbePastPicks";
import { getAlgoArchive, getAlgoPerformanceProof, type AlgoArchiveSlices } from "@/lib/algo";
import { getImagesForFighters, type PortraitSet } from "@/lib/db";
import { confidenceCopy, pctText } from "@/lib/algoView";

/* Track Record & Past Picks: the public, permanent archive of official PBE Picks.
 *
 * Order: lifetime tracker, then the event/pick archive, then calibration and
 * confidence breakdowns. Only officially locked AND currently graded calls
 * expose a selection; pending and current calls remain behind UFC Pro on
 * /algo/card and an event awaiting grades shows counts only. Locked predictions
 * are immutable; a grade correction is a visible revision, never an overwrite.
 * Backtest, shadow and draft output never appears here.
 *
 * Ten events per page, paginated on the server from the full-history index
 * (lib/algoArchive.ts), so nothing here is capped or recomputed per page.
 * ?event= and ?pick= are permanent addresses and resolve their own page.
 * Dynamic and uncached: a new official grade is on the next render. */

export const metadata: Metadata = {
  title: "PBE Picks Track Record & Past Picks — Units, ROI and Every Graded UFC Call",
  description: "The permanent public archive of official PBE Picks: every graded locked UFC call by event, with the original locked odds, result, net units, ROI and grading revisions.",
  alternates: { canonical: "/algo/record" },
  robots: { index: true, follow: true },
};

type Summary = AlgoArchiveSlices["overall"];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || null;
const modelLabel = (v: string) => v.replace(/^pbe-fight-model-v/i, "PBE Fight Model V");

function SummaryRow({ label, s }: { label: string; s: Summary }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="r">{s.n ? `${s.wins}-${s.losses}` : "—"}</td>
      <td className="r">{pctText(s.hit)}</td>
      <td className="r">{s.brier == null ? "—" : s.brier.toFixed(3)}</td>
      <td className="r">{s.logLoss == null ? "—" : s.logLoss.toFixed(3)}</td>
    </tr>
  );
}

export default async function AlgoRecordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [archive, proof] = await Promise.all([
    getAlgoArchive({ page: Number(one(params.page)) || 1, event: one(params.event), pick: one(params.pick), model: one(params.model) }),
    getAlgoPerformanceProof(),
  ]);

  const fighterIds = archive.ok ? [...new Set(archive.events.flatMap((e) => e.picks.map((p) => p.pick.id)))] : [];
  const imgs: Map<string, PortraitSet> = fighterIds.length ? await getImagesForFighters(fighterIds).catch(() => new Map<string, PortraitSet>()) : new Map();

  /* Open by default: the addressed event, else the newest card that has a public pick. */
  const openId = archive.ok ? archive.focus_event_id || (archive.page === 1 ? (archive.events.find((e) => e.picks.length > 0) || archive.events[0])?.event_id : null) || null : null;

  return (
    <div className="wrap page algo-page">
      <PbePicksAutoRefresh intervalMs={60_000} />
      <PageHead
        crumbs={[{ name: "PBE Picks", href: "/algo/card" }, { name: "Track Record & Past Picks" }]}
        eyebrow="PropBetEdge UFC · Official live record"
        title="Track Record & Past Picks"
        lede="The permanent public archive. Every officially locked call stays in the record and every official grade stays attached to it. Current picks remain Pro; once a bout is graded, the pick is public for good."
      >
        <div className="row mt-3">
          <Link href="/algo/card" className="btn gold">Open Current PBE Picks</Link>
          <a href="#past-picks" className="btn">Browse Past Picks</a>
          <Link href="/algo" className="btn">How PBE Algo Works</Link>
        </div>
      </PageHead>

      <PbePerformanceTracker proof={proof} compact />

      <section id="past-picks" className="mdl-sec pp-past" aria-labelledby="past-picks-h">
        <div className="eyebrow">Permanent archive</div>
        <h2 id="past-picks-h">Past picks by event</h2>
        <p className="note">Newest card first. Each event keeps its own record, units and ROI, computed from every official pick on that card. Odds are the price frozen with the prediction at database lock and are never replaced with a later line.</p>

        {!archive.ok ? (
          <div className="card pp-past-error" role="alert">
            <div className="eyebrow">Archive temporarily unavailable</div>
            <h3>The record could not be read just now.</h3>
            <p className="dim">{archive.error} Nothing has been lost or changed: official picks and grades are stored permanently and this page reads them live. It retries automatically every minute.</p>
          </div>
        ) : archive.total_events === 0 ? (
          <div className="card algo-record-empty">
            <div className="eyebrow">Awaiting the first official lock</div>
            <h3>The archive opens with the first locked card.</h3>
            <p className="dim">Events appear here as soon as official picks are locked, and each pick becomes public when its bout is officially graded.</p>
          </div>
        ) : (
          <>
            {archive.model_versions.length > 1 && (
              <nav className="pp-filter pp-past-filter" aria-label="Filter by official model version">
                <Link href="/algo/record#past-picks" aria-current={archive.model ? undefined : "page"} scroll={false}>All official versions</Link>
                {archive.model_versions.map((v) => <Link key={v} href={`/algo/record?model=${encodeURIComponent(v)}#past-picks`} aria-current={archive.model === v ? "page" : undefined} scroll={false}>{modelLabel(v)}</Link>)}
              </nav>
            )}
            {archive.not_found && (
              <p className="pp-past-pending" role="status">
                {archive.not_found === "pick" ? "That link does not match a publicly graded pick. A pick gets its permanent address once it is officially graded." : "That link does not match an event in the archive."} Showing the newest events instead.
              </p>
            )}
            <div className="pp-past-meta">
              <span><b>{archive.total_events}</b> event{archive.total_events === 1 ? "" : "s"}</span>
              <span><b>{archive.integrity.locked}</b> official pick{archive.integrity.locked === 1 ? "" : "s"}</span>
              <span><b>{archive.integrity.graded}</b> graded</span>
              <span><b>{archive.integrity.pending}</b> pending</span>
              <span>Page {archive.page} of {archive.pages}</span>
              {archive.model && <span>{modelLabel(archive.model)} only</span>}
            </div>
            <div className="pp-past-events">
              {archive.events.map((e) => <PastPicksEvent key={e.event_id} event={e} open={e.event_id === openId} imgs={imgs} focusPick={archive.focus_prediction_id} />)}
            </div>
            <PastPicksPager page={archive.page} pages={archive.pages} model={archive.model} />
            {archive.integrity.unresolved_event_picks > 0 && (
              <p className="pp-past-pending">{archive.integrity.unresolved_event_picks} official pick{archive.integrity.unresolved_event_picks === 1 ? " names" : "s name"} an event that could not be resolved. {archive.integrity.unresolved_event_picks === 1 ? "It is" : "They are"} counted in every total and listed under “Event not resolved” rather than left out.</p>
            )}
          </>
        )}
      </section>

      {archive.ok && archive.integrity.graded > 0 && (
        <>
          <section className="mdl-sec">
            <div className="eyebrow">Calibration</div>
            <h2>How well the stated probabilities held up.</h2>
            <p className="note">Computed over the full official history{archive.model ? ` of ${modelLabel(archive.model)}` : ""}, not the events shown above.</p>
            <div className="mdl-rec mt-4">
              <div className="stat model"><b>{archive.integrity.graded}</b><span>Graded picks</span></div>
              <div className="stat model"><b>{archive.slices.overall.n ? `${archive.slices.overall.wins}-${archive.slices.overall.losses}` : "—"}</b><span>Decided W-L</span></div>
              <div className="stat model"><b>{pctText(archive.slices.overall.hit)}</b><span>Hit rate</span></div>
              <div className="stat model"><b>{archive.slices.overall.brier == null ? "—" : archive.slices.overall.brier.toFixed(3)}</b><span>Brier score</span></div>
              <div className="stat model"><b>{archive.slices.overall.logLoss == null ? "—" : archive.slices.overall.logLoss.toFixed(3)}</b><span>Log loss</span></div>
              <div className="stat model"><b>{archive.lifetime.priced_decided}</b><span>ROI-priced decisions</span>{archive.lifetime.no_decision > 0 && <span className="faint">{archive.lifetime.no_decision} draw / NC / void</span>}</div>
            </div>
          </section>

          <section className="mdl-sec">
            <div className="eyebrow">Confidence &amp; edge breakdowns</div>
            <h2>Where the live record is hitting — and where it is not.</h2>
            <p className="note">These are live official calls only. They are not backtest rows and they are never blended with historical model research.</p>
            <div className="tbl-wrap mt-4">
              <table className="tbl">
                <caption className="sr-only">Record by confidence tier and by PBE Edge at lock</caption>
                <thead><tr><th>Slice</th><th className="r">W-L</th><th className="r">Hit</th><th className="r">Brier</th><th className="r">Log loss</th></tr></thead>
                <tbody>
                  {archive.slices.byConfidence.map(({ key, s }) => <SummaryRow key={key} label={`${confidenceCopy(key)} confidence`} s={s} />)}
                  {archive.slices.byEdge.map(({ label, s }) => <SummaryRow key={label} label={label} s={s} />)}
                  <SummaryRow label="No current market at lock (stale or no line)" s={archive.slices.noMarket} />
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <div className="mdl-split-note mt-4">
        <b>ROI methodology:</b> flat 1-unit stake on each decided call at the best available price captured in that call&apos;s frozen lock-time market snapshot. W/L calls without a valid stored price remain in record and hit-rate calculations but are excluded from the ROI denominator. Draws, no contests and voids are excluded from W-L and ROI. Closing-line value remains separate and will only appear when a verified closing snapshot exists.
      </div>

      <PbeFamilyNav current="record" />
    </div>
  );
}
