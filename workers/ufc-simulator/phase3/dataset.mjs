// Phase 3 dataset: cohort definition, strictly as-of bout inputs, truth, and
// per-round observations for the component fitter. Reads only the local
// extract (phase3/extract.mjs) and the locally regenerated champion
// walk-forward predictions (.cache/model/backtest_predictions.jsonl).
//
// As-of rule for a bout on date D: every fact must carry a date < D. The
// snapshot is the latest with as_of_date <= D that passes the exclusive-cutoff
// validation (the extract already replaced the 8 contaminated rows); ladder
// rows are event_date < D; the anchor is the champion's out-of-sample fold
// prediction for that bout. The target bout id never appears in the inputs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFromSnapshot, validateSnapshotAsOf } from '../src/engine/inputs.mjs';
import { sideFromProfile } from '../src/engine/fight.mjs';
import { COMPONENTS } from '../src/engine/models.mjs';
import { canonicalOrder } from '../src/engine/fingerprint.mjs';
import { DEFAULT_PARAMS } from '../src/engine/params.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = process.env.SIM_PHASE3_CACHE || path.join(ROOT, '.cache', 'phase3');
const CHAMPION = process.env.PBE_MODEL_CACHE ? path.join(process.env.PBE_MODEL_CACHE, 'backtest_predictions.jsonl') : path.resolve(ROOT, '..', '..', '.cache', 'model', 'backtest_predictions.jsonl');

const load = (name) => JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'));
export const METHOD_OK = new Set(['KO_TKO', 'SUB', 'DEC_U', 'DEC_S', 'DEC_M']);
export const methodClass = (m) => (m === 'KO_TKO' ? 'KO_TKO' : m === 'SUB' ? 'SUB' : /^DEC_/.test(m) ? 'DEC' : m);

