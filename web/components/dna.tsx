/* Fight DNA UI — renders stored snapshots from the API. Every card shows the
 * sample behind it and the origin label; nothing is recomputed here. */
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
export function Metric({ m, label, hint }: { m?: MetricObject | null; label: string; hint?: string }) {
  const insufficient = !m || m.value == null || m.confidence === "insufficient";
  return (
    <div className={`dna-tile${insufficient ? " insuf" : ""}`} title={hint}>
      <b>{fmtMetric(m)}</b>
      <span className="k">{label}</span>
      <span className="s">{m ? sampleLine(m) || "no sample" : "no data"}{m ? <> · <Conf c={m.confidence} /></> : null}</span>
    </div>
  );
}

function CoverageBadge({ s }: { s: DnaSnapshot }) {
  return (
    <div className="dna-cov">
      <span className={`conf ${s.coverage_status}`}>{s.coverage_status} coverage</span>
      <span className="mono faint label">{s.sample_completed_bouts} completed bouts · {s.sample_stat_bouts} with round stats · {s.sample_rounds} rounds · {Math.round(s.sample_seconds / 60)} min observed · as of {s.as_of_date} · v{s.definition_version}</span>
    </div>
  );
}

export function StanceTable({ splits, title = "Result and finish split by opponent's listed stance" }: { splits: Record<string, StanceSplit>; title?: string }) {
  const order = ["ORTHODOX", "SOUTHPAW", "SWITCH", "OPEN_STANCE", "SIDEWAYS", "UNKNOWN", "open", "same"];
  const rows = order.filter((k) => splits[k] && ((splits[k].record?.appearances ?? splits[k].appearances ?? 0) > 0));
  if (!rows.length) return <div className="faint sm">No completed bouts in the archive yet.</div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl dna-tbl">
        <caption className="sr">{title}</caption>
        <thead><tr><th>vs stance</th><th className="c">App.</th><th className="c">Record</th><th className="c">KO/TKO</th><th className="c">Sub</th><th className="c">Dec</th><th className="c">Finish rate</th><th className="c">Sig. diff/min</th><th className="c">TD/15</th><th>Conf.</th></tr></thead>
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
                <td className="c">{fmtMetric(s.sig_diff_per_min)}{s.stat_bouts ? <span className="faint"> ({s.stat_bouts})</span> : null}</td>
                <td className="c">{fmtMetric(s.td_landed_per_15)}</td>
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
  const keys = ["1", "2", "3", "4", "5"].filter((k) => rounds[k]);
  if (!keys.length) return <div className="faint sm">No round-level stats in the archive yet.</div>;
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
            <span className="v">{fmtMetric(r.sig_att_per_min)} <small>att · {fmtMetric(r.sig_landed_per_min)} landed · {fmtMetric(r.absorbed_per_min)} absorbed</small></span>
            <span className="s">{r.rounds ?? 0} rd · {Math.round((r.seconds || 0) / 60)} min · <Conf c={r.sig_att_per_min?.confidence} /></span>
          </div>
        );
      })}
    </div>
  );
}

function Distribution({ m, label }: { m?: MetricObject | null; label: string }) {
  const b = m?.buckets || {};
  const keys = Object.keys(b).sort();
  const total = m?.total || keys.reduce((n, k) => n + (b[k] || 0), 0);
  if (!keys.length || !total) return <Metric m={null} label={label} />;
  return (
    <div className="dna-tile">
      <div className="dist">{keys.map((k) => <span key={k} title={`Round ${k}: ${b[k]}`}><i style={{ height: `${Math.max(6, (b[k] / total) * 100)}%` }} /><em>R{k}</em><b>{b[k]}</b></span>)}</div>
      <span className="k">{label}</span>
      <span className="s">{total} finish{total === 1 ? "" : "es"} · <Conf c={m?.confidence} /></span>
    </div>
  );
}

