#!/usr/bin/env node
// Prospective V2 research-shadow evaluation. READ-ONLY (GETs only).
//
//   node scripts/model/v2/shadow_report.mjs [--json out.json]
//
// Population: V2 shadow rows of the RESEARCH_SHADOW run that are locked (the
// paired universe: every V1 gate passed except, possibly, the 55% threshold)
// and whose bout has a decisive result. Each row froze V1's and V2's
// probabilities together at V1's lock pass, so the comparison is paired and
// prospective. Draws, no-contests and voids carry no binary label.
//
// The frozen promotion-research gate (docs/model/V2_RESEARCH.md section 9) is
// evaluated, never tuned: >= 150 paired graded bouts, paired dBrier < 0 with
// the upper event-cluster bootstrap bound < 0, V2 ECE <= 0.03, and no prior-bout
// bucket materially worse than V1 beyond uncertainty. Market is reported after,
// as a benchmark only. This script recommends nothing; promotion is owner-only.
import fs from 'node:fs';
import { rest } from '../common.mjs';

export const GATE = Object.freeze({ min_pairs: 150, max_ece: 0.03 });
const clip = (p) => Math.min(1 - 1e-12, Math.max(1e-12, p));
const brier = (rows, k) => rows.reduce((a, r) => a + (r[k] - r.y) ** 2, 0) / (rows.length || 1);
const logLoss = (rows, k) => rows.reduce((a, r) => a - (r.y ? Math.log(clip(r[k])) : Math.log(1 - clip(r[k]))), 0) / (rows.length || 1);
const hit = (rows, k) => rows.filter((r) => (r[k] >= 0.5) === (r.y === 1)).length / (rows.length || 1);

export function ece(rows, k, edges = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 1.0001]) {
  let e = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const g = rows.filter((r) => { const c = Math.max(r[k], 1 - r[k]); return c >= edges[i] && c < edges[i + 1]; });
    if (!g.length) continue;
    const conf = g.reduce((a, r) => a + Math.max(r[k], 1 - r[k]), 0) / g.length;
    const acc = g.filter((r) => (r[k] >= 0.5) === (r.y === 1)).length / g.length;
    e += (g.length / rows.length) * Math.abs(conf - acc);
  }
  return e;
}

/** Event-cluster paired bootstrap of mean(V2 - V1) for a per-row loss. Deterministic seed. */
export function bootstrap(rows, loss, B = 2000, seed = 11) {
  const byEv = new Map();
  for (const r of rows) { if (!byEv.has(r.event_id)) byEv.set(r.event_id, []); byEv.get(r.event_id).push(loss(r)); }
  const evs = [...byEv.values()];
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const draws = [];
  for (let b = 0; b < B; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < evs.length; i++) for (const v of evs[Math.floor(rnd() * evs.length)]) { sum += v; n += 1; }
    draws.push(sum / (n || 1));
  }
  draws.sort((a, b) => a - b);
  const mean = rows.reduce((a, r) => a + loss(r), 0) / (rows.length || 1);
  return { mean, ci95: [draws[Math.floor(0.025 * (B - 1))], draws[Math.floor(0.975 * (B - 1))]], events: evs.length };
}

const dBrier = (r) => (r.v2 - r.y) ** 2 - (r.v1 - r.y) ** 2;
const dLog = (r) => (r.y ? -Math.log(clip(r.v2)) + Math.log(clip(r.v1)) : -Math.log(1 - clip(r.v2)) + Math.log(1 - clip(r.v1)));
const bucket = (n) => (n <= 2 ? '1-2' : n <= 5 ? '3-5' : '6+');

