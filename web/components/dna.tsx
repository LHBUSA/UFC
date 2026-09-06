/* Fight DNA UI — renders stored snapshots from the API. Every visible number
 * keeps its stored sample/confidence/origin. The UI never recomputes a metric
 * and, critically, never turns missing round coverage into a wall of nulls. */
import Link from "next/link";
import type { Confidence, DnaSnapshot, FighterDna, MatchupDna, MetricObject, StanceSplit } from "@/lib/dna";
import { fmtMetric, fmtRecord, sampleLine, STANCE_LABEL } from "@/lib/dna";
import { Octagon } from "./ui";

export function Origin({ kind = "derived" }: { kind?: "derived" | "source" | "licensed" | "model" }) {
  const label = kind === "derived" ? "PBE derived" : kind === "source" ? "Source" : kind === "licensed" ? "Licensed" : "Model";
  return <span className={`origin ${kind}`}>{label}</span>;
}

export function Conf({ c }: { c?: Confidence | null }) {
  const v = c || "insufficient";
  return <span className={`conf ${v}`} title={`Confidence: ${v}`}>{v}</span>;
}

function hasMetric(m?: MetricObject | null): boolean {
  return Boolean(m && m.value != null);
}

function metricEntries(items: Array<[MetricObject | null | undefined, string]>): Array<[MetricObject, string]> {
  return items.filter(([m]) => hasMetric(m)) as Array<[MetricObject, string]>;
}

export function Metric({ m, label, hint }: { m?: MetricObject | null; label: string; hint?: string }) {
  if (!hasMetric(m)) return null;
  return (
    <div className={`dna-tile${m?.confidence === "insufficient" ? " insuf" : ""}`} title={hint}>
      <b>{fmtMetric(m)}</b>
      <span className="k">{label}</span>
      <span className="s">{sampleLine(m) || "sample unavailable"} · <Conf c={m?.confidence} /></span>
    </div>
  );
}

function CoverageBadge({ s }: { s: DnaSnapshot }) {
  const hasResults = s.sample_completed_bouts > 0;
  const hasRounds = s.sample_stat_bouts > 0;
  return (
    <div className="dna-cov">
      {hasResults ? <span className="conf low">result DNA live</span> : <span className="conf insufficient">result sample pending</span>}
      {hasRounds
        ? <span className={`conf ${s.coverage_status}`}>{s.coverage_status} round coverage</span>
        : <span className="conf insufficient">round stats backfilling</span>}
      <span className="mono faint label">{s.sample_completed_bouts} completed bouts · {s.sample_stat_bouts} with round stats · {s.sample_rounds} rounds · {Math.round(s.sample_seconds / 60)} min observed · as of {s.as_of_date} · v{s.definition_version}</span>
    </div>
  );
}