export function FightDnaSection({ dna, fighterName }: { dna: FighterDna; fighterName: string }) {
  const s = dna.snapshot;
  const m = s.metrics || {};
  const fp = s.finish_profile || {};
  const rp = s.round_profile || {};
  const ctx = s.context_splits || {};
  return (
    <section className="segment dna" id="fight-dna">
      <h3>Fight DNA <small>PropBetEdge derived · definition v{s.definition_version}</small><Origin /></h3>
      <CoverageBadge s={s} />
      <div className="dna-grid">
        <div className="dna-card wide">
          <div className="dna-card-head"><span className="eyebrow">Stance DNA</span><Origin /></div>
          <StanceTable splits={s.stance_splits || {}} />
          <p className="faint label mt-2">Results by the opponent's listed stance. A split describes history, not causation; confidence follows sample size.</p>
        </div>
        <div className="dna-card">
          <div className="dna-card-head"><span className="eyebrow">Striking DNA</span><Origin /></div>
          <div className="dna-tiles">
            <Metric m={m.sig_landed_per_min} label="Sig. landed / min" />
            <Metric m={m.sig_absorbed_per_min} label="Sig. absorbed / min" />
            <Metric m={m.sig_accuracy} label="Sig. accuracy" />
            <Metric m={m.sig_defense} label="Sig. defence" />
            <Metric m={m.head_attack_share} label="Head share" />
            <Metric m={m.body_attack_share} label="Body share" />
            <Metric m={m.leg_attack_share} label="Leg share" />
            <Metric m={m.distance_attack_share} label="Distance share" />
            <Metric m={m.clinch_attack_share} label="Clinch share" />
            <Metric m={m.ground_attack_share} label="Ground share" />
            <Metric m={m.knockdowns_per_15 || m.kd_per_15} label="Knockdowns / 15" />
            <Metric m={m.knockdowns_absorbed_per_15 || m.kd_absorbed_per_15} label="KD absorbed / 15" />
          </div>
        </div>
        <div className="dna-card">
          <div className="dna-card-head"><span className="eyebrow">Grappling DNA</span><Origin /></div>
          <div className="dna-tiles">
            <Metric m={m.td_attempts_per_15} label="TD attempts / 15" />
            <Metric m={m.td_landed_per_15} label="TD landed / 15" />
            <Metric m={m.td_accuracy} label="TD accuracy" />
            <Metric m={m.control_seconds_per_td} label="Control / TD" />
            <Metric m={m.control_share} label="Control share" />
            <Metric m={m.sub_attempts_per_15} label="Sub attempts / 15" />
            <Metric m={m.reversals_per_15} label="Reversals / 15" />
          </div>
        </div>
        <div className="dna-card">
          <div className="dna-card-head"><span className="eyebrow">Round profile</span><Origin /></div>
          <RoundBars s={s} />
          <div className="dna-tiles mt-3">
            <Metric m={rp.pace_retention_r2_vs_r1} label="R2 pace retention" />
            <Metric m={rp.pace_retention_r3_vs_r1} label="R3 pace retention" />
            <Metric m={rp.championship_round_delta} label="Championship-round delta" />
            <Metric m={rp.defensive_drift_r3_vs_r1} label="Defensive drift R3 vs R1" />
          </div>
        </div>
        <div className="dna-card">
          <div className="dna-card-head"><span className="eyebrow">Finish profile</span><Origin /></div>
          <div className="dna-tiles">
            <Metric m={fp.finish_rate} label="Finish rate (of wins)" />
            <Metric m={fp.ko_finish_rate} label="KO/TKO share of wins" />
            <Metric m={fp.submission_finish_rate} label="Sub share of wins" />
            <Metric m={fp.finish_time_median_sec} label="Median finish time" />
            <Distribution m={fp.finish_round_distribution} label="Finish wins by round" />
            <Distribution m={fp.finished_by_round_distribution} label="Finished by round" />
          </div>
        </div>
        <div className="dna-card">
          <div className="dna-card-head"><span className="eyebrow">Context splits</span><Origin /></div>
          <div className="ctx">
            {[["three_round", "3-round bouts"], ["five_round", "5-round bouts"], ["title", "Title bouts"], ["main_event", "Main events"], ["short_notice", "Short notice"]].map(([k, label]) => {
              const c = ctx[k];
              const app = c?.record?.appearances ?? c?.appearances ?? 0;
              return <div className="ctx-row" key={k}><span className="k">{label}</span><span className="v">{app ? fmtRecord(c?.record) : "—"}</span><span className="s">{app ? `${app} · finish ${fmtMetric(c?.finish_rate)}` : "no bouts"} · <Conf c={c?.confidence} /></span></div>;
            })}
          </div>
        </div>
        <div className="dna-card">
          <div className="dna-card-head"><span className="eyebrow">Position profile</span><Origin kind="licensed" /></div>
          <div className="faint sm">Position and finishing-weapon data requires licensed source facts and is not yet ingested. Nothing is shown until it exists.</div>
        </div>
      </div>
      <p className="faint label mt-3">Every Fight DNA number is derived by PropBetEdge from event-dated bout and round rows (ESPN identity/results, UFC Stats round stats), as of {s.as_of_date}, with the sample shown beside it. Career snapshots on the source are never used. {fighterName}'s profile updates as coverage grows. <Link href="/about">Methodology</Link>.</p>
    </section>
  );
}

