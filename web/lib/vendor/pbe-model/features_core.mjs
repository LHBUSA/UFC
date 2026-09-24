// PBE Fight Model v1 - pure feature core.
//
// The per-corner side builder and the antisymmetric vector, moved verbatim out
// of build_features.mjs so that the batch builder (backtest, training) and the
// production scheduler (Cloudflare Worker, one card at a time) run the SAME
// functions. No Node imports: this file must bundle into a Worker.
//
// assembleBoutRow() is the targeted, per-bout equivalent of the whole-history
// date-block walk in buildFromTables(). Its parity with that walk is proven by
// scripts/model/features_parity.test.mjs over every upcoming bout and a
// deterministic sample of historical ones.

import { FEATURE_KEYS } from './feature_spec.mjs';

/* Columns read from ufc_fighter_dna_snapshots (definition_version 1), identical for the batch extract and the scheduler. */
export const SNAPSHOT_METRICS = [
  'sig_landed_per_min', 'sig_absorbed_per_min', 'sig_diff_per_min', 'sig_accuracy', 'sig_defense',
  'knockdowns_per_15', 'knockdowns_absorbed_per_15',
  'td_attempts_per_15', 'td_landed_per_15', 'td_accuracy', 'control_share', 'control_seconds_per_td',
  'sub_attempts_per_15', 'reversals_per_15',
  'head_attack_share', 'body_attack_share', 'leg_attack_share',
  'distance_attack_share', 'clinch_attack_share', 'ground_attack_share',
  'finish_rate', 'ko_finish_rate', 'submission_finish_rate', 'finish_time_median_sec',
  'pace_retention_r2_vs_r1', 'pace_retention_r3_vs_r1', 'championship_round_delta', 'defensive_drift_r3_vs_r1',
];

export const SNAPSHOT_SELECT = [
  'fighter_id', 'as_of_date', 'definition_version',
  'sample_bouts', 'sample_completed_bouts', 'sample_stat_bouts', 'sample_rounds', 'sample_seconds',
  'coverage_status',
  ...SNAPSHOT_METRICS.map((k) => `m_${k}:metrics->${k}->>value`),
  'record:provenance->record',
  'included_bouts:provenance->bouts',
  'finished_by:finish_profile->finished_by',
  'five_round_apps:context_splits->five_round->record->>appearances',
  'title_apps:context_splits->title->record->>appearances',
  'main_event_apps:context_splits->main_event->record->>appearances',
].join(',');

export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const round = (v, p = 6) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);

const log1p = Math.log1p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Difference of two possibly-null quantities. Null on either side is no
 *  evidence either way, which under an antisymmetric no-intercept model is
 *  exactly a zero. Availability is tracked separately so that "we know nothing"
 *  is never mistaken for "the two corners are equal". */
export function diff(a, b) {
  if (a == null || b == null) return { v: 0, ok: false };
  const d = a - b;
  return { v: Number.isFinite(d) ? d : 0, ok: Number.isFinite(d) };
}

