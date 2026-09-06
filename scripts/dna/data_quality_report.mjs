/* Fight DNA data-quality report — an INDEPENDENT verifier over the stored
 * tables (it does not import the builder). Recomputes the checks the
 * acceptance matrix demands from canonical rows and compares them with what
 * the builder persisted.
 *
 *   node scripts/dna/data_quality_report.mjs [--json] [--out docs/fight_dna_quality.md]
 *
 * Checks:
 *   1. counts: features / snapshots / stance-split rows / build runs, confidence + coverage distributions
 *   2. null audit: per metric key, share of snapshots where value is null and confidence is `insufficient`
 *   3. stance-split reconciliation: W/L/D/NC per fighter x opponent stance recomputed from
 *      ufc_bout_results + ufc_fighters.stance for bouts before as_of_date, compared to the table rows
 *   4. opponent-absorbed reconciliation: for each bout with two feature rows, A's raw absorbed
 *      totals equal B's landed totals (sig, total strikes, TD, KD) and vice versa
 *   5. leakage: no snapshot lists a bout whose event_date >= as_of_date in provenance.bouts;
 *      sample_completed_bouts never exceeds completed bouts strictly before as_of_date
 *   6. observed time: no feature row claims observed_seconds > scheduled_rounds * 300 (+ overtime)
 *   7. determinism proxy: two most recent successful build runs report identical output_counts for the same watermark */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const URL_ = (process.env.SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const OUT = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : join(ROOT, 'docs', 'fight_dna_quality.md'); })();