export function FightDnaEmpty({ reason }: { reason?: string }) {
  return (
    <section className="segment dna" id="fight-dna">
      <h3>Fight DNA <small>PropBetEdge derived</small><Origin /></h3>
      <div className="empty"><Octagon className="oc" /><h3>Fight DNA builds when coverage exists</h3><p>No snapshot yet for this fighter. Fight DNA is computed only from archived bouts and round stats; it appears once the archive holds completed fights for this fighter.{reason ? ` (${reason})` : ""}</p></div>
    </section>
  );
}

/* ---- matchup ---- */
export function DnaMatchup({ dna }: { dna: MatchupDna }) {
  const [fa, fb] = dna.fighters;
  const comps = dna.comparisons || [];
  const sc = dna.stance_context;
  return (
    <section className="segment dna" id="dna-matchup">
      <h3>DNA matchup <small>PropBetEdge derived · evidence, not a pick</small><Origin /></h3>
      {sc && (sc.a_vs_b_stance || sc.b_vs_a_stance) && (
        <div className="dna-grid two">
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">{fa.name} vs {STANCE_LABEL[sc.b_stance || ""] || "listed"} opponents</span></div>
            {sc.a_vs_b_stance ? <SplitBlock s={sc.a_vs_b_stance} /> : <div className="faint sm">No archived bouts against {fb.name}'s stance.</div>}
          </div>
          <div className="dna-card">
            <div className="dna-card-head"><span className="eyebrow">{fb.name} vs {STANCE_LABEL[sc.a_stance || ""] || "listed"} opponents</span></div>
            {sc.b_vs_a_stance ? <SplitBlock s={sc.b_vs_a_stance} /> : <div className="faint sm">No archived bouts against {fa.name}'s stance.</div>}
          </div>
        </div>
      )}
      {comps.length > 0 && (
        <div className="dna-card mt-4">
          <div className="dna-card-head"><span className="eyebrow">Paired profile</span><span className="faint label">{fa.name} · left · {fb.name} · right</span></div>
          <div className="compare">
            {comps.map((c) => {
              const av = c.a?.value, bv = c.b?.value;
              const max = Math.max(Math.abs(av || 0), Math.abs(bv || 0)) || 1;
              return (
                <div className="cr" key={c.key} title={`${sampleLine(c.a)} | ${sampleLine(c.b)}`}>
                  <span className="v">{fmtMetric(c.a)}<small className="cs"><Conf c={c.a?.confidence} /></small></span>
                  <span className={`bar a${av != null && bv != null && av < bv ? " lose" : ""}`}><i style={{ width: `${av != null ? (Math.abs(av) / max) * 100 : 0}%` }} /></span>
                  <span className="k">{c.label}</span>
                  <span className={`bar b${av != null && bv != null && bv < av ? " lose" : ""}`}><i style={{ width: `${bv != null ? (Math.abs(bv) / max) * 100 : 0}%` }} /></span>
                  <span className="v b"><small className="cs"><Conf c={c.b?.confidence} /></small>{fmtMetric(c.b)}</span>
                </div>
              );
            })}
          </div>
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
          ) : <div className="faint sm">No observation clears the sample thresholds for this pairing yet. Nothing is inferred below threshold.</div>}
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
  return (
    <div>
      <div className="dna-tiles">
        <div className="dna-tile"><b>{fmtRecord(s.record)}</b><span className="k">Record</span><span className="s">{app} appearances · <Conf c={s.confidence} /></span></div>
        <Metric m={s.finish_rate} label="Finish rate" />
        <Metric m={s.ko_rate} label="KO/TKO rate" />
        <Metric m={s.sig_diff_per_min} label="Sig. diff / min" />
        <Metric m={s.td_landed_per_15} label="TD landed / 15" />
      </div>
    </div>
  );
}

export function DnaEvidence({ dna }: { dna: MatchupDna }) {
  const ev = dna.bettors_edge_evidence || [];
  if (!ev.length) return null;
  return (
    <div className="dna-evidence">
      <div className="between"><span className="eyebrow">Fight DNA evidence</span><Origin /></div>
      <ul>{ev.map((e) => <li key={e.key}><b>{e.label}</b> <span className="mono">{e.value != null ? fmtMetric({ value: e.value, unit: e.unit || "ratio", confidence: e.confidence }) : "—"}</span> <span className="faint label">{e.sample_bouts != null ? `${e.sample_bouts} bouts` : ""} · <Conf c={e.confidence} /></span>{e.text ? <p>{e.text}</p> : null}</li>)}</ul>
      <p className="faint label">Derived evidence with its sample; it informs the read above and is not a pick.</p>
    </div>
  );
}
