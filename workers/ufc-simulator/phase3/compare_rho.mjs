// Phase 3B gate: frozen v1.0-rc1 engine vs the same engine with fight-level persistence, bout for bout, walk-forward.
//   node phase3/compare_rho.mjs [--rho 0.7] [--n 2000]
// Metric definitions are the Phase 3 report's (report.mjs): winner Brier on fighter_1_win / (1 - draw), method log loss
// over {KO_TKO, SUB, DEC(+draw)}, goes-distance Brier. Draw is reported as the mean predicted share, by format.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE } from './dataset.mjs';
import { brier, mean, r4, multiLogLoss, groupBy, quantiles } from './metrics.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RHO = opt('--rho', '0.7'), N = opt('--n', '2000');
const read = (f) => fs.readFileSync(path.join(CACHE, f), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const base = new Map(read(`eval_fold_n${N}.jsonl`).map((r) => [r.bout_id, r]));
const cand = read(`eval_fold_rho${RHO}_n${N}.jsonl`);
const pairs = cand.filter((r) => base.has(r.bout_id) && r.probabilities && base.get(r.bout_id).probabilities).map((r) => [base.get(r.bout_id), r]);

const methodProbs = (r) => { const m = r.methods; const p = { KO_TKO: m.fighter_1_ko + m.fighter_2_ko, SUB: m.fighter_1_sub + m.fighter_2_sub, DEC: m.fighter_1_dec + m.fighter_2_dec + (r.probabilities.draw || 0) }; const s = p.KO_TKO + p.SUB + p.DEC; for (const k of Object.keys(p)) p[k] /= s || 1; return p; };
const winP = (r) => r.probabilities.fighter_1_win / (1 - (r.probabilities.draw || 0));
function block(rs) {
  return {
    n: rs.length,
    winner_brier: r4(mean(rs.map((r) => brier(winP(r), r.truth.winner === 1 ? 1 : 0)))),
    method_logloss: r4(mean(rs.map((r) => multiLogLoss(methodProbs(r), r.truth.method)))),
    distance_brier: r4(mean(rs.map((r) => brier(r.probabilities.goes_distance, r.truth.method === 'DEC' ? 1 : 0)))),
    mean_draw_pct: r4(mean(rs.map((r) => r.probabilities.draw || 0)) * 100),
    mean_distance_pct: r4(mean(rs.map((r) => r.probabilities.goes_distance)) * 100),
    tilt_median: rs.some((r) => r.anchor) ? r4(quantiles(rs.filter((r) => r.anchor).map((r) => Math.abs(r.anchor.tilt))).p50) : null,
    over_max_pct: rs.some((r) => r.anchor) ? r4(rs.filter((r) => r.anchor && r.anchor.status !== 'ok').length / rs.filter((r) => r.anchor).length * 100) : null,
  };
}
const side = (sel) => { const b = block(pairs.map((p) => p[0]).filter(sel)), c = block(pairs.map((p) => p[1]).filter(sel)); return { b, c }; };
const line = (label, { b, c }) => [label, b.n, b.winner_brier, c.winner_brier, b.method_logloss, c.method_logloss, b.distance_brier, c.distance_brier, b.mean_draw_pct, c.mean_draw_pct, b.tilt_median, c.tilt_median, b.over_max_pct, c.over_max_pct];
const rows = [line('all', side(() => true))];
for (const R of [3, 5]) rows.push(line(`${R} rounds`, side((r) => (r.scheduled_rounds === 5 ? 5 : 3) === R)));
for (const y of [...new Set(pairs.map((p) => p[0].year))].sort()) rows.push(line(`fold ${y}`, side((r) => r.year === y)));
for (const g of ['FULL', 'LIMITED']) rows.push(line(g, side((r) => r.gate === g)));
const hdr = ['slice', 'n', 'winBrier base', 'winBrier ρ', 'methodLL base', 'methodLL ρ', 'distBrier base', 'distBrier ρ', 'draw% base', 'draw% ρ', 'tilt med base', 'tilt med ρ', 'over-max% base', 'over-max% ρ'];
console.log(`paired bouts: ${pairs.length} (candidate rows ${cand.length}); rho ${RHO}; n_sims ${N}`);
console.log(hdr.join(' | ')); for (const r of rows) console.log(r.join(' | '));
// Determinism of the candidate: identical simulation ids for identical inputs are checked by the engine tests; here, paired coverage.
const all = side(() => true);
const gates = {
  winner_brier_no_degradation: all.c.winner_brier <= all.b.winner_brier + 0.0005,
  method_logloss_no_material_degradation: all.c.method_logloss <= all.b.method_logloss + 0.002,
  distance_brier_no_material_degradation: all.c.distance_brier <= all.b.distance_brier + 0.001,
};
console.log('gates', JSON.stringify(gates));
fs.writeFileSync(path.join(CACHE, `compare_rho${RHO}_n${N}.json`), JSON.stringify({ rho: Number(RHO), n_sims: Number(N), paired: pairs.length, header: hdr, rows, gates }, null, 1));