export function StanceTable({ splits, title = "Result and finish split by opponent's listed stance" }: { splits: Record<string, StanceSplit>; title?: string }) {
  const order = ["ORTHODOX", "SOUTHPAW", "SWITCH", "OPEN_STANCE", "SIDEWAYS", "UNKNOWN", "open", "same"];
  const rows = order.filter((k) => splits[k] && ((splits[k].record?.appearances ?? splits[k].appearances ?? 0) > 0));
  if (!rows.length) return <div className="faint sm">No completed bouts in the archive yet.</div>;
  const showSig = rows.some((k) => hasMetric(splits[k]?.sig_diff_per_min));
  const showTd = rows.some((k) => hasMetric(splits[k]?.td_landed_per_15));
  return (
    <div className="tbl-wrap">
      <table className="tbl dna-tbl">
        <caption className="sr">{title}</caption>
        <thead><tr><th>vs stance</th><th className="c">App.</th><th className="c">Record</th><th className="c">KO/TKO</th><th className="c">Sub</th><th className="c">Dec</th><th className="c">Finish rate</th>{showSig && <th className="c">Sig. diff/min</th>}{showTd && <th className="c">TD/15</th>}<th>Conf.</th></tr></thead>
        <tbody>
          {rows.map((k) => {
            const s = splits[k];
            return (
              <tr key={k}>
                <td>{STANCE_LABEL[k] || k}</td>
                <td className="c">{s.record?.appearances ?? s.appearances ?? "—"}</td>
                <td className="c">{fmtRecord(s.record)}</td>
                <td className="c">{s.ko_tko_wins ?? 0}</td>
                <td className="c">{s.submission_wins ?? 0}</td>
                <td className="c">{s.decision_wins ?? 0}</td>
                <td className="c">{fmtMetric(s.finish_rate)}</td>
                {showSig && <td className="c">{fmtMetric(s.sig_diff_per_min)}{s.stat_bouts ? <span className="faint"> ({s.stat_bouts})</span> : null}</td>}
                {showTd && <td className="c">{fmtMetric(s.td_landed_per_15)}</td>}
                <td><Conf c={s.confidence} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RoundBars({ s }: { s: DnaSnapshot }) {
  const rounds = s.round_profile?.rounds || {};
  const keys = ["1", "2", "3", "4", "5"].filter((k) => rounds[k] && hasMetric(rounds[k].sig_att_per_min));
  if (!keys.length) return null;
  const max = Math.max(...keys.map((k) => rounds[k].sig_att_per_min?.value || 0), 0.01);
  return (
    <div className="rbars">
      {keys.map((k) => {
        const r = rounds[k];
        const v = r.sig_att_per_min?.value;
        return (
          <div className="rb" key={k}>
            <span className="k">R{k}</span>
            <span className="bar"><i style={{ width: `${v != null ? (v / max) * 100 : 0}%` }} /></span>
            <span className="v">{fmtMetric(r.sig_att_per_min)} <small>att{hasMetric(r.sig_landed_per_min) ? ` · ${fmtMetric(r.sig_landed_per_min)} landed` : ""}{hasMetric(r.absorbed_per_min) ? ` · ${fmtMetric(r.absorbed_per_min)} absorbed` : ""}</small></span>
            <span className="s">{r.rounds ?? 0} rd · {Math.round((r.seconds || 0) / 60)} min · <Conf c={r.sig_att_per_min?.confidence} /></span>
          </div>
        );
      })}
    </div>
  );
}

function Distribution({ m, label }: { m?: MetricObject | null; label: string }) {
  const direct = m as (MetricObject & { buckets?: Record<string, number>; total?: number; value?: number | { buckets?: Record<string, number>; total?: number } | null }) | null | undefined;
  const nested = direct?.value && typeof direct.value === "object" ? direct.value : null;
  const b = direct?.buckets || nested?.buckets || {};
  const keys = Object.keys(b).sort();
  const total = direct?.total || nested?.total || keys.reduce((n, k) => n + (b[k] || 0), 0);
  if (!keys.length || !total) return null;
  return (
    <div className="dna-tile">
      <div className="dist">{keys.map((k) => <span key={k} title={`Round ${k}: ${b[k]}`}><i style={{ height: `${Math.max(6, (b[k] / total) * 100)}%` }} /><em>R{k}</em><b>{b[k]}</b></span>)}</div>
      <span className="k">{label}</span>
      <span className="s">{total} finish{total === 1 ? "" : "es"} · <Conf c={m?.confidence} /></span>
    </div>
  );
}

function MetricGroup({ title, items }: { title: string; items: Array<[MetricObject | null | undefined, string]> }) {
  const visible = metricEntries(items);
  if (!visible.length) return null;
  return (
    <div className="dna-card">
      <div className="dna-card-head"><span className="eyebrow">{title}</span><Origin /></div>
      <div className="dna-tiles">{visible.map(([m, label]) => <Metric key={label} m={m} label={label} />)}</div>
    </div>
  );
}

export function FightDnaSection({ dna, fighterName }: { dna: FighterDna; fighterName: string }) {
  const s = dna.snapshot;
  const m = s.metrics || {};
  const fp = s.finish_profile || {};
  const rp = s.round_profile || {};
  const ctx = s.context_splits || {};
  const ctxRows = [["three_round", "3-round bouts"], ["five_round", "5-round bouts"], ["title", "Title bouts"], ["main_event", "Main events"], ["short_notice", "Short notice"]]
    .filter(([k]) => ((ctx[k]?.record?.appearances ?? ctx[k]?.appearances ?? 0) > 0));
  const roundExtras = metricEntries([
    [rp.pace_retention_r2_vs_r1, "R2 pace retention"],
    [rp.pace_retention_r3_vs_r1, "R3 pace retention"],
    [rp.championship_round_delta, "Championship-round delta"],
    [rp.defensive_drift_r3_vs_r1, "Defensive drift R3 vs R1"],
  ]);
  const positionReady = Object.keys(s.position_profile || {}).length > 0;
  const hasRoundDerived = s.sample_stat_bouts > 0;

  return (
    <section className="segment dna" id="fight-dna">
      <h3>Fight DNA <small>PropBetEdge derived · definition v{s.definition_version}</small><Origin /></h3>
      <CoverageBadge s={s} />
      <div className="dna-grid">
        <div className="dna-card wide">
          <div className="dna-card-head"><span className="eyebrow">Stance DNA</span><Origin /></div>
          <StanceTable splits={s.stance_splits || {}} />
          <p className="faint label mt-2">Results by the opponent&apos;s listed stance. A split describes history, not causation; confidence follows sample size.</p>
        </div>

        <MetricGroup title="Finish DNA" items={[
          [fp.finish_rate, "Finish rate (of wins)"],
          [fp.ko_finish_rate, "KO/TKO share of wins"],
          [fp.submission_finish_rate, "Sub share of wins"],
          [fp.finish_time_median_sec, "Median finish time"],
        ]} />

        <MetricGroup title="Striking DNA" items={[
          [m.sig_landed_per_min, "Sig. landed / min"],
          [m.sig_absorbed_per_min, "Sig. absorbed / min"],
          [m.sig_accuracy, "Sig. accuracy"],
          [m.sig_defense, "Sig. defence"],
          [m.head_attack_share, "Head share"],
          [m.body_attack_share, "Body share"],
          [m.leg_attack_share, "Leg share"],
          [m.distance_attack_share, "Distance share"],
          [m.clinch_attack_share, "Clinch share"],
          [m.ground_attack_share, "Ground share"],
          [m.knockdowns_per_15 || m.kd_per_15, "Knockdowns / 15"],
          [m.knockdowns_absorbed_per_15 || m.kd_absorbed_per_15, "KD absorbed / 15"],
        ]} />

        <MetricGroup title="Grappling DNA" items={[
          [m.td_attempts_per_15, "TD attempts / 15"],
          [m.td_landed_per_15, "TD landed / 15"],
          [m.td_accuracy, "TD accuracy"],
          [m.control_seconds_per_td, "Control / TD"],
          [m.control_share, "Control share"],
          [m.sub_attempts_per_15, "Sub attempts / 15"],
          [m.reversals_per_15, "Reversals / 15"],
        ]} />

        {(hasRoundDerived || roundExtras.length > 0) && (
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">Round profile</span><Origin /></div>
            <RoundBars s={s} />
            {roundExtras.length > 0 && <div className="dna-tiles mt-3">{roundExtras.map(([metric, label]) => <Metric key={label} m={metric} label={label} />)}</div>}
          </div>
        )}

        {!hasRoundDerived && s.sample_completed_bouts > 0 && (
          <div className="dna-card wide">
            <div className="dna-card-head"><span className="eyebrow">Round-stat expansion</span><Origin /></div>
            <p className="sm">Result, finish and stance DNA above is live from {s.sample_completed_bouts} completed bout{s.sample_completed_bouts === 1 ? "" : "s"}. Detailed striking, grappling and pace DNA is withheld until the round-stat archive contains observations for this fighter.</p>
            <p className="faint label mt-2">No zeroes are inferred from missing round data. This section expands automatically as the historical backfill lands.</p>
          </div>
        )}

        {(hasMetric(fp.finish_round_distribution) || hasMetric(fp.finished_by_round_distribution)) && (
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">Finish timing</span><Origin /></div>
            <div className="dna-tiles">
              <Distribution m={fp.finish_round_distribution} label="Finish wins by round" />
              <Distribution m={fp.finished_by_round_distribution} label="Finished by round" />
            </div>
          </div>
        )}

        {ctxRows.length > 0 && (
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">Context splits</span><Origin /></div>
            <div className="ctx">
              {ctxRows.map(([k, label]) => {
                const c = ctx[k];
                const app = c?.record?.appearances ?? c?.appearances ?? 0;
                return <div className="ctx-row" key={k}><span className="k">{label}</span><span className="v">{fmtRecord(c?.record)}</span><span className="s">{app} bout{app === 1 ? "" : "s"}{hasMetric(c?.finish_rate) ? ` · finish ${fmtMetric(c?.finish_rate)}` : ""} · <Conf c={c?.confidence} /></span></div>;
              })}
            </div>
          </div>
        )}

        {positionReady && (
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">Position profile</span><Origin kind="licensed" /></div>
            <div className="faint sm">Licensed position facts are available for this fighter and are being normalized into the public position profile.</div>
          </div>
        )}
      </div>
      <p className="faint label mt-3">Every Fight DNA number is derived by PropBetEdge from event-dated bout and round rows (ESPN identity/results, UFC Stats round stats), as of {s.as_of_date}, with the sample shown beside it. Career snapshots on the source are never used. {fighterName}&apos;s profile updates as coverage grows. <Link href="/about">Methodology</Link>.</p>
    </section>
  );
}

export function FightDnaEmpty({ reason }: { reason?: string }) {
  return (
    <section className="segment dna" id="fight-dna">
      <h3>Fight DNA <small>PropBetEdge derived</small><Origin /></h3>
      <div className="empty"><Octagon className="oc" /><h3>Fight DNA builds when coverage exists</h3><p>No snapshot yet for this fighter. Fight DNA appears once the archive contains completed bouts; round-stat families are added only when their observations exist.{reason ? ` (${reason})` : ""}</p></div>
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
      <h3>DNA matchup <small>PropBetEdge derived · evidence, not a pick</small><Origin /></h3>
      {(aCompleted > 0 || bCompleted > 0) && (
        <div className="dna-cov">
          <span className="conf low">result DNA live</span>
          <span className="mono faint label">Archive sample · {fa.name}: {aCompleted} completed / {aStats} with round stats · {fb.name}: {bCompleted} completed / {bStats} with round stats</span>
        </div>
      )}
      {sc && (sc.a_vs_b_stance || sc.b_vs_a_stance) && (
        <div className="dna-grid two">
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">{fa.name} vs {STANCE_LABEL[sc.b_stance || ""] || "listed"} opponents</span></div>
            {sc.a_vs_b_stance ? <SplitBlock s={sc.a_vs_b_stance} /> : <div className="faint sm">No archived bouts against {fb.name}&apos;s stance.</div>}
          </div>
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">{fb.name} vs {STANCE_LABEL[sc.a_stance || ""] || "listed"} opponents</span></div>
            {sc.b_vs_a_stance ? <SplitBlock s={sc.b_vs_a_stance} /> : <div className="faint sm">No archived bouts against {fa.name}&apos;s stance.</div>}
          </div>
        </div>
      )}
      {comps.length > 0 && (
        <div className="dna-card mt-4">
          <div className="dna-card-head"><span className="eyebrow">Supported paired profile</span><span className="faint label">{fa.name} · left · {fb.name} · right</span></div>
          <div className="compare">
            {comps.map((c) => {
              const av = c.a?.value, bv = c.b?.value;
              const an = typeof av === "number" ? av : null;
              const bn = typeof bv === "number" ? bv : null;
              const max = Math.max(Math.abs(an || 0), Math.abs(bn || 0)) || 1;
              return (
                <div className="cr" key={c.key} title={`${sampleLine(c.a)} | ${sampleLine(c.b)}`}>
                  <span className="v">{fmtMetric(c.a)}<small className="cs"><Conf c={c.a?.confidence} /></small></span>
                  <span className={`bar a${an != null && bn != null && an < bn ? " lose" : ""}`}><i style={{ width: `${an != null ? (Math.abs(an) / max) * 100 : 0}%` }} /></span>
                  <span className="k">{c.label}</span>
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
          <div className="dna-card-head"><span className="eyebrow">Round-stat coverage</span></div>
          <p className="sm">The matchup has result/finish/stance history, but detailed striking, target, pace and grappling comparisons are withheld until both fighters have archived round observations.</p>
          <p className="faint label mt-2">Missing round data is never rendered as a zero and no comparison is inferred from current-career snapshots.</p>
        </div>
      )}
      <div className="dna-grid two mt-4">
        <div className="dna-card">
          <div className="dna-card-head"><span className="eyebrow">Strongest supported observations</span></div>
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
          <div className="dna-card-head"><span className="eyebrow" style={{ color: "var(--pbe-crimson-bright)" }}>Counter-case and missing data</span></div>
          {dna.warnings?.length ? <ul className="warns">{dna.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : <div className="faint sm">No coverage warnings recorded for this pairing.</div>}
        </div>
      </div>
    </section>
  );
}

function SplitBlock({ s }: { s: StanceSplit }) {
  const app = s.record?.appearances ?? s.appearances ?? 0;
  const visible = metricEntries([
    [s.finish_rate, "Finish rate"],
    [s.ko_rate, "KO/TKO rate"],
    [s.sub_rate, "Submission rate"],
    [s.sig_diff_per_min, "Sig. diff / min"],
    [s.td_landed_per_15, "TD landed / 15"],
  ]);
  return (
    <div>
      <div className="dna-tiles">
        <div className="dna-tile"><b>{fmtRecord(s.record)}</b><span className="k">Record</span><span className="s">{app} appearance{app === 1 ? "" : "s"} · <Conf c={s.confidence} /></span></div>
        {visible.map(([m, label]) => <Metric key={label} m={m} label={label} />)}
      </div>
    </div>
  );
}

export function DnaEvidence({ dna }: { dna: MatchupDna }) {
  const ev = (dna.bettors_edge_evidence || []).filter((e) => e.value != null);
  if (!ev.length) return null;
  return (
    <div className="dna-evidence">
      <div className="between"><span className="eyebrow">Fight DNA evidence</span><Origin /></div>
      <ul>{ev.map((e) => <li key={e.key}><b>{e.label}</b> <span className="mono">{fmtMetric({ value: e.value, unit: e.unit || "ratio", confidence: e.confidence })}</span> <span className="faint label">{e.sample_bouts != null ? `${e.sample_bouts} bouts` : ""} · <Conf c={e.confidence} /></span>{e.text ? <p>{e.text}</p> : null}</li>)}</ul>
      <p className="faint label">Derived evidence with its sample; it informs the read above and is not a pick.</p>
    </div>
  );
}
