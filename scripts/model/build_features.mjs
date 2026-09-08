#!/usr/bin/env node
// PBE Fight Model v1 - feature assembly.
//
//   node scripts/model/build_features.mjs
//
// Turns the cached read-only extract into one row per bout: a canonical corner
// orientation, an antisymmetric feature vector, a label where the bout has been
// fought, and a per-bout leakage audit.
//
// TEMPORAL RULE, stated once and enforced everywhere below
// -------------------------------------------------------
// A bout on date D may only see facts whose own date is strictly before D.
// Two mechanisms carry that:
//
//   * Fight DNA snapshots. The repaired historical build writes one snapshot
//     per fighter dated the day AFTER each of their bouts, containing only
//     bouts with event_date < as_of_date. Selecting the latest snapshot with
//     as_of_date <= D therefore yields a strictly pre-fight view. Every
//     selection is checked against the snapshot's own provenance.bouts list:
//     the bout under prediction must not appear in it, and no bout in it may
//     be dated on or after D. Violations are counted, reported, and by default
//     abort the build rather than being silently dropped.
//
//   * The per-bout DNA feature rows, walked in strict date order. State is
//     updated in DATE BLOCKS: every bout on a given date is featurised from the
//     state as it stood before that date, and only then does the date's results
//     get folded in. Without the block, two fighters on the same card could see
//     each other's result from that card.
//
// Nothing from ufc_bout_results, ufc_bout_round_stats or ufc_market_observations
// for the bout under prediction is visible to any function that produces a
// feature. Results enter only as the label, downstream of the vector.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cacheDir, readJsonl, writeJsonl, num, daysBetween, round } from './common.mjs';
import { FEATURE_KEYS, FEATURE_VERSION } from './feature_spec.mjs';

const log1p = Math.log1p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Difference of two possibly-null quantities. Null on either side is no
 *  evidence either way, which under an antisymmetric no-intercept model is
 *  exactly a zero. Availability is tracked separately so that "we know nothing"
 *  is never mistaken for "the two corners are equal". */
function diff(a, b) {
  if (a == null || b == null) return { v: 0, ok: false };
  const d = a - b;
  return { v: Number.isFinite(d) ? d : 0, ok: Number.isFinite(d) };
}

