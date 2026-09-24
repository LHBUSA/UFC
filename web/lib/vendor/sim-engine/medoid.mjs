// The official visible trajectory: the medoid of the modal outcome cell.
//
// Cell = (winner, method, ending round) for finishes, (winner, DEC) for
// decisions. The modal cell is the one most fights fall into. Its medoid is
// the real simulated fight whose per-round stats are closest (standardised L1)
// to the cell's per-round medians. A real path is always internally coherent;
// a stitched set of medians is not. Ties break on the lowest fight index, so
// the choice is a deterministic function of the batch.

import { NSTAT, STAT_KEYS } from './fight.mjs';
import { METHOD_NAMES } from './aggregate.mjs';

export function cellKey(winner, methodIdx, endRound) {
  if (winner === 0) return 'DRAW';
  return methodIdx < 2 ? `${winner}|${METHOD_NAMES[methodIdx]}|R${endRound}` : `${winner}|DEC`;
}

const METHOD_ORDER = { KO_TKO: 0, SUB: 1, DEC: 2 };
function parseKey(k) {
  if (k === 'DRAW') return { winner: 0, method: 'DRAW', round: 99 };
  const [w, m, r] = k.split('|');
  return { winner: Number(w), method: m, round: r ? Number(r.slice(1)) : 99 };
}

/**
 * Hierarchical selection, per the product brief: winner (given) -> method with the highest conditional
 * probability -> modal ending round within that method (decisions have no round) -> that cell.
 * Ties resolve KO < SUB < DEC, then the lower round. Returns the cell plus the full cell table for the receipt.
 */
export function modalCell(batch, requiredWinner) {
  const counts = new Map();
  const methodCounts = new Map();
  let total = 0;
  for (let i = 0; i < batch.filled; i++) {
    if (requiredWinner != null && batch.winner[i] !== requiredWinner) continue;
    total++;
    const k = cellKey(batch.winner[i], batch.method[i], batch.endRound[i]);
    counts.set(k, (counts.get(k) || 0) + 1);
    const m = parseKey(k).method;
    methodCounts.set(m, (methodCounts.get(m) || 0) + 1);
  }
  if (!total) return null;
  const methods = [...methodCounts.keys()].sort((a, b) => (methodCounts.get(b) - methodCounts.get(a)) || (METHOD_ORDER[a] - METHOD_ORDER[b]));
  const method = methods[0];
  const keys = [...counts.keys()].filter((k) => parseKey(k).method === method).sort((a, b) => {
    const d = counts.get(b) - counts.get(a);
    if (d) return d;
    return parseKey(a).round - parseKey(b).round;
  });
  const key = keys[0];
  const all = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  return {
    key, count: counts.get(key), ...parseKey(key), share: counts.get(key) / batch.filled,
    method_share: methodCounts.get(method) / batch.filled,
    method_conditional: methodCounts.get(method) / total,
    cells: all.map((k) => ({ key: k, count: counts.get(k) })),
  };
}

/** Medoid fight index within a cell (falls back to the (winner, method) cell when the modal cell is too small). */
export function medoidIndex(batch, cell, minCell = 300) {
  let members = [];
  for (let i = 0; i < batch.filled; i++) if (cellKey(batch.winner[i], batch.method[i], batch.endRound[i]) === cell.key) members.push(i);
  let fallback = null;
  if (members.length < minCell && cell.method !== 'DRAW') {
    const wide = [];
    for (let i = 0; i < batch.filled; i++) {
      const m = METHOD_NAMES[batch.method[i]];
      if (batch.winner[i] === cell.winner && (m === cell.method || (cell.method === 'DEC' && m === 'DEC'))) wide.push(i);
    }
    if (wide.length > members.length) { fallback = { reason: 'modal_cell_below_minimum', modal_cell_size: members.length, widened_to: `${cell.winner}|${cell.method}`, widened_size: wide.length }; members = wide; }
  }
  if (!members.length) return { index: null, members: 0, fallback };
  const R = batch.R;
  // Round coverage: use rounds every member reached fully, plus the ending round for finish cells (scaled stats).
  const dims = R * 2 * NSTAT + 1; // + end_time
  const vals = new Float64Array(members.length * dims);
  for (let k = 0; k < members.length; k++) {
    const i = members[k];
    for (let r = 0; r < R; r++) for (let side = 0; side < 2; side++) for (let q = 0; q < NSTAT; q++) vals[k * dims + (r * 2 + side) * NSTAT + q] = r < batch.endRound[i] ? batch.statAt(i, r, side, q) : NaN;
    vals[k * dims + dims - 1] = batch.endTime[i];
  }
  const med = new Float64Array(dims), scale = new Float64Array(dims);
  const col = new Float64Array(members.length);
  for (let d = 0; d < dims; d++) {
    let n = 0;
    for (let k = 0; k < members.length; k++) { const v = vals[k * dims + d]; if (!Number.isNaN(v)) col[n++] = v; }
    if (!n) { med[d] = NaN; scale[d] = 1; continue; }
    const sorted = Array.from(col.subarray(0, n)).sort((a, b) => a - b);
    med[d] = n % 2 ? sorted[n >> 1] : (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
    let mad = 0; for (let k = 0; k < n; k++) mad += Math.abs(sorted[k] - med[d]); mad /= n;
    scale[d] = mad > 0 ? mad : 1;
  }
  let best = -1, bestD = Infinity;
  for (let k = 0; k < members.length; k++) {
    let dist = 0;
    for (let d = 0; d < dims; d++) { const v = vals[k * dims + d]; if (Number.isNaN(v) || Number.isNaN(med[d])) continue; dist += Math.abs(v - med[d]) / scale[d]; }
    if (dist < bestD - 1e-12 || (Math.abs(dist - bestD) <= 1e-12 && members[k] < members[best])) { bestD = dist; best = k; }
  }
  return { index: members[best], members: members.length, distance: Math.round(bestD * 1e4) / 1e4, fallback };
}

/** Materialise a fight record from the batch for the artifact. */
export function extractFight(batch, i, names) {
  const rounds = [];
  for (let r = 0; r < batch.endRound[i]; r++) {
    const row = { round: r + 1, fighter_1: {}, fighter_2: {}, score: { fighter_1: batch.scoreAt(i, r, 0), fighter_2: batch.scoreAt(i, r, 1) } };
    for (let side = 0; side < 2; side++) {
      const t = side ? row.fighter_2 : row.fighter_1;
      for (let q = 0; q < NSTAT; q++) t[STAT_KEYS[q]] = batch.statAt(i, r, side, q);
    }
    rounds.push(row);
  }
  return { fight_index: i, winner: batch.winner[i], method: METHOD_NAMES[batch.method[i]], end_round: batch.endRound[i], end_time_sec: batch.endTime[i], rounds };
}
