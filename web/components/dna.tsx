/* PropBetEdge Fight DNA UI — renders stored snapshots from the API.
 *
 * Two experiences at once. Expert: every metric, sample, confidence, split
 * and definition version stays visible. Learning: a Quick Read of stored
 * facts, family subtitles, accessible explainers on every technical metric,
 * a confidence key, a data-coverage bar and an optional EXPLAIN STATS mode.
 * The UI never recomputes a metric, never grades a value ("elite", "poor"),
 * never invents a benchmark, and never turns missing round coverage into a
 * wall of zeros. Definitions live in lib/dnaGlossary.ts, not in JSX. */
import Link from "next/link";
import type { Confidence, DnaSnapshot, FighterDna, MatchupDna, MetricObject, StanceSplit } from "@/lib/dna";
import { fmtMetric, fmtRecord, sampleLine, STANCE_LABEL } from "@/lib/dna";
import { Octagon } from "./ui";
import { Explain, ExplainToggle, DeeperDetail } from "./Explain";
import { CONFIDENCE_EXPLAINER, FAMILY, GLOSSARY, PBE_DERIVED_EXPLAINER, SAMPLE_EXPLAINER, lookup, quickRead } from "@/lib/dnaGlossary";

const LEARN = "/learn/fight-dna";

function metricRows(m?: MetricObject | null): Array<[string, string]> {
  if (!m) return [];
  const rows: Array<[string, string]> = [["Sample", sampleLine(m) || "unavailable"], ["Confidence", m.confidence || "insufficient"]];
  if (m.as_of_date) rows.push(["As of", m.as_of_date]);
  rows.push(["Definition", `v${m.definition_version ?? 1}`]);
  return rows;
}

/* PBE DERIVED is a product signal, not a disclaimer: the badge stays, and
 * with `explain` it opens the provenance explainer. */
export function Origin({ kind = "derived", explain = false }: { kind?: "derived" | "source" | "licensed" | "model"; explain?: boolean }) {
  const label = kind === "derived" ? "PBE derived" : kind === "source" ? "Source" : kind === "licensed" ? "Licensed" : "Model";
  return (
    <span className={`origin ${kind}`}>
      {label}
      {explain && kind === "derived" && (
        <Explain title={PBE_DERIVED_EXPLAINER.title} body={PBE_DERIVED_EXPLAINER.body} rows={[["Definition", "versioned Fight DNA registry"], ["Sample", "shown beside every number"], ["Confidence", "tier set by the sample"], ["As of", "snapshot date"]]} learnHref={`${LEARN}#pbe-derived`} learnLabel="PBE Derived explained →" label="What does PBE Derived mean?" />
      )}
    </span>
  );
}

export function Conf({ c }: { c?: Confidence | null }) {
  const v = c || "insufficient";
  return <span className={`conf ${v}`}>{v}</span>;
}

/* Global confidence key shown near the Fight DNA heading. */
export function ConfKey() {
  return (
    <span className="dna-conf-key">
      Confidence
      <Explain title="Confidence" body={CONFIDENCE_EXPLAINER.summary} rows={CONFIDENCE_EXPLAINER.tiers.map((t) => [t.label, t.short] as [string, string])} caution={CONFIDENCE_EXPLAINER.source} learnHref={`${LEARN}#confidence`} learnLabel="Confidence tiers explained →" label="What does confidence mean?" />
    </span>
  );
}

function hasMetric(m?: MetricObject | null): boolean {
  return Boolean(m && m.value != null);
}

function metricEntries(items: Array<[MetricObject | null | undefined, string]>): Array<[MetricObject, string]> {
  return items.filter(([m]) => hasMetric(m)) as Array<[MetricObject, string]>;
}

export function Metric({ m, label, hint, primary = false, gkey }: { m?: MetricObject | null; label: string; hint?: string; primary?: boolean; gkey?: string }) {
  if (!hasMetric(m)) return null;
  const g = lookup(gkey || m?.metric_key || label);
  return (
    <div className={`dna-tile${primary ? " primary" : " secondary"}${m?.confidence === "insufficient" ? " insuf" : ""}`} title={hint}>
      <b>{fmtMetric(m)}</b>
      <span className="k">
        {label}
        {g && <Explain title={g.fullName} body={g.plainEnglish} unit={g.unitExplanation} caution={g.caution} formula={g.formula} rows={metricRows(m)} learnHref={`${LEARN}#${g.learnAnchor}`} label={`Explain ${g.fullName}`} />}
      </span>
      {g && <span className="dna-x">{g.learnLine}</span>}
      <span className="s">{sampleLine(m) || "sample unavailable"} · <Conf c={m?.confidence} /></span>
    </div>
  );
}

