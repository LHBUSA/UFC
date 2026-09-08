#!/usr/bin/env node
// PBE Fight Model v1 — read-only dataset extraction.
//
//   node scripts/model/extract_dataset.mjs
//
// Pulls exactly the columns the model is allowed to see into a local cache so
// that feature building, training and backtesting are reproducible offline and
// never re-query production. This script issues GETs only.
//
// COLUMN ALLOWLIST IS THE LEAKAGE CONTRACT
// ----------------------------------------
// ufc_fighters carries present-day career aggregates (record_w/l/d/nc,
// career_slpm, career_str_acc, career_sapm, career_str_def, career_td_avg,
// career_td_acc, career_td_def, career_sub_avg, is_active, fight_history_count).
// Those describe the fighter as they are TODAY. Applied to a 2015 bout they are
// a direct statement of what happened after it. They are therefore never
// selected here, so no later stage can reach them even by mistake.
//
// What is selected from that table is dob, height_in, reach_in and stance:
// physical constants and a style label, not outcome accumulators. The stance
// caveat is documented in docs/model/LEAKAGE.md.
//
// ufc_bout_results is pulled for LABELS ONLY and is fenced off from feature
// building; see build_features.mjs, which never receives it for the bout under
// prediction.

import path from 'node:path';
import { rest, cacheDir, writeJsonl } from './common.mjs';

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

const SNAPSHOT_SELECT = [
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

const TABLES = [
  ['events', 'ufc_events', 'select=id,name,event_date&order=id.asc'],
  ['fighters', 'ufc_fighters', 'select=id,name,dob,height_in,reach_in,stance&order=id.asc'],
  ['bouts', 'ufc_bouts',
    'select=id,event_id,fighter_a_id,fighter_b_id,weight_class,is_womens,is_title,scheduled_rounds,card_position,bout_order,status&order=id.asc'],
  ['results', 'ufc_bout_results', 'select=bout_id,winner_id,method,round,time_sec&order=bout_id.asc'],
  ['bout_features', 'ufc_fighter_bout_features',
    'select=fighter_id,bout_id,event_id,opponent_id,event_date,outcome,method,scheduled_rounds,is_title,is_main_event,short_notice_days,observed_seconds,stats_coverage,round_rows,fighter_stance,opponent_stance,stance_context,totals:raw_stats->totals,opp_totals:raw_stats->opp_totals&feature_version=eq.1&order=fighter_id.asc,bout_id.asc'],
  ['snapshots', 'ufc_fighter_dna_snapshots',
    `select=${SNAPSHOT_SELECT}&definition_version=eq.1&order=fighter_id.asc,as_of_date.asc`],
  ['market', 'ufc_market_observations',
    'select=id,bout_id,event_id,bookmaker_key,market_key,outcome_name,outcome_fighter_id,price,source_last_update,commence_time,observed_at&order=id.asc'],
];

async function main() {
  const db = rest();
  const dir = cacheDir();
  const manifest = { extracted_at: new Date().toISOString(), tables: {} };

  for (const [name, table, query] of TABLES) {
    process.stdout.write(`  ${name} ... `);
    const rows = await db.selectAll(table, `?${query}`, { limit: 1000 });
    const file = path.join(dir, `${name}.jsonl`);
    writeJsonl(file, rows);
    manifest.tables[name] = { table, query, rows: rows.length };
    console.log(`${rows.length} rows -> ${path.basename(file)}`);
  }

  const fs = await import('node:fs');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nCache: ${dir}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