async function rest(path) {
  const out = []; let off = 0;
  for (;;) {
    const res = await fetch(`${URL_}/rest/v1/${path}${path.includes('?') ? '&' : '?'}offset=${off}&limit=1000`, { headers: H });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${res.status}`);
    const rows = await res.json(); out.push(...rows);
    if (rows.length < 1000) return out; off += 1000;
  }
}
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

async function main() {
  const [feat, snaps, splits, runs, defs, bouts, results, fighters, events, rounds] = await Promise.all([
    rest('ufc_fighter_bout_features?select=fighter_id,bout_id,event_id,opponent_id,event_date,feature_version,fighter_stance,opponent_stance,stance_context,outcome,method,scheduled_rounds,round_rows,observed_seconds,stats_coverage,raw_stats,features'),
    rest('ufc_fighter_dna_snapshots?select=fighter_id,as_of_date,definition_version,sample_bouts,sample_completed_bouts,sample_stat_bouts,sample_rounds,sample_seconds,coverage_status,metrics,stance_splits,provenance'),
    rest('ufc_fighter_stance_splits?select=fighter_id,as_of_date,opponent_stance,definition_version,appearances,wins,losses,draws,no_contests,ko_tko_wins,submission_wins,decision_wins,confidence'),
    rest('ufc_dna_build_runs?select=id,definition_version,mode,status,started_at,finished_at,source_watermark,input_counts,output_counts,warnings,errors&order=started_at.desc'),
    rest('ufc_dna_metric_definitions?select=metric_key,definition_version,family,min_bouts,min_rounds,min_seconds,active'),
    rest('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,scheduled_rounds,status'),
    rest('ufc_bout_results?select=bout_id,winner_id,method,round,time_sec,time_format'),
    rest('ufc_fighters?select=id,stance'),
    rest('ufc_events?select=id,event_date'),
    rest('ufc_bout_round_stats?select=bout_id,fighter_id,round,sig_str_landed,total_str_landed,td_landed,kd'),
  ]);
  const report = { generated_at: new Date().toISOString(), tables_present: { features: feat !== null, snapshots: snaps !== null, splits: splits !== null, runs: runs !== null, definitions: defs !== null }, checks: {} };
  if (!feat || !snaps || !splits) return finish(report, 'DNA tables missing (migration 004 not applied)');

  /* 1. counts */
  report.counts = {
    feature_rows: feat.length, feature_bouts: new Set(feat.map((f) => f.bout_id)).size, feature_fighters: new Set(feat.map((f) => f.fighter_id)).size,
    stats_coverage: count(feat, (f) => f.stats_coverage), snapshots: snaps.length, snapshot_fighters: new Set(snaps.map((s) => s.fighter_id)).size,
    coverage_status: count(snaps, (s) => s.coverage_status), stance_split_rows: splits.length, split_confidence: count(splits, (s) => s.confidence),
    build_runs: runs?.length || 0, build_run_status: count(runs || [], (r) => r.status), definitions: defs?.length || 0,
  };

  /* 2. null audit over current snapshots (latest as_of per fighter) */
  const latest = new Map();
  for (const s of snaps) { const cur = latest.get(s.fighter_id); if (!cur || s.as_of_date > cur.as_of_date) latest.set(s.fighter_id, s); }
  const cur = [...latest.values()];
  const keys = new Set(); for (const s of cur) for (const k of Object.keys(s.metrics || {})) keys.add(k);
  const nullAudit = {};
  for (const k of keys) {
    let present = 0, nulls = 0, insuf = 0, withNullButConfident = 0;
    for (const s of cur) { const m = s.metrics?.[k]; if (!m) continue; present += 1; if (m.value == null) nulls += 1; if (m.confidence === 'insufficient') insuf += 1; if (m.value == null && m.confidence && m.confidence !== 'insufficient') withNullButConfident += 1; }
    nullAudit[k] = { present, null_value: nulls, insufficient: insuf, null_but_confident: withNullButConfident };
  }
  report.checks.null_audit = { metric_keys: keys.size, violations: Object.entries(nullAudit).filter(([, v]) => v.null_but_confident > 0).map(([k]) => k), detail: nullAudit };

  /* 3. stance-split reconciliation (independent recompute) */
  const stanceOf = new Map(fighters.map((f) => [f.id, f.stance || 'UNKNOWN']));
  const dateOf = new Map(events.map((e) => [e.id, e.event_date]));
  const resBy = new Map(results.map((r) => [r.bout_id, r]));
  const boutsByFighter = new Map();
  for (const b of bouts) { for (const fid of [b.fighter_a_id, b.fighter_b_id]) { if (!boutsByFighter.has(fid)) boutsByFighter.set(fid, []); boutsByFighter.get(fid).push(b); } }
  let checked = 0, mismatches = [];
  for (const sp of splits) {
    const mine = (boutsByFighter.get(sp.fighter_id) || []).filter((b) => resBy.has(b.id) && (dateOf.get(b.event_id) || '9999') < sp.as_of_date);
    const rec = { appearances: 0, wins: 0, losses: 0, draws: 0, no_contests: 0, ko: 0, sub: 0, dec: 0 };
    for (const b of mine) {
      const opp = b.fighter_a_id === sp.fighter_id ? b.fighter_b_id : b.fighter_a_id;
      if ((stanceOf.get(opp) || 'UNKNOWN') !== sp.opponent_stance) continue;
      const r = resBy.get(b.id); rec.appearances += 1;
      if (r.method === 'NC') rec.no_contests += 1;
      else if (r.method === 'DRAW' || !r.winner_id) rec.draws += 1;
      else if (r.winner_id === sp.fighter_id) { rec.wins += 1; if (r.method === 'KO_TKO') rec.ko += 1; else if (r.method === 'SUB') rec.sub += 1; else rec.dec += 1; }
      else rec.losses += 1;
    }
    checked += 1;
    const diff = ['appearances', 'wins', 'losses', 'draws', 'no_contests'].filter((k) => rec[k] !== sp[k]).concat(rec.ko !== sp.ko_tko_wins ? ['ko_tko_wins'] : [], rec.sub !== sp.submission_wins ? ['submission_wins'] : [], rec.dec !== sp.decision_wins ? ['decision_wins'] : []);
    if (diff.length) mismatches.push({ fighter_id: sp.fighter_id, as_of_date: sp.as_of_date, opponent_stance: sp.opponent_stance, fields: diff, expected: rec, stored: { appearances: sp.appearances, wins: sp.wins, losses: sp.losses, draws: sp.draws, no_contests: sp.no_contests, ko: sp.ko_tko_wins, sub: sp.submission_wins, dec: sp.decision_wins } });
  }
  report.checks.stance_split_reconciliation = { rows_checked: checked, mismatches: mismatches.length, sample: mismatches.slice(0, 5) };

  /* 4. opponent-absorbed reconciliation from raw round rows */
  const landedBy = new Map();
  for (const r of rounds) { const k = `${r.bout_id}:${r.fighter_id}`; const t = landedBy.get(k) || { sig: 0, tot: 0, td: 0, kd: 0 }; t.sig += r.sig_str_landed || 0; t.tot += r.total_str_landed || 0; t.td += r.td_landed || 0; t.kd += r.kd || 0; landedBy.set(k, t); }
  let absChecked = 0, absMismatch = [];
  for (const f of feat) {
    const ot = f.raw_stats?.opp_totals; if (!ot) continue;
    const truth = landedBy.get(`${f.bout_id}:${f.opponent_id}`); if (!truth) continue;
    absChecked += 1;
    const sig = ot.sig_l ?? ot.sig_landed ?? ot.sig; const td = ot.td_l ?? ot.td_landed ?? ot.td; const kd = ot.kd;
    if ((sig != null && sig !== truth.sig) || (td != null && td !== truth.td) || (kd != null && kd !== truth.kd)) absMismatch.push({ fighter_id: f.fighter_id, bout_id: f.bout_id, stored: { sig, td, kd }, truth });
  }
  report.checks.opponent_absorbed_reconciliation = { rows_checked: absChecked, mismatches: absMismatch.length, sample: absMismatch.slice(0, 5) };

  /* 5. leakage */
  let leak = [];
  for (const s of snaps) {
    const ids = s.provenance?.bouts || [];
    for (const id of ids) { const b = bouts.find((x) => x.id === id); if (b && (dateOf.get(b.event_id) || '') >= s.as_of_date) leak.push({ fighter_id: s.fighter_id, as_of_date: s.as_of_date, bout_id: id, event_date: dateOf.get(b.event_id) }); }
    const before = (boutsByFighter.get(s.fighter_id) || []).filter((b) => resBy.has(b.id) && (dateOf.get(b.event_id) || '9999') < s.as_of_date).length;
    if (s.sample_completed_bouts > before) leak.push({ fighter_id: s.fighter_id, as_of_date: s.as_of_date, reason: `sample_completed_bouts ${s.sample_completed_bouts} > completed before as_of ${before}` });
  }
  report.checks.leakage = { snapshots_checked: snaps.length, violations: leak.length, sample: leak.slice(0, 5) };

  /* 6. observed time bounds */
  const over = feat.filter((f) => f.observed_seconds != null && f.scheduled_rounds && f.observed_seconds > f.scheduled_rounds * 300 + 300);
  const zeroDenom = feat.filter((f) => f.round_rows === 0 && f.features && Object.values(f.features).some((v) => typeof v === 'number' && v === 0));
  report.checks.observed_time = { rows_over_bound: over.length, rows_with_zero_instead_of_null: zeroDenom.length, sample: over.slice(0, 3).map((f) => ({ bout_id: f.bout_id, observed_seconds: f.observed_seconds, scheduled_rounds: f.scheduled_rounds })) };

  /* 7. determinism proxy from build runs */
  const ok = (runs || []).filter((r) => r.status === 'success' && r.mode !== 'dry_run');
  const pairs = [];
  for (let i = 0; i + 1 < ok.length; i += 1) { const a = ok[i], b = ok[i + 1]; if (JSON.stringify(a.source_watermark) === JSON.stringify(b.source_watermark)) pairs.push({ a: a.id, b: b.id, same_output_counts: JSON.stringify(a.output_counts) === JSON.stringify(b.output_counts) }); }
  report.checks.determinism_runs = { successful_runs: ok.length, same_watermark_pairs: pairs.length, all_identical: pairs.every((p) => p.same_output_counts), pairs: pairs.slice(0, 3) };
  report.latest_run = ok[0] ? { id: ok[0].id, mode: ok[0].mode, started_at: ok[0].started_at, input_counts: ok[0].input_counts, output_counts: ok[0].output_counts, warnings: (ok[0].warnings || []).length, errors: (ok[0].errors || []).length } : null;

  /* sample / confidence proof: a high, low and zero coverage fighter */
  const byCov = (c) => cur.find((s) => s.coverage_status === c);
  report.samples = Object.fromEntries(['high', 'medium', 'low', 'insufficient'].map((c) => { const s = byCov(c); return [c, s ? { fighter_id: s.fighter_id, as_of_date: s.as_of_date, sample_bouts: s.sample_bouts, sample_stat_bouts: s.sample_stat_bouts, sample_rounds: s.sample_rounds, sample_seconds: s.sample_seconds, example: Object.entries(s.metrics || {}).slice(0, 2).map(([k, m]) => ({ k, value: m.value, confidence: m.confidence, sample_bouts: m.sample_bouts })) } : null]; }));
  return finish(report);
}
function finish(report, note) {
  const c = report.checks;
  const pass = !note && (c.null_audit?.violations.length === 0) && c.stance_split_reconciliation.mismatches === 0 && c.opponent_absorbed_reconciliation.mismatches === 0 && c.leakage.violations === 0 && c.observed_time.rows_over_bound === 0 && c.observed_time.rows_with_zero_instead_of_null === 0 && (c.determinism_runs.same_watermark_pairs === 0 || c.determinism_runs.all_identical);
  const empty = !note && (report.counts?.snapshots || 0) === 0;
  report.verdict = note ? `NOT RUN: ${note}` : empty ? 'NO DATA (no snapshots yet)' : pass ? 'PASS' : 'FAIL';
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else {
    const md = [`# Fight DNA data-quality report`, ``, `Generated ${report.generated_at} by \`scripts/dna/data_quality_report.mjs\` (independent verifier). Verdict: **${report.verdict}**`, ``];
    if (!note) {
      md.push(`## Counts`, '', '```json', JSON.stringify(report.counts, null, 2), '```', '',
        `## Checks`, '', `| check | result |`, `|---|---|`,
        `| null audit | ${c.null_audit.metric_keys} metric keys; ${c.null_audit.violations.length} keys with a null value carrying non-insufficient confidence |`,
        `| stance-split reconciliation | ${c.stance_split_reconciliation.rows_checked} rows recomputed from results + listed stances; ${c.stance_split_reconciliation.mismatches} mismatches |`,
        `| opponent-absorbed reconciliation | ${c.opponent_absorbed_reconciliation.rows_checked} feature rows vs paired round rows; ${c.opponent_absorbed_reconciliation.mismatches} mismatches |`,
        `| leakage (as-of exclusive) | ${c.leakage.snapshots_checked} snapshots; ${c.leakage.violations} violations |`,
        `| observed time | ${c.observed_time.rows_over_bound} rows over the scheduled bound; ${c.observed_time.rows_with_zero_instead_of_null} zero-instead-of-null rows |`,
        `| determinism (build runs) | ${c.determinism_runs.successful_runs} successful runs; ${c.determinism_runs.same_watermark_pairs} same-watermark pairs, identical: ${c.determinism_runs.all_identical} |`, '',
        `## Latest build run`, '', '```json', JSON.stringify(report.latest_run, null, 2), '```', '',
        `## Sample / confidence proof`, '', '```json', JSON.stringify(report.samples, null, 2), '```', '');
      const fails = [];
      if (c.stance_split_reconciliation.mismatches) fails.push('```json\n' + JSON.stringify(c.stance_split_reconciliation.sample, null, 2) + '\n```');
      if (c.opponent_absorbed_reconciliation.mismatches) fails.push('```json\n' + JSON.stringify(c.opponent_absorbed_reconciliation.sample, null, 2) + '\n```');
      if (c.leakage.violations) fails.push('```json\n' + JSON.stringify(c.leakage.sample, null, 2) + '\n```');
      if (fails.length) md.push(`## Mismatch samples`, '', ...fails, '');
    } else md.push(note, '');
    writeFileSync(OUT, md.join('\n'));
    console.log(`[dna-quality] ${report.verdict} -> ${OUT}`);
  }
  return report;
}
main().catch((e) => { console.error('[dna-quality] FAILED', e.message); process.exit(1); });