/* ---- data coverage: every number has receipts ---------------------------- */
function Coverage({ s }: { s: DnaSnapshot }) {
  const hasResults = s.sample_completed_bouts > 0;
  const hasRounds = s.sample_stat_bouts > 0;
  return (
    <div className="dna-coverage" id="dna-coverage" aria-label="Data coverage">
      <div className="dna-coverage-head">
        <span className="eyebrow">Data coverage <small>· every number has receipts</small></span>
        <span className="dna-conf-key">Why sample size matters <Explain title={SAMPLE_EXPLAINER.title} body={SAMPLE_EXPLAINER.body} learnHref={`${LEARN}#sample-size`} learnLabel="Sample size explained →" label="Why sample size matters" /></span>
      </div>
      <div className="cov-cells">
        <div className="cov-cell"><b>{s.sample_completed_bouts}</b><span>Completed bouts</span></div>
        <div className="cov-cell"><b>{s.sample_rounds}</b><span>Rounds with stats</span></div>
        <div className="cov-cell"><b>{Math.round(s.sample_seconds / 60)}<small>min</small></b><span>Observed</span></div>
        <div className="cov-cell"><b><span className={`conf ${hasRounds ? s.coverage_status : "insufficient"}`}>{hasRounds ? s.coverage_status : "pending"}</span></b><span>Round coverage</span></div>
        <div className="cov-cell"><b style={{ fontSize: 15 }}>{s.as_of_date}</b><span>As of</span></div>
        <div className="cov-cell"><b>v{s.definition_version}</b><span>Definition</span></div>
      </div>
      <div className="dna-cov">
        {hasResults ? <span className="conf low">result DNA live</span> : <span className="conf insufficient">result sample pending</span>}
        {hasRounds ? <span className={`conf ${s.coverage_status}`}>{s.coverage_status} round coverage</span> : <span className="conf insufficient">round stats backfilling</span>}
        <span className="mono faint label">{s.sample_stat_bouts} of {s.sample_completed_bouts} completed bout{s.sample_completed_bouts === 1 ? "" : "s"} carry round stats · sources: normalized event, bout and round records</span>
      </div>
    </div>
  );
}

/* ---- quick read: fact translation, not a pick ---------------------------- */
function QuickRead({ s }: { s: DnaSnapshot }) {
  const facts = quickRead(s.metrics || {}, (s.finish_profile || {}) as unknown as Record<string, MetricObject | undefined>, 6);
  if (!facts.length) return null;
  return (
    <div className="dna-quick" aria-labelledby="dna-quick-title">
      <div className="dna-quick-head">
        <div><span className="eyebrow">Quick read</span><h4 id="dna-quick-title">What the data says</h4></div>
        <p>Stored facts translated into plain English, each with its sample. Not a prediction and not a generated pick.</p>
      </div>
      <ul>{facts.map((f) => <li key={f.key}><span>{f.text}</span><small>{f.sample || "sample unavailable"} · <Conf c={f.confidence as Confidence} /></small></li>)}</ul>
      <div className="dna-based">
        <div><em>Based on</em><b>{s.sample_completed_bouts} completed bout{s.sample_completed_bouts === 1 ? "" : "s"}</b> · <b>{s.sample_rounds} round{s.sample_rounds === 1 ? "" : "s"} with stats</b> · <b>{Math.round(s.sample_seconds / 60)} observed minutes</b></div>
        <a href="#dna-detail">Explore full Fight DNA ↓</a>
      </div>
    </div>
  );
}

function FamHead({ fam, extra }: { fam: keyof typeof FAMILY; extra?: React.ReactNode }) {
  const f = FAMILY[fam];
  return (
    <div className="dna-card-head">
      <div className="dna-fam"><h4><Link href={`${LEARN}#${f.anchor}`}>{f.title}</Link></h4><p className="dna-sub">{f.subtitle}</p></div>
      {extra ?? <Origin />}
    </div>
  );
}

function TH({ label, gkey, className }: { label: string; gkey?: string; className?: string }) {
  const g = gkey ? GLOSSARY[gkey] : null;
  return <th className={className}>{label}{g && <Explain title={g.fullName} body={g.plainEnglish} unit={g.unitExplanation} caution={g.caution} formula={g.formula} learnHref={`${LEARN}#${g.learnAnchor}`} label={`Explain ${g.fullName}`} />}</th>;
}