/** Pure evaluation of paired rows: { v1, v2 (prob of fighter_a), y (fighter_a won), event_id, policy, market }. */
export function evaluate(rows) {
  const summary = (g) => ({
    n: g.length,
    v1: { brier: brier(g, 'v1'), log_loss: logLoss(g, 'v1'), hit_rate: hit(g, 'v1'), ece: ece(g, 'v1') },
    v2: { brier: brier(g, 'v2'), log_loss: logLoss(g, 'v2'), hit_rate: hit(g, 'v2'), ece: ece(g, 'v2') },
    d_brier: g.length ? bootstrap(g, dBrier) : null,
    d_log_loss: g.length ? bootstrap(g, dLog) : null,
  });
  const overall = summary(rows);
  const slices = {
    by_prior_bouts: Object.fromEntries(['1-2', '3-5', '6+'].map((k) => [k, summary(rows.filter((r) => bucket(r.policy.sample.min_prior_bouts) === k))])),
    five_round_non_title: summary(rows.filter((r) => r.policy.context.five_round_non_title)),
  };
  /* Product question: what each frozen policy would have published, and how those calls did. */
  const pickHit = (r, side) => ((side === 'v1' ? r.v1 : r.v2) >= 0.5) === (r.y === 1);
  const pol = (name, side, pred) => {
    const pub = rows.filter(pred);
    const hits = pub.filter((r) => pickHit(r, side)).length;
    return { policy: name, model: side, published: pub.length, coverage: pub.length / (rows.length || 1), hits, hit_rate: pub.length ? hits / pub.length : null };
  };
  const policies = [
    pol('V1 current >=55% (official)', 'v1', (r) => r.policy.v1.publish_v1_rule),
    pol('V2 >=55%', 'v2', (r) => r.policy.v2.publish_v1_rule_55),
    pol('V2 >=60% (frozen primary)', 'v2', (r) => r.policy.v2.publish_primary_60),
    pol('V2 tier variant (pre-registered research only)', 'v2', (r) => r.policy.v2.publish_variant_tiers),
  ];
  const bucketsWorse = Object.entries(slices.by_prior_bouts).filter(([, s]) => s.n >= 20 && s.d_brier && s.d_brier.ci95[0] > 0).map(([k]) => k);
  const gate = {
    pairs: { required: GATE.min_pairs, have: rows.length, pass: rows.length >= GATE.min_pairs },
    d_brier_negative: { value: overall.d_brier?.mean ?? null, pass: (overall.d_brier?.mean ?? 0) < 0 },
    upper_ci_negative: { value: overall.d_brier?.ci95[1] ?? null, pass: (overall.d_brier?.ci95[1] ?? 0) < 0 },
    ece: { value: overall.v2.ece, max: GATE.max_ece, pass: overall.v2.ece <= GATE.max_ece },
    no_bucket_materially_worse: { worse: bucketsWorse, pass: bucketsWorse.length === 0 },
  };
  const all = Object.values(gate).every((g) => g.pass);
  /* Benchmark only, after the fact: lock-time market where the stored comparison was FRESH. */
  const mk = rows.filter((r) => r.market?.status === 'FRESH' && r.market.devigged_pick != null && r.market.pick_fighter_id);
  const market = mk.length ? { n: mk.length, v1_brier: brier(mk, 'v1'), v2_brier: brier(mk, 'v2'), market_brier: brier(mk.map((r) => ({ ...r, m: r.market.pick_fighter_id === r.fighter_a_id ? r.market.devigged_pick : 1 - r.market.devigged_pick })), 'm') } : { n: 0 };
  return { overall, slices, policies, gate, verdict: rows.length < GATE.min_pairs ? `INSUFFICIENT EVIDENCE (${rows.length}/${GATE.min_pairs} paired graded bouts)` : all ? 'GATE MET - owner review only; nothing promotes automatically' : 'GATE NOT MET', market_benchmark: market };
}

async function main() {
  const db = rest();
  const get = async (p) => (await db.selectAll(p.split('?')[0], `?${p.split('?')[1]}`, { limit: 1000 }));
  const [run] = await get('ufc_model_training_runs?select=id,spec_sha256,created_at&status=eq.RESEARCH_SHADOW&order=created_at.asc');
  if (!run) throw new Error('no RESEARCH_SHADOW run registered');
  const rows = await get(`ufc_model_shadow_predictions?select=id,bout_id,event_id,fighter_a_id,fighter_b_id,locked_at,generated_at,decision,policy,market&training_run_id=eq.${run.id}&order=id.asc`);
  const locked = rows.filter((r) => r.locked_at && r.decision === 'ELIGIBLE' && r.policy?.evaluable);
  const results = new Map();
  for (let i = 0; i < locked.length; i += 100) {
    const ids = locked.slice(i, i + 100).map((r) => r.bout_id).join(',');
    for (const r of await get(`ufc_bout_results?select=bout_id,winner_id,method&bout_id=in.(${ids})&order=bout_id.asc`)) results.set(r.bout_id, r);
  }
  const paired = [];
  for (const r of locked) {
    const res = results.get(r.bout_id);
    /* Decisive results only; a winner that is neither corner is an identity problem and is skipped, never guessed. */
    if (!res?.winner_id || (res.winner_id !== r.fighter_a_id && res.winner_id !== r.fighter_b_id)) continue;
    paired.push({ event_id: r.event_id, fighter_a_id: r.fighter_a_id, v1: Number(r.policy.v1.prob_a), v2: Number(r.policy.v2.prob_a), y: res.winner_id === r.fighter_a_id ? 1 : 0, policy: r.policy, market: r.market });
  }
  const report = {
    generated_at: new Date().toISOString(), training_run_id: run.id, spec_sha256: run.spec_sha256,
    shadow_rows: rows.length, locked_paired_universe: locked.length,
    first_shadow_generated_at: rows.map((r) => r.generated_at).sort()[0] ?? null,
    first_lock_at: locked.map((r) => r.locked_at).sort()[0] ?? null,
    graded_pairs: paired.length,
    ...evaluate(paired),
  };
  const out = process.argv.indexOf('--json');
  if (out >= 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, overall: report.overall.n ? report.overall : '(no graded pairs yet)', slices: report.graded_pairs ? report.slices : '(no graded pairs yet)' }, null, 1));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main().catch((e) => { console.error(e.message); process.exit(1); });