/** Latest element of a date-sorted array whose as_of_date is <= cutoff. */
function latestAsOf(sorted, cutoff) {
  let lo = 0, hi = sorted.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].as_of_date <= cutoff) { best = sorted[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const smoothedWinRate = (w, apps) => (w + 1) / (apps + 2);

function buildSide(fighter, snap, hist, eventDate) {
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

function vectorFor(s1, s2) {
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

/** Load the cached extract into plain arrays, so a caller can truncate them
 *  before building. The leakage audit relies on being able to delete every row
 *  dated at or after a bout and rebuild that bout's vector unchanged. */
export function loadTables(cache) {
  const L = (n) => readJsonl(path.join(cache, `${n}.jsonl`));
  return {
    events: L('events'),
    fighters: L('fighters'),
    results: L('results'),
    bouts: L('bouts'),
    bout_features: L('bout_features'),
    snapshots: L('snapshots'),
  };
}

export function buildDataset(cache) {
  return buildFromTables(loadTables(cache));
}

export function buildFromTables(tables) {
  const events = new Map(tables.events.map((e) => [e.id, e]));
  const fighters = new Map(tables.fighters.map((f) => [f.id, f]));
  const results = new Map(tables.results.map((r) => [r.bout_id, r]));
  const bouts = tables.bouts;
  const boutFeatures = tables.bout_features;

  // Snapshots indexed per fighter, date ascending.
  const snapsByFighter = new Map();
  for (const s of tables.snapshots) {
    if (!snapsByFighter.has(s.fighter_id)) snapsByFighter.set(s.fighter_id, []);
    snapsByFighter.get(s.fighter_id).push(s);
  }
  for (const arr of snapsByFighter.values()) arr.sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));

  const boutDate = new Map();
  for (const b of bouts) {
    const d = events.get(b.event_id)?.event_date;
    if (d) boutDate.set(b.id, d);
  }

  // Per-bout DNA rows grouped by date, then by bout, so the ladder can be
  // advanced one whole date at a time.
  const featureRowsByDate = new Map();
  for (const r of boutFeatures) {
    if (!r.event_date) continue;
    if (!featureRowsByDate.has(r.event_date)) featureRowsByDate.set(r.event_date, []);
    featureRowsByDate.get(r.event_date).push(r);
  }

  const boutsByDate = new Map();
  for (const b of bouts) {
    const d = boutDate.get(b.id);
    if (!d) continue;
    if (!boutsByDate.has(d)) boutsByDate.set(d, []);
    boutsByDate.get(d).push(b);
  }

  const allDates = [...new Set([...boutsByDate.keys(), ...featureRowsByDate.keys()])].sort();

  const ladder = new Map(); // fighter_id -> { results: [], oppTdLanded, oppTdAtt, w, apps }
  const state = (id) => {
    if (!ladder.has(id)) ladder.set(id, { results: [], oppTdLanded: 0, oppTdAtt: 0, w: 0, apps: 0 });
    return ladder.get(id);
  };
  const ladderWinRate = (id) => {
    const s = ladder.get(id);
    return s && s.apps > 0 ? s.w / s.apps : null;
  };

  const audit = {
    bouts_seen: 0,
    rows_emitted: 0,
    skipped_no_date: 0,
    violation_target_in_snapshot: 0,
    violation_future_bout_in_snapshot: 0,
    violation_snapshot_after_event: 0,
    snapshot_record_checked: 0,
    snapshot_record_mismatch: 0,
    max_included_bout_date_offset_days: null,
    examples: [],
  };

  const rows = [];

  for (const date of allDates) {
    for (const b of boutsByDate.get(date) || []) {
      audit.bouts_seen += 1;
      const f1id = b.fighter_a_id < b.fighter_b_id ? b.fighter_a_id : b.fighter_b_id;
      const f2id = f1id === b.fighter_a_id ? b.fighter_b_id : b.fighter_a_id;

      const snaps = [f1id, f2id].map((id) => latestAsOf(snapsByFighter.get(id) || [], date));

      for (const [i, snap] of snaps.entries()) {
        if (!snap) continue;
        if (snap.as_of_date > date) {
          audit.violation_snapshot_after_event += 1;
          if (audit.examples.length < 20) audit.examples.push({ kind: 'snapshot_after_event', bout_id: b.id, date, as_of: snap.as_of_date });
        }
        const included = Array.isArray(snap.included_bouts) ? snap.included_bouts : [];
        if (included.includes(b.id)) {
          audit.violation_target_in_snapshot += 1;
          if (audit.examples.length < 20) audit.examples.push({ kind: 'target_in_snapshot', bout_id: b.id, date, fighter: i === 0 ? f1id : f2id });
        }
        for (const id of included) {
          const d = boutDate.get(id);
          if (!d) continue;
          const offset = daysBetween(d, date);
          if (audit.max_included_bout_date_offset_days == null || offset < audit.max_included_bout_date_offset_days) {
            audit.max_included_bout_date_offset_days = offset;
          }
          if (d >= date) {
            audit.violation_future_bout_in_snapshot += 1;
            if (audit.examples.length < 20) audit.examples.push({ kind: 'future_bout_in_snapshot', bout_id: b.id, date, included_bout: id, included_date: d });
          }
        }
        const ladderApps = ladder.get(i === 0 ? f1id : f2id)?.apps;
        if (ladderApps != null && snap.record) {
          audit.snapshot_record_checked += 1;
          if (Number(snap.record.appearances) !== ladderApps) audit.snapshot_record_mismatch += 1;
        }
      }

      const side1 = buildSide(fighters.get(f1id), snaps[0], state(f1id), date);
      const side2 = buildSide(fighters.get(f2id), snaps[1], state(f2id), date);
      const { x, available } = vectorFor(side1, side2);

      const res = results.get(b.id) || null;
      const label = !res || !res.winner_id ? null : res.winner_id === f1id ? 1 : res.winner_id === f2id ? 0 : null;

      rows.push({
        bout_id: b.id,
        event_id: b.event_id,
        event_date: date,
        event_name: events.get(b.event_id)?.name ?? null,
        fighter_1_id: f1id,
        fighter_2_id: f2id,
        fighter_1_name: fighters.get(f1id)?.name ?? null,
        fighter_2_name: fighters.get(f2id)?.name ?? null,
        weight_class: b.weight_class,
        is_womens: Boolean(b.is_womens),
        is_title: Boolean(b.is_title),
        scheduled_rounds: b.scheduled_rounds,
        card_position: b.card_position,
        bout_status: b.status,
        label,
        result_method: res?.method ?? null,
        graded: label != null,
        x,
        available,
        available_count: available.reduce((a, v) => a + v, 0),
        min_prior_bouts: Math.min(side1.prior_bouts, side2.prior_bouts),
        min_stat_bouts: Math.min(side1.stat_bouts, side2.stat_bouts),
        side_1: side1,
        side_2: side2,
      });
      audit.rows_emitted += 1;
    }

    // Date block boundary: only now do this date's results enter the ladder.
    for (const r of featureRowsByDate.get(date) || []) {
      const s = state(r.fighter_id);
      const oppWr = ladderWinRate(r.opponent_id);
      s.results.push({ date: r.event_date, outcome: r.outcome, bout_id: r.bout_id, opponent_id: r.opponent_id, oppWinRate: oppWr });
      // Appearances count every graded outcome including a no-contest, which
      // is what the Fight DNA snapshot's own record does. Counting them
      // differently would make the integrity cross-check below meaningless.
      if (r.outcome === 'W' || r.outcome === 'L' || r.outcome === 'D' || r.outcome === 'NC') {
        s.apps += 1;
        if (r.outcome === 'W') s.w += 1;
      }
      const ot = r.opp_totals;
      if (ot) { s.oppTdLanded += num(ot.td_l) ?? 0; s.oppTdAtt += num(ot.td_a) ?? 0; }
    }
  }

  return { rows, audit };
}

function main() {
  const cache = cacheDir();
  const { rows, audit } = buildDataset(cache);
  const file = path.join(cache, 'dataset.jsonl');
  writeJsonl(file, rows);
  fs.writeFileSync(path.join(cache, 'feature_audit.json'), JSON.stringify({ feature_version: FEATURE_VERSION, features: FEATURE_KEYS.length, ...audit }, null, 2));

  const graded = rows.filter((r) => r.graded);
  console.log(`rows=${rows.length} graded=${graded.length} features=${FEATURE_KEYS.length}`);
  console.log(`base rate (canonical corner 1 wins) = ${(graded.reduce((a, r) => a + r.label, 0) / graded.length).toFixed(4)}`);
  console.log('leakage audit:', JSON.stringify({
    target_in_snapshot: audit.violation_target_in_snapshot,
    future_bout_in_snapshot: audit.violation_future_bout_in_snapshot,
    snapshot_after_event: audit.violation_snapshot_after_event,
    record_mismatch: `${audit.snapshot_record_mismatch}/${audit.snapshot_record_checked}`,
  }));
  console.log(`-> ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