export function StanceTable({ splits, title = "Result and finish split by opponent's listed stance" }: { splits: Record<string, StanceSplit>; title?: string }) {
  const order = ["ORTHODOX", "SOUTHPAW", "SWITCH", "OPEN_STANCE", "SIDEWAYS", "UNKNOWN", "open", "same"];
  const rows = order.filter((k) => splits[k] && ((splits[k].record?.appearances ?? splits[k].appearances ?? 0) > 0));
  if (!rows.length) return <div className="faint sm">No completed bouts in the archive yet.</div>;
  const showSig = rows.some((k) => hasMetric(splits[k]?.sig_diff_per_min));
  const showTd = rows.some((k) => hasMetric(splits[k]?.td_landed_per_15));
  return (
    <>
      <p className="dna-callout"><b>Historical split, not causation.</b><span>Results grouped by the opponent&apos;s listed stance at the source. A split with two appearances describes two fights, not a tendency; confidence follows the sample.</span></p>
      <div className="tbl-wrap dna-cards">
        <table className="tbl dna-tbl cards">
          <caption className="sr">{title}</caption>
          <thead><tr>
            <TH label="vs listed stance" gkey="stance_record" />
            <TH label="Appearances" gkey="stance_appearances" className="c" />
            <th className="c">Record</th>
            <th className="c">KO/TKO wins</th>
            <th className="c">Submission wins</th>
            <th className="c">Decision wins</th>
            <TH label="Finish rate" gkey="stance_finish_rate" className="c" />
            {showSig && <TH label="Strike differential / min" gkey="stance_sig_diff_per_min" className="c" />}
            {showTd && <TH label="Takedowns / 15" gkey="stance_td_rate_15" className="c" />}
            <th>Confidence</th>
          </tr></thead>
          <tbody>
            {rows.map((k) => {
              const s = splits[k];
              return (
                <tr key={k}>
                  <td data-l="vs listed stance">{STANCE_LABEL[k] || k}</td>
                  <td className="c" data-l="Appearances">{s.record?.appearances ?? s.appearances ?? "—"}</td>
                  <td className="c" data-l="Record">{fmtRecord(s.record)}</td>
                  <td className="c" data-l="KO/TKO wins">{s.ko_tko_wins ?? 0}</td>
                  <td className="c" data-l="Submission wins">{s.submission_wins ?? 0}</td>
                  <td className="c" data-l="Decision wins">{s.decision_wins ?? 0}</td>
                  <td className="c" data-l="Finish rate">{fmtMetric(s.finish_rate)}</td>
                  {showSig && <td className="c" data-l="Strike differential / min">{fmtMetric(s.sig_diff_per_min)}{s.stat_bouts ? <span className="faint"> ({s.stat_bouts} with stats)</span> : null}</td>}
                  {showTd && <td className="c" data-l="Takedowns / 15">{fmtMetric(s.td_landed_per_15)}</td>}
                  <td data-l="Confidence"><Conf c={s.confidence} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RoundBars({ s }: { s: DnaSnapshot }) {
  const rounds = s.round_profile?.rounds || {};
  const keys = ["1", "2", "3", "4", "5"].filter((k) => rounds[k] && hasMetric(rounds[k].sig_att_per_min));
  if (!keys.length) return null;
  const max = Math.max(...keys.map((k) => rounds[k].sig_att_per_min?.value || 0), 0.01);
  const g = GLOSSARY.sig_att_per_min;
  return (
    <>
      <p className="dna-note">Shows how striking pace changes from round to round using the available round-level sample. Bars scale attempts per minute against this fighter&apos;s busiest round; the numbers are what matter.</p>
      <div className="rbars">
        {keys.map((k) => {
          const r = rounds[k];
          const v = r.sig_att_per_min?.value;
          return (
            <div className="rb" key={k}>
              <span className="k">R{k}</span>
              <div className="rb-main">
                <span><b>{fmtMetric(r.sig_att_per_min)}</b><small>attempts</small>{k === keys[0] && <Explain title={g.fullName} body={g.plainEnglish} unit={g.unitExplanation} rows={metricRows(r.sig_att_per_min)} learnHref={`${LEARN}#${g.learnAnchor}`} label={`Explain ${g.fullName}`} />}</span>
                {hasMetric(r.sig_landed_per_min) && <span><b>{fmtMetric(r.sig_landed_per_min)}</b><small>landed</small></span>}
                {hasMetric(r.absorbed_per_min) && <span><b>{fmtMetric(r.absorbed_per_min)}</b><small>absorbed</small></span>}
              </div>
              <span className="bar"><i style={{ width: `${v != null ? (v / max) * 100 : 0}%` }} /></span>
              <span className="s">{r.rounds ?? 0} round{(r.rounds ?? 0) === 1 ? "" : "s"} · {Math.round((r.seconds || 0) / 60)} min observed · <Conf c={r.sig_att_per_min?.confidence} /></span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Distribution({ m, label, gkey }: { m?: MetricObject | null; label: string; gkey: string }) {
  const rawValue = (m as unknown as { value?: unknown } | null | undefined)?.value;
  const nested = rawValue && typeof rawValue === "object" ? rawValue as { buckets?: Record<string, number>; total?: number } : null;
  const b = m?.buckets || nested?.buckets || {};
  const keys = Object.keys(b).sort();
  const total = m?.total || nested?.total || keys.reduce((n, k) => n + (b[k] || 0), 0);
  if (!keys.length || !total) return null;
  const g = GLOSSARY[gkey];
  return (
    <div className="dna-tile">
      <div className="dist">{keys.map((k) => <span key={k} title={`Round ${k}: ${b[k]}`}><i style={{ height: `${Math.max(6, (b[k] / total) * 100)}%` }} /><em>R{k}</em><b>{b[k]}</b></span>)}</div>
      <span className="k">{label}{g && <Explain title={g.fullName} body={g.plainEnglish} formula={g.formula} rows={[["Total", `${total} finish${total === 1 ? "" : "es"}`], ["Confidence", m?.confidence || "insufficient"]]} learnHref={`${LEARN}#${g.learnAnchor}`} label={`Explain ${g.fullName}`} />}</span>
      {g && <span className="dna-x">{g.learnLine}</span>}
      <span className="s">{total} finish{total === 1 ? "" : "es"} · <Conf c={m?.confidence} /></span>
    </div>
  );
}

type Items = Array<[MetricObject | null | undefined, string, string?]>;

function Tiles({ items, primary = false }: { items: Items; primary?: boolean }) {
  const visible = items.filter(([m]) => hasMetric(m)) as Array<[MetricObject, string, string?]>;
  if (!visible.length) return null;
  return <div className={`dna-tiles${primary ? " primary" : ""}`}>{visible.map(([m, label, gkey]) => <Metric key={label} m={m} label={label} primary={primary} gkey={gkey} />)}</div>;
}

const count = (items: Items) => items.filter(([m]) => hasMetric(m)).length;

/* ---- fighter page section ------------------------------------------------ */
export function FightDnaSection({ dna, fighterName }: { dna: FighterDna; fighterName: string }) {
  const s = dna.snapshot;
  const m = s.metrics || {};
  const fp = s.finish_profile || {};
  const rp = s.round_profile || {};
  const ctx = s.context_splits || {};
  const ctxRows = [["three_round", "3-round bouts", "three_round_record"], ["five_round", "5-round bouts", "five_round_record"], ["title", "Title bouts", "title_bout_record"], ["main_event", "Main events", "main_event_record"], ["short_notice", "Short notice", "short_notice_record"]]
    .filter(([k]) => ((ctx[k]?.record?.appearances ?? ctx[k]?.appearances ?? 0) > 0));
  const positionReady = Object.keys(s.position_profile || {}).length > 0;
  const hasRoundDerived = s.sample_stat_bouts > 0;

  const finishItems: Items = [[fp.finish_rate, "Finish rate (of wins)", "finish_rate"], [fp.ko_finish_rate, "KO/TKO share of wins", "ko_finish_rate"], [fp.submission_finish_rate, "Sub share of wins", "submission_finish_rate"], [fp.finish_time_median_sec, "Median finish time", "finish_time_median_sec"]];
  const strikingPrimary: Items = [[m.sig_landed_per_min, "Sig. landed / min", "sig_landed_per_min"], [m.sig_absorbed_per_min, "Sig. absorbed / min", "sig_absorbed_per_min"], [m.sig_accuracy, "Sig. accuracy", "sig_accuracy"], [m.sig_defense, "Sig. defense", "sig_defense"]];
  const strikingDeeper: Items = [[m.head_attack_share, "Head share", "head_attack_share"], [m.body_attack_share, "Body share", "body_attack_share"], [m.leg_attack_share, "Leg share", "leg_attack_share"], [m.distance_attack_share, "Distance share", "distance_attack_share"], [m.clinch_attack_share, "Clinch share", "clinch_attack_share"], [m.ground_attack_share, "Ground share", "ground_attack_share"], [m.knockdowns_per_15 || m.kd_per_15, "Knockdowns / 15", "knockdowns_per_15"], [m.knockdowns_absorbed_per_15 || m.kd_absorbed_per_15, "KD absorbed / 15", "knockdowns_absorbed_per_15"], [m.sig_diff_per_min, "Strike differential / min", "sig_diff_per_min"]];
  const grapplingPrimary: Items = [[m.td_attempts_per_15, "TD attempts / 15", "td_attempts_per_15"], [m.td_landed_per_15, "TD landed / 15", "td_landed_per_15"], [m.td_accuracy, "TD accuracy", "td_accuracy"], [m.control_seconds_per_td, "Control / TD", "control_seconds_per_td"]];
  const grapplingDeeper: Items = [[m.control_share, "Control share", "control_share"], [m.sub_attempts_per_15, "Sub attempts / 15", "sub_attempts_per_15"], [m.reversals_per_15, "Reversals / 15", "reversals_per_15"]];
  const roundExtras: Items = [[rp.pace_retention_r2_vs_r1, "R2 pace retention", "pace_retention_r2_vs_r1"], [rp.pace_retention_r3_vs_r1, "R3 pace retention", "pace_retention_r3_vs_r1"], [rp.championship_round_delta, "Championship-round delta", "championship_round_delta"], [rp.defensive_drift_r3_vs_r1, "Defensive drift R3 vs R1", "defensive_drift_r3_vs_r1"]];

  return (
    <section className="segment dna" id="fight-dna" data-explain="off">
      <header className="dna-head">
        <div className="dna-head-copy">
          <div className="eyebrow">Proprietary intelligence · PropBetEdge Fight DNA</div>
          <h3>Fight DNA <small>definition v{s.definition_version} · as of {s.as_of_date}</small></h3>
          <p className="dna-lede">Proprietary PropBetEdge intelligence reconstructed from {fighterName}&apos;s event-dated bout and round history. <em>Raw data tells you what happened. Fight DNA describes the fighter the data reveals.</em></p>
          <div className="dna-derived-line"><Origin explain /><span>Not simply copied from a source fighter profile. These metrics are calculated from the underlying fight record using versioned Fight DNA definitions, and every one carries its sample, confidence and as-of date. <Link href={LEARN}>How to read Fight DNA →</Link></span></div>
        </div>
        <div className="dna-head-tools">
          <ConfKey />
          <ExplainToggle target="fight-dna" />
        </div>
      </header>

      <Coverage s={s} />
      <QuickRead s={s} />

      <div className="dna-grid" id="dna-detail">
        <div className="dna-card wide">
          <FamHead fam="stance" />
          <StanceTable splits={s.stance_splits || {}} />
        </div>

        {count(finishItems) > 0 && (
          <div className="dna-card">
            <FamHead fam="finish" />
            <Tiles items={finishItems} primary />
          </div>
        )}

        {(count(strikingPrimary) > 0 || count(strikingDeeper) > 0) && (
          <div className="dna-card">
            <FamHead fam="striking" />
            <Tiles items={strikingPrimary} primary />
            {count(strikingDeeper) > 0 && (
              <DeeperDetail id="striking" summary={`Targeting & position · ${count(strikingDeeper)} more metrics`}>
                <p className="dna-note" style={{ marginTop: 4 }}>Where the significant-strike offense went (head, body, leg) and where it was thrown from (distance, clinch, ground), plus knockdown rates. Shares are of this fighter&apos;s own attempts.</p>
                <Tiles items={strikingDeeper} />
              </DeeperDetail>
            )}
          </div>
        )}

        {(count(grapplingPrimary) > 0 || count(grapplingDeeper) > 0) && (
          <div className="dna-card">
            <FamHead fam="grappling" />
            <Tiles items={grapplingPrimary} primary />
            {count(grapplingDeeper) > 0 && (
              <DeeperDetail id="grappling" summary={`Control, submissions & reversals · ${count(grapplingDeeper)} more metrics`}>
                <Tiles items={grapplingDeeper} />
              </DeeperDetail>
            )}
          </div>
        )}

        {(hasRoundDerived || count(roundExtras) > 0) && (
          <div className="dna-card">
            <FamHead fam="round" />
            <RoundBars s={s} />
            {count(roundExtras) > 0 && (
              <DeeperDetail id="round" summary={`Pace retention & drift · ${count(roundExtras)} metrics`}>
                <p className="dna-note" style={{ marginTop: 4 }}>Ratios and differences between rounds, computed only over bouts where both rounds carry stats. 100% retention means round two matched round one.</p>
                <Tiles items={roundExtras} />
              </DeeperDetail>
            )}
          </div>
        )}

        {!hasRoundDerived && s.sample_completed_bouts > 0 && (
          <div className="dna-card wide">
            <div className="dna-card-head"><div className="dna-fam"><h4>Round-stat expansion</h4><p className="dna-sub">Striking, grappling and pace DNA are withheld until round observations exist.</p></div><Origin /></div>
            <p className="sm">Result, finish and stance DNA above is live from {s.sample_completed_bouts} completed bout{s.sample_completed_bouts === 1 ? "" : "s"}. Detailed striking, grappling and pace DNA is withheld until the round-stat archive contains observations for this fighter.</p>
            <p className="dna-note">No zeroes are inferred from missing round data. This section expands automatically as the historical backfill lands.</p>
          </div>
        )}

        {(hasMetric(fp.finish_round_distribution) || hasMetric(fp.finished_by_round_distribution)) && (
          <div className="dna-card">
            <div className="dna-card-head"><div className="dna-fam"><h4><Link href={`${LEARN}#finish-rate`}>Finish timing</Link></h4><p className="dna-sub">Which round the recorded finishes, and the losses by stoppage, arrived in.</p></div><Origin /></div>
            <div className="dna-tiles">
              <Distribution m={fp.finish_round_distribution} label="Finish wins by round" gkey="finish_round_distribution" />
              <Distribution m={fp.finished_by_round_distribution} label="Finished by round" gkey="finished_by_round_distribution" />
            </div>
          </div>
        )}

        {ctxRows.length > 0 && (
          <div className="dna-card">
            <FamHead fam="context" />
            <div className="ctx">
              {ctxRows.map(([k, label, gkey]) => {
                const c = ctx[k];
                const app = c?.record?.appearances ?? c?.appearances ?? 0;
                const g = GLOSSARY[gkey];
                return <div className="ctx-row" key={k}><span className="k">{label}{g && <Explain title={g.fullName} body={g.plainEnglish} caution={g.caution} formula={g.formula} learnHref={`${LEARN}#${g.learnAnchor}`} label={`Explain ${g.fullName}`} />}</span><span className="v">{fmtRecord(c?.record)}</span><span className="s">{app} bout{app === 1 ? "" : "s"}{hasMetric(c?.finish_rate) ? ` · finish rate ${fmtMetric(c?.finish_rate)}` : ""} · <Conf c={c?.confidence} /></span></div>;
              })}
            </div>
          </div>
        )}

        {positionReady && (
          <div className="dna-card">
            <div className="dna-card-head"><div className="dna-fam"><h4>Position profile</h4><p className="dna-sub">Licensed position facts, normalized into the public profile as they are validated.</p></div><Origin kind="licensed" /></div>
            <div className="faint sm">Licensed position facts are available for this fighter and are being normalized into the public position profile.</div>
          </div>
        )}
      </div>
      <p className="dna-note mt-3">Every Fight DNA number is derived by PropBetEdge from event-dated bout and round rows (ESPN identity/results, UFC Stats round stats), as of {s.as_of_date}, with the sample shown beside it. Career snapshots on the source are never used. {fighterName}&apos;s profile updates as coverage grows. Fight DNA is not an official UFC statistic and does not claim certainty about the next fight. <Link href={LEARN}>How to read Fight DNA</Link> · <Link href="/about">Methodology</Link>.</p>
    </section>
  );
}

export function FightDnaEmpty({ reason }: { reason?: string }) {
  return (
    <section className="segment dna" id="fight-dna">
      <header className="dna-head">
        <div className="dna-head-copy">
          <div className="eyebrow">Proprietary intelligence · PropBetEdge Fight DNA</div>
          <h3>Fight DNA</h3>
          <p className="dna-lede">Proprietary PropBetEdge intelligence reconstructed from a fighter&apos;s event-dated bout and round history.</p>
        </div>
        <div className="dna-head-tools"><Origin explain /></div>
      </header>
      <div className="empty"><Octagon className="oc" /><h3>Fight DNA builds when coverage exists</h3><p>No snapshot yet for this fighter. Fight DNA appears once the archive contains completed bouts; round-stat families are added only when their observations exist.{reason ? ` (${reason})` : ""} <Link href={LEARN}>How Fight DNA is built →</Link></p></div>
    </section>
  );
}

type PairRow = { key: string; label: string; a: MetricObject | null; b: MetricObject | null };

function pairRows(dna: MatchupDna): PairRow[] {
  const aFinish = dna.a?.finish_profile;
  const bFinish = dna.b?.finish_profile;
  const stored: PairRow[] = [
    { key: "finish_rate", label: "Finish rate", a: aFinish?.finish_rate || dna.a?.metrics?.finish_rate || null, b: bFinish?.finish_rate || dna.b?.metrics?.finish_rate || null },
    { key: "ko_finish_rate", label: "KO/TKO share of wins", a: aFinish?.ko_finish_rate || dna.a?.metrics?.ko_finish_rate || null, b: bFinish?.ko_finish_rate || dna.b?.metrics?.ko_finish_rate || null },
    { key: "submission_finish_rate", label: "Submission share of wins", a: aFinish?.submission_finish_rate || dna.a?.metrics?.submission_finish_rate || null, b: bFinish?.submission_finish_rate || dna.b?.metrics?.submission_finish_rate || null },
    { key: "finish_time_median_sec", label: "Median finish time", a: aFinish?.finish_time_median_sec || dna.a?.metrics?.finish_time_median_sec || null, b: bFinish?.finish_time_median_sec || dna.b?.metrics?.finish_time_median_sec || null },
  ];
  const supplied = (dna.comparisons || []).map((c) => ({ key: c.key, label: c.label, a: c.a, b: c.b }));
  const seen = new Set<string>();
  return [...stored, ...supplied].filter((c) => {
    if (seen.has(c.key) || (!hasMetric(c.a) && !hasMetric(c.b))) return false;
    seen.add(c.key);
    return true;
  });
}

/* ---- matchup ---- */
export function DnaMatchup({ dna }: { dna: MatchupDna }) {
  const [fa, fb] = dna.fighters;
  const comps = pairRows(dna);
  const sc = dna.stance_context;
  const aCompleted = dna.a?.sample_completed_bouts || 0;
  const bCompleted = dna.b?.sample_completed_bouts || 0;
  const aStats = dna.a?.sample_stat_bouts || 0;
  const bStats = dna.b?.sample_stat_bouts || 0;
  return (
    <section className="segment dna" id="dna-matchup">
      <header className="dna-head">
        <div className="dna-head-copy">
          <div className="eyebrow">PropBetEdge Fight DNA · Matchup DNA</div>
          <h3>Matchup DNA <small>evidence, not a pick</small></h3>
          <p className="dna-lede"><em>Two fighter histories. One matchup-specific intelligence layer.</em> Fight DNA compares relevant historical characteristics from each fighter — stance interaction, pace, finish patterns, round progression and context — rather than treating career averages as isolated numbers. Every observation below traces to stored evidence with its sample and confidence.</p>
          <div className="dna-derived-line"><Origin explain /><span>Calculated by PropBetEdge from both fighters&apos; normalized fight records. Not an official UFC statistic and not a prediction. <Link href={`${LEARN}#matchup`}>How Matchup DNA works →</Link></span></div>
        </div>
        <div className="dna-head-tools"><ConfKey /></div>
      </header>
      {(aCompleted > 0 || bCompleted > 0) && (
        <div className="dna-cov">
          <span className="conf low">result DNA live</span>
          <span className="mono faint label">Archive sample · {fa.name}: {aCompleted} completed / {aStats} with round stats · {fb.name}: {bCompleted} completed / {bStats} with round stats</span>
        </div>
      )}
      {sc && (sc.a_vs_b_stance || sc.b_vs_a_stance) && (
        <div className="dna-grid two mt-4">
          <div className="dna-card">
            <div className="dna-card-head"><div className="dna-fam"><h4>{fa.name} vs {STANCE_LABEL[sc.b_stance || ""] || "listed"} opponents</h4><p className="dna-sub">Stance interaction: {fa.name}&apos;s archived results against opponents listed with {fb.name}&apos;s stance. Historical split, not causation.</p></div><Origin /></div>
            {sc.a_vs_b_stance ? <SplitBlock s={sc.a_vs_b_stance} /> : <div className="faint sm">No archived bouts against {fb.name}&apos;s stance.</div>}
          </div>
          <div className="dna-card">
            <div className="dna-card-head"><div className="dna-fam"><h4>{fb.name} vs {STANCE_LABEL[sc.a_stance || ""] || "listed"} opponents</h4><p className="dna-sub">Stance interaction: {fb.name}&apos;s archived results against opponents listed with {fa.name}&apos;s stance. Historical split, not causation.</p></div><Origin /></div>
            {sc.b_vs_a_stance ? <SplitBlock s={sc.b_vs_a_stance} /> : <div className="faint sm">No archived bouts against {fa.name}&apos;s stance.</div>}
          </div>
        </div>
      )}
      {comps.length > 0 && (
        <div className="dna-card mt-4">
          <div className="dna-card-head"><div className="dna-fam"><h4>Supported paired profile</h4><p className="dna-sub">Each fighter&apos;s stored metric side by side, with its own sample and confidence. Bars compare magnitude only.</p></div><span className="faint label">{fa.name} · left · {fb.name} · right</span></div>
          <div className="compare">
            {comps.map((c) => {
              const av = c.a?.value, bv = c.b?.value;
              const an = typeof av === "number" ? av : null;
              const bn = typeof bv === "number" ? bv : null;
              const max = Math.max(Math.abs(an || 0), Math.abs(bn || 0)) || 1;
              const g = lookup(c.key) || lookup(c.label);
              return (
                <div className="cr" key={c.key}>
                  <span className="v">{fmtMetric(c.a)}<small className="cs"><Conf c={c.a?.confidence} /></small></span>
                  <span className={`bar a${an != null && bn != null && an < bn ? " lose" : ""}`}><i style={{ width: `${an != null ? (Math.abs(an) / max) * 100 : 0}%` }} /></span>
                  <span className="k">{c.label}{g && <Explain title={g.fullName} body={g.plainEnglish} unit={g.unitExplanation} caution={g.caution} rows={[["Left sample", sampleLine(c.a) || "—"], ["Right sample", sampleLine(c.b) || "—"]]} learnHref={`${LEARN}#${g.learnAnchor}`} label={`Explain ${g.fullName}`} />}</span>
                  <span className={`bar b${an != null && bn != null && bn < an ? " lose" : ""}`}><i style={{ width: `${bn != null ? (Math.abs(bn) / max) * 100 : 0}%` }} /></span>
                  <span className="v b"><small className="cs"><Conf c={c.b?.confidence} /></small>{fmtMetric(c.b)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {(aStats === 0 || bStats === 0) && (aCompleted > 0 || bCompleted > 0) && (
        <div className="dna-card mt-4">
          <div className="dna-card-head"><div className="dna-fam"><h4>Round-stat coverage</h4></div></div>
          <p className="sm">The matchup has result/finish/stance history, but detailed striking, target, pace and grappling comparisons are withheld until both fighters have archived round observations.</p>
          <p className="dna-note">Missing round data is never rendered as a zero and no comparison is inferred from current-career snapshots.</p>
        </div>
      )}
      <div className="dna-grid two mt-4">
        <div className="dna-card">
          <div className="dna-card-head"><div className="dna-fam"><h4>Strongest supported observations</h4><p className="dna-sub">Emitted only when the underlying metric clears its sample threshold; otherwise it lands in the counter-case column.</p></div></div>
          {dna.insights?.length ? (
            <ul className="insights">
              {dna.insights.map((i) => (
                <li key={i.key}>
                  <div className="between"><b>{i.label}</b><span><Conf c={i.confidence} /> <span className="mono faint label">{i.sample_bouts != null ? `${i.sample_bouts} bouts` : ""}{i.sample_rounds ? ` · ${i.sample_rounds} rd` : ""}</span></span></div>
                  <p>{i.explanation}</p>
                </li>
              ))}
            </ul>
          ) : <div className="faint sm">No additional observation clears its sample threshold yet. The supported profile above remains available.</div>}
        </div>
        <div className="dna-card warn">
          <div className="dna-card-head"><div className="dna-fam"><h4 style={{ color: "var(--pbe-crimson-bright)" }}>Counter-case and missing data</h4><p className="dna-sub">What the record cannot support for this pairing, stated instead of hidden.</p></div></div>
          {dna.warnings?.length ? <ul className="warns">{dna.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : <div className="faint sm">No coverage warnings recorded for this pairing.</div>}
        </div>
      </div>
    </section>
  );
}

function SplitBlock({ s }: { s: StanceSplit }) {
  const app = s.record?.appearances ?? s.appearances ?? 0;
  const items: Items = [[s.finish_rate, "Finish rate", "stance_finish_rate"], [s.ko_rate, "KO/TKO rate", "stance_ko_rate"], [s.sub_rate, "Submission rate", "stance_sub_rate"], [s.sig_diff_per_min, "Strike differential / min", "stance_sig_diff_per_min"], [s.td_landed_per_15, "Takedowns / 15", "stance_td_rate_15"]];
  return (
    <div>
      <div className="dna-tiles">
        <div className="dna-tile"><b>{fmtRecord(s.record)}</b><span className="k">Record</span><span className="s">{app} appearance{app === 1 ? "" : "s"} · <Conf c={s.confidence} /></span></div>
        {(items.filter(([m]) => hasMetric(m)) as Array<[MetricObject, string, string?]>).map(([m, label, gkey]) => <Metric key={label} m={m} label={label} gkey={gkey} />)}
      </div>
    </div>
  );
}

export function DnaEvidence({ dna }: { dna: MatchupDna }) {
  const ev = (dna.bettors_edge_evidence || []).filter((e) => e.value != null);
  if (!ev.length) return null;
  return (
    <div className="dna-evidence">
      <div className="between"><span className="eyebrow">Fight DNA evidence</span><Origin explain /></div>
      <ul>{ev.map((e) => <li key={e.key}><b>{e.label}</b> <span className="mono">{fmtMetric({ value: e.value, unit: e.unit || "ratio", confidence: e.confidence })}</span> <span className="faint label">{e.sample_bouts != null ? `${e.sample_bouts} bouts` : ""} · <Conf c={e.confidence} /></span>{e.text ? <p>{e.text}</p> : null}</li>)}</ul>
      <p className="faint label">Derived evidence with its sample; it informs the read above and is not a pick.</p>
    </div>
  );
}
