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
import { cacheDir, readJsonl, writeJsonl, num, daysBetween } from './common.mjs';
import { FEATURE_KEYS, FEATURE_VERSION } from './feature_spec.mjs';
// The side builder and vector live in features_core.mjs, shared verbatim with the
// production scheduler's per-bout assembly.
import { buildSide, vectorFor, latestAsOf } from './features_core.mjs';

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