let TABLES = null;
export function loadTables() {
  if (TABLES) return TABLES;
  const events = new Map(load('events.json').map((e) => [e.id, e]));
  const bouts = load('bouts.json');
  const results = new Map(load('results.json').map((r) => [r.bout_id, r]));
  const fighters = new Map(load('fighters.json').map((f) => [f.id, f]));
  const roundStats = new Map();
  for (const r of load('round_stats.json')) { if (!roundStats.has(r.bout_id)) roundStats.set(r.bout_id, []); roundStats.get(r.bout_id).push(r); }
  const ladderOf = new Map();
  for (const r of load('bout_features.json')) { if (!ladderOf.has(r.fighter_id)) ladderOf.set(r.fighter_id, []); ladderOf.get(r.fighter_id).push({ bout_id: r.bout_id, event_date: r.event_date, opponent_id: r.opponent_id, outcome: r.outcome, stats_coverage: r.stats_coverage, raw_stats: { opp_totals: r.opp_totals, totals: r.totals } }); }
  for (const arr of ladderOf.values()) arr.sort((a, b) => a.event_date.localeCompare(b.event_date) || a.bout_id.localeCompare(b.bout_id));
  const resolution = new Map();
  for (const w of load('resolution.json')) resolution.set(`${w.bout_id}|${w.fid}`, w);
  const snapshots = load('snapshots_resolved.json');
  const boutDate = new Map(bouts.map((b) => [b.id, events.get(b.event_id)?.event_date || null]));
  const champion = new Map();
  if (fs.existsSync(CHAMPION)) for (const line of fs.readFileSync(CHAMPION, 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; const r = JSON.parse(line); champion.set(r.bout_id, r); }
  TABLES = { events, bouts, results, fighters, roundStats, ladderOf, resolution, snapshots, boutDate, champion };
  return TABLES;
}

/** Cohort with exclusion accounting. */
export function buildCohort() {
  const T = loadTables();
  const excluded = {};
  const ex = (reason) => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const cohort = [];
  for (const b of T.bouts) {
    const D = T.boutDate.get(b.id);
    if (!D || D < '2015-01-01' || b.status !== 'complete' || !b.model_scope) continue;
    const res = T.results.get(b.id);
    if (!res) { ex('no_result'); continue; }
    if (!METHOD_OK.has(res.method)) { ex(`method_${res.method}`); continue; }
    if (!(b.scheduled_rounds === 3 || b.scheduled_rounds === 5)) { ex('scheduled_rounds_not_3_or_5'); continue; }
    if (res.time_format && !/^(3|5) Rnd \((5-)+5\)$/.test(res.time_format)) { ex('nonstandard_time_format'); continue; }
    if (!(res.round >= 1 && res.round <= b.scheduled_rounds)) { ex('bad_end_round'); continue; }
    if (!res.winner_id || (res.winner_id !== b.fighter_a_id && res.winner_id !== b.fighter_b_id)) { ex('winner_not_a_corner'); continue; }
    const rows = T.roundStats.get(b.id) || [];
    let complete = true;
    for (let r = 1; r <= res.round; r++) for (const fid of [b.fighter_a_id, b.fighter_b_id]) if (!rows.some((x) => x.fighter_id === fid && x.round === r)) complete = false;
    if (!complete) { ex('round_stats_incomplete'); continue; }
    const ch = T.champion.get(b.id);
    if (!ch) { ex('no_champion_walkforward_prediction'); continue; }
    const ra = T.resolution.get(`${b.id}|${b.fighter_a_id}`), rb = T.resolution.get(`${b.id}|${b.fighter_b_id}`);
    if (!ra?.as_of || !rb?.as_of) { ex('corner_without_snapshot_debut'); continue; }
    // Trust over availability: a snapshot whose provenance lists a bout we can no longer date (removed or merged since) cannot be proven as-of.
    let unverifiable = false;
    for (const w of [ra, rb]) { const s = T.snapshots[`${w.fid}|${w.as_of}`]; for (const bid of s?.provenance?.bouts || []) if (!T.boutDate.get(bid)) unverifiable = true; }
    if (unverifiable) { ex('snapshot_provenance_unverifiable'); continue; }
    const ev = T.events.get(b.event_id);
    cohort.push({ bout_id: b.id, event_date: D, year: Number(D.slice(0, 4)), event_series: ev.event_series, event_name: ev.name, fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id, weight_class: b.weight_class, is_womens: b.is_womens, is_title: b.is_title, scheduled_rounds: b.scheduled_rounds, method: methodClass(res.method), method_raw: res.method, end_round: res.round, end_time: res.time_sec, winner_id: res.winner_id, fold_year: ch.fold_year });
  }
  cohort.sort((a, b) => a.event_date.localeCompare(b.event_date) || a.bout_id.localeCompare(b.bout_id));
  return { cohort, excluded };
}

/** Strictly as-of engine input for one cohort bout. `truncateAt` (a date) additionally drops every raw row dated >= that date before building (leakage truncation test). */
export function boutInput(c, { truncateAt = null } = {}) {
  const T = loadTables();
  const D = c.event_date;
  const cut = truncateAt || D;
  const corner = (fid) => {
    const w = T.resolution.get(`${c.bout_id}|${fid}`);
    let snap = w?.as_of ? T.snapshots[`${fid}|${w.as_of}`] : null;
    if (snap && truncateAt && snap.as_of_date > truncateAt) snap = null;
    const ladder = (T.ladderOf.get(fid) || []).filter((r) => r.event_date < cut && r.event_date < D);
    const boutDates = {};
    for (const bid of snap?.provenance?.bouts || []) { const d = T.boutDate.get(bid); if (d) boutDates[bid] = d; }
    const f = T.fighters.get(fid);
    return { fighter: { id: f.id, name: f.name, dob: f.dob, height_in: f.height_in, reach_in: f.reach_in, stance: f.stance }, snapshot: snap, ladder, bout_dates: boutDates };
  };
  const a = corner(c.fighter_a_id), b = corner(c.fighter_b_id);
  const ch = T.champion.get(c.bout_id);
  const anchor = { model_version: 'pbe-fight-model-v1', model_spec_sha256: `walkforward-fold-${ch.fold_year}`, prob: ch.p, prob_for: ch.fighter_1_id, source: 'ufc walk-forward backtest (local regeneration, fold trained on years < fold_year)' };
  return { fighter_a: a, fighter_b: b, anchor, settings: { scheduled_rounds: c.scheduled_rounds, weight_class: c.weight_class, is_title: c.is_title, is_womens: c.is_womens } };
}

/** Truth in canonical corner order (fighter_1 = smaller UUID). */
export function boutTruth(c) {
  const T = loadTables();
  const [f1, f2] = canonicalOrder(c.fighter_a_id, c.fighter_b_id);
  const rows = T.roundStats.get(c.bout_id) || [];
  const rounds = [];
  for (let r = 1; r <= c.end_round; r++) {
    const pick = (fid) => rows.find((x) => x.fighter_id === fid && x.round === r);
    const m = (x) => ({ sig_l: x.sig_str_landed, sig_a: x.sig_str_att, head_l: x.head_landed, body_l: x.body_landed, leg_l: x.leg_landed, dist_l: x.distance_landed, clinch_l: x.clinch_landed, ground_l: x.ground_landed, td_l: x.td_landed, td_a: x.td_att, ctrl: x.ctrl_sec ?? 0, kd: x.kd, sub: x.sub_att });
    rounds.push({ round: r, seconds: r < c.end_round ? 300 : c.end_time, fighter_1: m(pick(f1)), fighter_2: m(pick(f2)), ending: r === c.end_round });
  }
  const res = T.results.get(c.bout_id);
  // Clean-sweep round-winner truth: every card 30-27 / 50-45 for the same fighter.
  let sweepWinner = null;
  if (c.method === 'DEC' && Array.isArray(res.scorecards) && res.scorecards.length >= 3) {
    const parsed = res.scorecards.map((sc) => String(sc.score || '').match(/^(\d+)-(\d+)$/)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
    const hi = 10 * c.scheduled_rounds, lo = 9 * c.scheduled_rounds;
    if (parsed.length >= 3 && parsed.every(([x, y]) => Math.max(x, y) === hi && Math.min(x, y) === lo) && parsed.every(([x, y]) => (x > y) === (parsed[0][0] > parsed[0][1]))) sweepWinner = c.winner_id;
  }
  return { fighter_1_id: f1, fighter_2_id: f2, winner: c.winner_id === f1 ? 1 : 2, method: c.method, end_round: c.end_round, end_time: c.end_time, rounds, sweep_winner: sweepWinner ? (sweepWinner === f1 ? 1 : 2) : null };
}

/** Per-round observations for the component fitter, computed with the SAME feature functions the engine uses. */
export function roundObservations(c, params = DEFAULT_PARAMS) {
  const input = boutInput(c);
  const truth = boutTruth(c);
  const in1 = input.fighter_a.fighter.id === truth.fighter_1_id ? input.fighter_a : input.fighter_b;
  const in2 = in1 === input.fighter_a ? input.fighter_b : input.fighter_a;
  const p1 = profileFromSnapshot(in1, params), p2 = profileFromSnapshot(in2, params);
  const sides = [sideFromProfile(p1, params), sideFromProfile(p2, params)];
  const state = [{ absorbed: 0, kdTaken: 0 }, { absorbed: 0, kdTaken: 0 }];
  const obs = [];
  for (const rd of truth.rounds) {
    const L = rd.seconds;
    for (let i = 0; i < 2; i++) {
      const j = 1 - i;
      const me = i === 0 ? rd.fighter_1 : rd.fighter_2;
      const v = { td_l: me.td_l, td_a: me.td_a, ctrl: me.ctrl, head_l: me.head_l, kd: me.kd, sub: me.sub, landed: me.sig_l };
      const x = {};
      for (const [name, comp] of Object.entries(COMPONENTS)) x[name] = comp.x(sides[i], sides[j], state[i], state[j], rd.round, v, L);
      const endedByMe = rd.ending && truth.winner === i + 1;
      obs.push({
        bout_id: c.bout_id, year: c.year, side: i + 1, round: rd.round, L,
        x,
        y: { att: me.sig_a, acc: [me.sig_l, me.sig_a], td_att: me.td_a, td_acc: [me.td_l, me.td_a], ctrl_any: me.ctrl > 0 ? 1 : 0, ctrl_len: me.ctrl, kd: me.kd, sub: me.sub, ko_haz: endedByMe && truth.method === 'KO_TKO' ? 1 : 0, sub_haz: endedByMe && truth.method === 'SUB' ? 1 : 0 },
      });
    }
    state[0].absorbed += rd.fighter_2.sig_l; state[1].absorbed += rd.fighter_1.sig_l;
    state[0].kdTaken += rd.fighter_2.kd; state[1].kdTaken += rd.fighter_1.kd;
  }
  return { obs, truth, profiles: [p1, p2] };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('phase3/dataset.mjs')) {
  const { cohort, excluded } = buildCohort();
  const byYear = {}; const bySeries = {}; const byRounds = {}; const byMethod = {};
  for (const c of cohort) { byYear[c.year] = (byYear[c.year] || 0) + 1; bySeries[c.event_series] = (bySeries[c.event_series] || 0) + 1; byRounds[c.scheduled_rounds] = (byRounds[c.scheduled_rounds] || 0) + 1; byMethod[c.method] = (byMethod[c.method] || 0) + 1; }
  const summary = { cohort: cohort.length, excluded, by_year: byYear, by_series: bySeries, by_scheduled_rounds: byRounds, by_method: byMethod };
  fs.writeFileSync(path.join(CACHE, 'cohort.json'), JSON.stringify({ summary, bouts: cohort }));
  console.log(JSON.stringify(summary, null, 1));
}
