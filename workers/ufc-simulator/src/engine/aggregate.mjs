// Accumulates a batch of simulated fights into the distribution the product
// shows, and keeps every fight's compact record so the medoid selector can
// pick a real path.

import { NSTAT, STAT, METHOD } from './fight.mjs';
import { round4, int } from './canonical.mjs';

export class Batch {
  constructor(nSims, R) {
    this.n = nSims; this.R = R;
    this.stats = new Int16Array(nSims * R * 2 * NSTAT);
    this.scores = new Uint8Array(nSims * R * 2);
    this.winner = new Uint8Array(nSims);
    this.method = new Uint8Array(nSims); // 0 KO, 1 SUB, 2 DEC, 3 DRAW
    this.endRound = new Uint8Array(nSims);
    this.endTime = new Uint16Array(nSims);
    this.filled = 0;
  }
  push(i, f) {
    const stride = this.R * 2 * NSTAT;
    this.stats.set(f.stats, i * stride);
    this.scores.set(f.scores, i * this.R * 2);
    this.winner[i] = f.winner;
    this.method[i] = f.method === METHOD.KO ? 0 : f.method === METHOD.SUB ? 1 : f.method === METHOD.DEC ? 2 : 3;
    this.endRound[i] = f.end_round;
    this.endTime[i] = f.end_time;
    this.filled = Math.max(this.filled, i + 1);
  }
  statAt(i, r, side, q) { return this.stats[((i * this.R + r) * 2 + side) * NSTAT + q]; }
  scoreAt(i, r, side) { return this.scores[(i * this.R + r) * 2 + side]; }
  /** Share of fights corner 1 wins, draws counted as half. */
  p1() {
    let w = 0, d = 0;
    for (let i = 0; i < this.filled; i++) { if (this.winner[i] === 1) w++; else if (this.winner[i] === 0) d++; }
    return (w + 0.5 * d) / this.filled;
  }
}

export const METHOD_NAMES = ['KO_TKO', 'SUB', 'DEC', 'DRAW'];

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Distribution summary of a filled batch. Every number is rounded here so the artifact hash is stable. */
export function summarize(batch) {
  const n = batch.filled, R = batch.R;
  const counts = { w1: 0, w2: 0, draw: 0, dist: 0 };
  const methods = { f1_ko: 0, f1_sub: 0, f1_dec: 0, f2_ko: 0, f2_sub: 0, f2_dec: 0 };
  const finishRounds = Array.from({ length: R }, () => ({ f1: 0, f2: 0 }));
  const endTimes = [];
  for (let i = 0; i < n; i++) {
    const w = batch.winner[i], m = batch.method[i];
    if (w === 1) counts.w1++; else if (w === 2) counts.w2++; else counts.draw++;
    if (m >= 2) counts.dist++;
    if (w && m < 2) { finishRounds[batch.endRound[i] - 1][w === 1 ? 'f1' : 'f2']++; endTimes.push((batch.endRound[i] - 1) * 300 + batch.endTime[i]); }
    if (w === 1) methods[m === 0 ? 'f1_ko' : m === 1 ? 'f1_sub' : 'f1_dec']++;
    else if (w === 2) methods[m === 0 ? 'f2_ko' : m === 1 ? 'f2_sub' : 'f2_dec']++;
  }
  // Fight totals per fighter for medians (sum over rounds fought).
  const totalsBy = { f1: { sig_l: [], sig_a: [], td_l: [], ctrl: [], kd: [], sub: [] }, f2: { sig_l: [], sig_a: [], td_l: [], ctrl: [], kd: [], sub: [] } };
  const keys = ['sig_l', 'sig_a', 'td_l', 'ctrl', 'kd', 'sub'];
  for (let i = 0; i < n; i++) {
    for (let side = 0; side < 2; side++) {
      const acc = Object.fromEntries(keys.map((k) => [k, 0]));
      for (let r = 0; r < batch.endRound[i]; r++) for (const k of keys) acc[k] += batch.statAt(i, r, side, STAT[k]);
      const t = side === 0 ? totalsBy.f1 : totalsBy.f2;
      for (const k of keys) t[k].push(acc[k]);
    }
  }
  const med = (arr) => median(arr.slice().sort((a, b) => a - b));
  const q = (arr, p) => quantile(arr.slice().sort((a, b) => a - b), p);
  const perRound = [];
  for (let r = 0; r < R; r++) {
    const row = { round: r + 1, fights_reaching: 0, f1: {}, f2: {} };
    const cols = { f1: { sig_l: [], sig_a: [], td_l: [], ctrl: [], kd: [] }, f2: { sig_l: [], sig_a: [], td_l: [], ctrl: [], kd: [] } };
    let f1Rounds = 0, f2Rounds = 0, drawRounds = 0;
    for (let i = 0; i < n; i++) {
      if (batch.endRound[i] < r + 1) continue;
      if (batch.endRound[i] === r + 1 && batch.method[i] < 2) continue; // partial ending rounds excluded from full-round medians
      row.fights_reaching++;
      for (let side = 0; side < 2; side++) { const c = side ? cols.f2 : cols.f1; for (const k of Object.keys(c)) c[k].push(batch.statAt(i, r, side, STAT[k])); }
      const s1 = batch.scoreAt(i, r, 0), s2 = batch.scoreAt(i, r, 1);
      if (s1 > s2) f1Rounds++; else if (s2 > s1) f2Rounds++; else drawRounds++;
    }
    for (const side of ['f1', 'f2']) for (const k of Object.keys(cols[side])) row[side][k] = { median: int(med(cols[side][k])), p25: int(q(cols[side][k], 0.25)), p75: int(q(cols[side][k], 0.75)) };
    row.round_win = row.fights_reaching ? { f1: round4(f1Rounds / row.fights_reaching), f2: round4(f2Rounds / row.fights_reaching), even: round4(drawRounds / row.fights_reaching) } : null;
    perRound.push(row);
  }
  const sortedEnd = endTimes.sort((a, b) => a - b);
  return {
    n_sims: n,
    probabilities: { fighter_1_win: round4(counts.w1 / n), fighter_2_win: round4(counts.w2 / n), draw: round4(counts.draw / n), goes_distance: round4(counts.dist / n) },
    methods: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k.replace('f1_', 'fighter_1_').replace('f2_', 'fighter_2_'), round4(v / n)])),
    finish_distribution: finishRounds.map((fr, i) => ({ round: i + 1, fighter_1: round4(fr.f1 / n), fighter_2: round4(fr.f2 / n), any: round4((fr.f1 + fr.f2) / n) })),
    finish_time: sortedEnd.length ? { median_elapsed_sec: int(median(sortedEnd)), p25_elapsed_sec: int(quantile(sortedEnd, 0.25)), p75_elapsed_sec: int(quantile(sortedEnd, 0.75)), finishes: sortedEnd.length } : null,
    fight_totals: {
      fighter_1: Object.fromEntries(keys.map((k) => [k, { median: int(med(totalsBy.f1[k])), p25: int(q(totalsBy.f1[k], 0.25)), p75: int(q(totalsBy.f1[k], 0.75)) }])),
      fighter_2: Object.fromEntries(keys.map((k) => [k, { median: int(med(totalsBy.f2[k])), p25: int(q(totalsBy.f2[k], 0.25)), p75: int(q(totalsBy.f2[k], 0.75)) }])),
    },
    per_round: perRound,
  };
}