/** Latest element of a date-sorted array whose as_of_date is <= cutoff. */
export function latestAsOf(sorted, cutoff) {
  let lo = 0, hi = sorted.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].as_of_date <= cutoff) { best = sorted[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const smoothedWinRate = (w, apps) => (w + 1) / (apps + 2);

export function buildSide(fighter, snap, hist, eventDate) {
  const rec = snap?.record || null;
  const apps = rec ? num(rec.appearances) ?? 0 : 0;
  const wins = rec ? num(rec.w) ?? 0 : 0;
  const finishedBy = snap?.finished_by || null;
  const m = (k) => (snap ? num(snap[`m_${k}`]) : null);

  // Recent form from the bout-row ladder.
  const last5 = hist.results.slice(-5);
  const score = (o) => (o === 'W' ? 1 : o === 'L' ? 0 : 0.5);
  const recent5 = last5.length ? last5.reduce((a, r) => a + score(r.outcome), 0) / last5.length : null;

  let streak = 0;
  for (let i = hist.results.length - 1; i >= 0; i--) {
    const o = hist.results[i].outcome;
    if (o === 'W') { if (streak < 0) break; streak += 1; }
    else if (o === 'L') { if (streak > 0) break; streak -= 1; }
    else break;
    if (Math.abs(streak) >= 5) break;
  }

  const lastDate = hist.results.length ? hist.results[hist.results.length - 1].date : null;
  const layoffDays = lastDate ? Math.max(0, daysBetween(lastDate, eventDate)) : null;

  const tdDef = hist.oppTdAtt > 0 ? 1 - hist.oppTdLanded / hist.oppTdAtt : null;

  const withOppWr = hist.results.filter((r) => r.oppWinRate != null);
  const sos = withOppWr.length ? withOppWr.reduce((a, r) => a + r.oppWinRate, 0) / withOppWr.length : null;
  const qualityWins = hist.results.filter((r) => r.outcome === 'W' && r.oppWinRate != null && r.oppWinRate >= 0.6).length;

  return {
    fighter_id: fighter?.id ?? null,
    has_snapshot: Boolean(snap),
    snapshot_as_of: snap?.as_of_date ?? null,
    prior_bouts: apps,
    prior_wins: wins,
    stat_bouts: snap ? num(snap.sample_stat_bouts) ?? 0 : 0,
    coverage_status: snap?.coverage_status ?? 'insufficient',
    ladder_bouts: hist.results.length,

    age_years: fighter?.dob ? round(daysBetween(fighter.dob, eventDate) / 365.2425, 3) : null,
    reach_in: num(fighter?.reach_in),
    height_in: num(fighter?.height_in),
    stance: fighter?.stance ?? null,

    experience_log: snap ? log1p(apps) : null,
    five_round_exp: snap ? log1p(num(snap.five_round_apps) ?? 0) : null,
    title_exp: snap ? log1p(num(snap.title_apps) ?? 0) : null,

    winrate: snap ? smoothedWinRate(wins, apps) : null,
    recent5_winrate: recent5,
    streak: hist.results.length ? clamp(streak, -5, 5) : null,
    layoff_log: layoffDays == null ? null : log1p(layoffDays),

    slpm: m('sig_landed_per_min'),
    sapm: m('sig_absorbed_per_min'),
    sig_diff_per_min: m('sig_diff_per_min'),
    sig_accuracy: m('sig_accuracy'),
    sig_defense: m('sig_defense'),
    kd_per15: m('knockdowns_per_15'),
    kd_absorbed_per15: m('knockdowns_absorbed_per_15'),

    td_landed_per15: m('td_landed_per_15'),
    td_accuracy: m('td_accuracy'),
    td_defense: tdDef,
    control_share: m('control_share'),
    sub_att_per15: m('sub_attempts_per_15'),

    finish_rate: m('finish_rate'),
    ko_rate: m('ko_finish_rate'),
    sub_rate: m('submission_finish_rate'),
    ko_loss_rate: finishedBy && apps > 0 ? (num(finishedBy.ko_tko) ?? 0) / apps : null,
    sub_loss_rate: finishedBy && apps > 0 ? (num(finishedBy.submission) ?? 0) / apps : null,

    pace_retention: m('pace_retention_r3_vs_r1'),
    champ_round_delta: m('championship_round_delta'),

    sos,
    quality_wins_log: hist.results.length ? log1p(qualityWins) : null,
    stat_sample_log: snap ? log1p(num(snap.sample_stat_bouts) ?? 0) : null,
  };
}

export function vectorFor(s1, s2) {
  const isSouthpaw = (s) => s === 'SOUTHPAW';
  const southpawEdge =
    isSouthpaw(s1.stance) === isSouthpaw(s2.stance) ? { v: 0, ok: s1.stance != null && s2.stance != null }
      : isSouthpaw(s1.stance) ? { v: 1, ok: true } : { v: -1, ok: true };

  const pairs = {
    age_diff_years: diff(s1.age_years, s2.age_years),
    reach_diff_in: diff(s1.reach_in, s2.reach_in),
    height_diff_in: diff(s1.height_in, s2.height_in),
    experience_log_diff: diff(s1.experience_log, s2.experience_log),
    five_round_exp_diff: diff(s1.five_round_exp, s2.five_round_exp),
    title_exp_diff: diff(s1.title_exp, s2.title_exp),
    winrate_diff: diff(s1.winrate, s2.winrate),
    recent5_winrate_diff: diff(s1.recent5_winrate, s2.recent5_winrate),
    streak_diff: diff(s1.streak, s2.streak),
    layoff_log_diff: diff(s1.layoff_log, s2.layoff_log),
    slpm_diff: diff(s1.slpm, s2.slpm),
    sapm_diff: diff(s1.sapm, s2.sapm),
    sig_diff_per_min_diff: diff(s1.sig_diff_per_min, s2.sig_diff_per_min),
    sig_accuracy_diff: diff(s1.sig_accuracy, s2.sig_accuracy),
    sig_defense_diff: diff(s1.sig_defense, s2.sig_defense),
    kd_per15_diff: diff(s1.kd_per15, s2.kd_per15),
    kd_absorbed_per15_diff: diff(s1.kd_absorbed_per15, s2.kd_absorbed_per15),
    td_landed_per15_diff: diff(s1.td_landed_per15, s2.td_landed_per15),
    td_accuracy_diff: diff(s1.td_accuracy, s2.td_accuracy),
    td_defense_diff: diff(s1.td_defense, s2.td_defense),
    control_share_diff: diff(s1.control_share, s2.control_share),
    sub_att_per15_diff: diff(s1.sub_att_per15, s2.sub_att_per15),
    finish_rate_diff: diff(s1.finish_rate, s2.finish_rate),
    ko_rate_diff: diff(s1.ko_rate, s2.ko_rate),
    sub_rate_diff: diff(s1.sub_rate, s2.sub_rate),
    ko_loss_rate_diff: diff(s1.ko_loss_rate, s2.ko_loss_rate),
    sub_loss_rate_diff: diff(s1.sub_loss_rate, s2.sub_loss_rate),
    pace_retention_diff: diff(s1.pace_retention, s2.pace_retention),
    champ_round_delta_diff: diff(s1.champ_round_delta, s2.champ_round_delta),
    southpaw_edge: southpawEdge,
    sos_diff: diff(s1.sos, s2.sos),
    quality_wins_diff: diff(s1.quality_wins_log, s2.quality_wins_log),
    stat_sample_log_diff: diff(s1.stat_sample_log, s2.stat_sample_log),
  };

  const x = FEATURE_KEYS.map((k) => round(pairs[k].v, 6));
  const available = FEATURE_KEYS.map((k) => (pairs[k].ok ? 1 : 0));
  return { x, available };
}

/* ---- targeted production assembly --------------------------------------- */

const COUNTED = new Set(['W', 'L', 'D', 'NC']);

/** Extract row order is (fighter_id asc, bout_id asc); the batch walk folds a
 *  date's rows in that order. Reproducing it exactly is what makes an
 *  opponent's win rate at a same-date row identical to the batch value. */
const beforeInBatchOrder = (a, b) => (a.fighter_id === b.fighter_id ? a.bout_id < b.bout_id : a.fighter_id < b.fighter_id);

/** Win rate of `fighterId` as the batch ladder held it at the moment `atRow`
 *  was folded in: every row dated earlier, plus same-date rows folded first. */
function ladderWinRateAt(rowsOf, fighterId, atRow) {
  let apps = 0, w = 0;
  for (const r of rowsOf.get(fighterId) || []) {
    if (r.event_date < atRow.event_date || (r.event_date === atRow.event_date && beforeInBatchOrder(r, atRow))) {
      if (COUNTED.has(r.outcome)) { apps += 1; if (r.outcome === 'W') w += 1; }
    }
  }
  return apps > 0 ? w / apps : null;
}

/** The ladder state for one fighter immediately before `eventDate`. */
export function ladderFor(rowsOf, fighterId, eventDate) {
  const own = (rowsOf.get(fighterId) || [])
    .filter((r) => r.event_date < eventDate)
    .sort((a, b) => (a.event_date === b.event_date ? (beforeInBatchOrder(a, b) ? -1 : 1) : a.event_date.localeCompare(b.event_date)));
  const s = { results: [], oppTdLanded: 0, oppTdAtt: 0, w: 0, apps: 0 };
  for (const r of own) {
    s.results.push({ date: r.event_date, outcome: r.outcome, bout_id: r.bout_id, opponent_id: r.opponent_id, oppWinRate: ladderWinRateAt(rowsOf, r.opponent_id, r) });
    if (COUNTED.has(r.outcome)) { s.apps += 1; if (r.outcome === 'W') s.w += 1; }
    const ot = r.opp_totals;
    if (ot) { s.oppTdLanded += num(ot.td_l) ?? 0; s.oppTdAtt += num(ot.td_a) ?? 0; }
  }
  return s;
}

/**
 * One bout's feature row, assembled from exactly the rows a Worker can fetch
 * for that card: the two fighters, their snapshots, their bout-feature rows and
 * the bout-feature rows of every opponent they have faced.
 *
 * @param {{id, event_id, fighter_a_id, fighter_b_id, weight_class, is_womens, is_title, scheduled_rounds, card_position, status}} bout
 * @param {{name, event_date}} event
 * @param {Map<string, object>} fighters
 * @param {Map<string, object[]>} snapsOf  fighter_id -> snapshots sorted by as_of_date asc
 * @param {Map<string, object[]>} rowsOf   fighter_id -> ufc_fighter_bout_features rows
 */
export function assembleBoutRow(bout, event, fighters, snapsOf, rowsOf) {
  const date = event.event_date;
  const f1id = bout.fighter_a_id < bout.fighter_b_id ? bout.fighter_a_id : bout.fighter_b_id;
  const f2id = f1id === bout.fighter_a_id ? bout.fighter_b_id : bout.fighter_a_id;
  const snaps = [f1id, f2id].map((id) => latestAsOf(snapsOf.get(id) || [], date));
  const side1 = buildSide(fighters.get(f1id), snaps[0], ladderFor(rowsOf, f1id, date), date);
  const side2 = buildSide(fighters.get(f2id), snaps[1], ladderFor(rowsOf, f2id, date), date);
  const { x, available } = vectorFor(side1, side2);
  return {
    bout_id: bout.id,
    event_id: bout.event_id,
    event_date: date,
    event_name: event.name ?? null,
    fighter_1_id: f1id,
    fighter_2_id: f2id,
    fighter_1_name: fighters.get(f1id)?.name ?? null,
    fighter_2_name: fighters.get(f2id)?.name ?? null,
    weight_class: bout.weight_class,
    is_womens: Boolean(bout.is_womens),
    is_title: Boolean(bout.is_title),
    scheduled_rounds: bout.scheduled_rounds,
    card_position: bout.card_position,
    bout_status: bout.status,
    x,
    available,
    available_count: available.reduce((a, v) => a + v, 0),
    min_prior_bouts: Math.min(side1.prior_bouts, side2.prior_bouts),
    min_stat_bouts: Math.min(side1.stat_bouts, side2.stat_bouts),
    side_1: side1,
    side_2: side2,
    snapshot_integrity: snaps.map((snap, i) => {
      if (!snap) return { fighter_id: i ? f2id : f1id, snapshot: null };
      const included = Array.isArray(snap.included_bouts) ? snap.included_bouts : [];
      return { fighter_id: i ? f2id : f1id, snapshot: snap.as_of_date, target_in_snapshot: included.includes(bout.id), snapshot_after_event: snap.as_of_date > date };
    }),
  };
}
