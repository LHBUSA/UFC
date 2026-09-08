#!/usr/bin/env node
// Guarded repair runner for Fight DNA after the UFCStats historical backfill.
//
// This deliberately does NOT edit production tables unless --apply is passed.
// It patches the committed v1.1 builder into a temporary v1.2 repair build so
// the repair can prove the structural issues before we change the canonical
// builder: full deterministic pagination, exclusive as-of semantics, and full
// regeneration of every historical pre-fight snapshot from backfilled evidence.
//
// Usage:
//   node scripts/dna/repair_historical_snapshots.mjs --dry-run
//   node scripts/dna/repair_historical_snapshots.mjs --apply
//
// A successful dry-run must show every current source row was loaded and must
// resolve known historical canaries with their backfilled pre-fight stat sample.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(__dirname, 'build_fight_dna.mjs');
const TEMP = path.join(__dirname, '.history-repair-builder.tmp.mjs');

const argv = process.argv.slice(2);
const flag = (x) => argv.includes(x);
const opt = (x) => {
  const i = argv.indexOf(x);
  return i >= 0 ? argv[i + 1] : undefined;
};

const APPLY = flag('--apply');
const DRY = flag('--dry-run');
const AS_OF = opt('--as-of') || new Date().toISOString().slice(0, 10);
const ONLY_FIGHTER = opt('--fighter') || null;

if (APPLY === DRY) {
  console.error('Pass exactly one of --dry-run or --apply.');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) {
  console.error('--as-of must be YYYY-MM-DD');
  process.exit(2);
}

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  process.exit(2);
}
const HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function exactCount(table, column, filter = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(column)}${filter}`, {
    headers: { ...HEADERS, Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' },
  });
  if (!r.ok && r.status !== 206) {
    throw new Error(`count ${table} ${r.status}: ${await r.text()}`);
  }
  const range = r.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (!Number.isFinite(total)) throw new Error(`count ${table}: missing exact content-range (${range})`);
  return total;
}

function replaceOnce(src, before, after, label) {
  const first = src.indexOf(before);
  if (first < 0) throw new Error(`repair patch anchor missing: ${label}`);
  if (src.indexOf(before, first + before.length) >= 0) throw new Error(`repair patch anchor duplicated: ${label}`);
  return src.slice(0, first) + after + src.slice(first + before.length);
}

function patchedBuilder() {
  let src = fs.readFileSync(SOURCE, 'utf8');

  src = replaceOnce(
    src,
    "const BUILDER = 'scripts/dna/build_fight_dna.mjs@v1.1';",
    "const BUILDER = 'scripts/dna/build_fight_dna.mjs@v1.2-history-repair';",
    'builder provenance',
  );
  src = replaceOnce(
    src,
    "const AS_OF = opt('--as-of') || new Date().toISOString().slice(0, 10);",
    "const AS_OF = opt('--as-of') || new Date().toISOString().slice(0, 10);\nlet METRIC_AS_OF = AS_OF;",
    'snapshot metric clock',
  );
  src = replaceOnce(
    src,
    "    source_families: sourceFamilies,\n    as_of_date: AS_OF,\n    origin: 'pbe_derived',",
    "    source_families: sourceFamilies,\n    as_of_date: METRIC_AS_OF,\n    origin: 'pbe_derived',",
    'metric as-of date',
  );
  src = replaceOnce(
    src,
    'function buildSnapshot(fighter, features, runId, watermarks) {\n  const record = recordOf(features);',
    'function buildSnapshot(fighter, features, runId, watermarks, snapshotDate = AS_OF) {\n  METRIC_AS_OF = snapshotDate;\n  const record = recordOf(features);',
    'snapshot date parameter',
  );
  src = replaceOnce(
    src,
    '    fighter_id: fighter.id,\n    as_of_date: AS_OF,\n    definition_version: DEFINITION_VERSION,',
    '    fighter_id: fighter.id,\n    as_of_date: snapshotDate,\n    definition_version: DEFINITION_VERSION,',
    'snapshot row as-of date',
  );

  src = replaceOnce(
    src,
    "selectAll('ufc_fighters', 'select=id,name,stance&order=name.asc')",
    "selectAll('ufc_fighters', 'select=id,name,stance&order=id.asc')",
    'fighters stable order',
  );
  src = replaceOnce(
    src,
    "selectAll('ufc_events', `select=id,name,event_date&event_date=lte.${AS_OF}&order=event_date.asc`)",
    "selectAll('ufc_events', `select=id,name,event_date&event_date=lt.${AS_OF}&order=event_date.asc,id.asc`)",
    'exclusive event cutoff',
  );
  src = replaceOnce(
    src,
    "selectAll('ufc_bouts', 'select=id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,scheduled_rounds,is_title,card_position,bout_order,status,short_notice_days,captured_at,updated_at&status=eq.complete&limit=5000')",
    "selectAll('ufc_bouts', 'select=id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,scheduled_rounds,is_title,card_position,bout_order,status,short_notice_days,captured_at,updated_at&status=eq.complete&order=id.asc')",
    'all complete bouts',
  );
  src = replaceOnce(
    src,
    "selectAll('ufc_bout_results', 'select=bout_id,winner_id,method,method_raw,round,time_sec,time_format,result_source,has_stats,source_url,captured_at,stats_source_url,stats_captured_at&limit=5000')",
    "selectAll('ufc_bout_results', 'select=bout_id,winner_id,method,method_raw,round,time_sec,time_format,result_source,has_stats,source_url,captured_at,stats_source_url,stats_captured_at&order=bout_id.asc')",
    'all results',
  );
  src = replaceOnce(
    src,
    "selectAll('ufc_bout_round_stats', `select=bout_id,fighter_id,round,${ROUND_KEYS.join(',')},source_url,captured_at&limit=10000`)",
    "selectAll('ufc_bout_round_stats', `select=bout_id,fighter_id,round,${ROUND_KEYS.join(',')},source_url,captured_at&order=bout_id.asc,fighter_id.asc,round.asc`)",
    'all round stats',
  );
  src = replaceOnce(
    src,
    "return e?.event_date && e.event_date <= AS_OF && fighterMap.has(b.fighter_a_id) && fighterMap.has(b.fighter_b_id) && (!ONLY_FIGHTER || b.fighter_a_id === ONLY_FIGHTER || b.fighter_b_id === ONLY_FIGHTER);",
    "return e?.event_date && e.event_date < AS_OF && fighterMap.has(b.fighter_a_id) && fighterMap.has(b.fighter_b_id) && (!ONLY_FIGHTER || b.fighter_a_id === ONLY_FIGHTER || b.fighter_b_id === ONLY_FIGHTER);",
    'exclusive relevant-bout cutoff',
  );

  const oldSnapshotLoop = `    const targetFighters = ONLY_FIGHTER ? fighters.filter((f) => f.id === ONLY_FIGHTER) : fighters;
    const snapshots = [];
    const stanceRows = [];
    for (const fighter of targetFighters) {
      const fs = (byFighter.get(fighter.id) || []).sort((a, b) => a.event_date.localeCompare(b.event_date));
      if (!fs.length) continue;
      const snap = buildSnapshot(fighter, fs, runId, watermarks);
      snapshots.push(snap);
      for (const s of ['ORTHODOX', 'SOUTHPAW', 'SWITCH', 'SIDEWAYS', 'UNKNOWN']) {
        const split = snap.stance_splits[s];
        if (!split || !split.record.appearances) continue;
        stanceRows.push({
          fighter_id: fighter.id,
          as_of_date: AS_OF,
          opponent_stance: s,
          definition_version: DEFINITION_VERSION,
          appearances: split.record.appearances,
          wins: split.record.w,
          losses: split.record.l,
          draws: split.record.d,
          no_contests: split.record.nc,
          ko_tko_wins: split.ko_tko_wins,
          submission_wins: split.submission_wins,
          decision_wins: split.decision_wins,
          stat_bouts: split.stat_bouts,
          stat_rounds: split.stat_rounds,
          observed_seconds: split.observed_seconds,
          metrics: {
            finish_rate: split.finish_rate,
            ko_rate: split.ko_rate,
            sub_rate: split.sub_rate,
            sig_diff_per_min: split.sig_diff_per_min,
            td_landed_per_15: split.td_landed_per_15,
            kd_per_15: split.kd_per_15,
          },
          confidence: split.confidence,
          provenance: { builder: BUILDER, build_run_id: runId, as_of_date: AS_OF },
          generated_at: new Date().toISOString(),
        });
      }
    }
`;

  const newSnapshotLoop = `    const targetFighters = ONLY_FIGHTER ? fighters.filter((f) => f.id === ONLY_FIGHTER) : fighters;
    const snapshots = [];
    const stanceRows = [];
    const addOneDay = (date) => {
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    for (const fighter of targetFighters) {
      const fs = (byFighter.get(fighter.id) || []).sort((a, b) => a.event_date.localeCompare(b.event_date));
      if (!fs.length) continue;
      const dates = [...new Set([...fs.map((f) => addOneDay(f.event_date)).filter((d) => d <= AS_OF), AS_OF])].sort();
      for (const snapshotDate of dates) {
        const eligible = fs.filter((f) => f.event_date < snapshotDate);
        if (!eligible.length) continue;
        const snap = buildSnapshot(fighter, eligible, runId, watermarks, snapshotDate);
        snapshots.push(snap);
        for (const s of ['ORTHODOX', 'SOUTHPAW', 'SWITCH', 'SIDEWAYS', 'UNKNOWN']) {
          const split = snap.stance_splits[s];
          if (!split || !split.record.appearances) continue;
          stanceRows.push({
            fighter_id: fighter.id,
            as_of_date: snapshotDate,
            opponent_stance: s,
            definition_version: DEFINITION_VERSION,
            appearances: split.record.appearances,
            wins: split.record.w,
            losses: split.record.l,
            draws: split.record.d,
            no_contests: split.record.nc,
            ko_tko_wins: split.ko_tko_wins,
            submission_wins: split.submission_wins,
            decision_wins: split.decision_wins,
            stat_bouts: split.stat_bouts,
            stat_rounds: split.stat_rounds,
            observed_seconds: split.observed_seconds,
            metrics: {
              finish_rate: split.finish_rate,
              ko_rate: split.ko_rate,
              sub_rate: split.sub_rate,
              sig_diff_per_min: split.sig_diff_per_min,
              td_landed_per_15: split.td_landed_per_15,
              kd_per_15: split.kd_per_15,
            },
            confidence: split.confidence,
            provenance: { builder: BUILDER, build_run_id: runId, as_of_date: snapshotDate },
            generated_at: new Date().toISOString(),
          });
        }
      }
    }
`;
  src = replaceOnce(src, oldSnapshotLoop, newSnapshotLoop, 'full historical snapshot loop');

  src = replaceOnce(
    src,
    "    const output = {\n      feature_rows: featureRows.length,",
    `    const resolveCanary = (name, requestedAsOf) => {
      const fighter = fighters.find((f) => f.name === name);
      if (!fighter) return { name, requested_as_of: requestedAsOf, missing: 'fighter' };
      const row = snapshots
        .filter((s) => s.fighter_id === fighter.id && s.as_of_date <= requestedAsOf)
        .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))[0];
      return row ? {
        name,
        requested_as_of: requestedAsOf,
        resolved_as_of: row.as_of_date,
        sample_completed_bouts: row.sample_completed_bouts,
        sample_stat_bouts: row.sample_stat_bouts,
        sample_rounds: row.sample_rounds,
        sample_seconds: row.sample_seconds,
      } : { name, requested_as_of: requestedAsOf, missing: 'snapshot' };
    };
    const repairCanaries = [
      resolveCanary('Michael Page', '2026-09-05'),
      resolveCanary('Nursulton Ruziboev', '2026-09-05'),
    ];
    const output = {
      feature_rows: featureRows.length,
      historical_snapshots: snapshots.filter((s) => s.as_of_date !== AS_OF).length,
      distinct_snapshot_dates: new Set(snapshots.map((s) => s.as_of_date)).size,
      repair_canaries: repairCanaries,`,
    'historical proof output',
  );
  src = replaceOnce(
    src,
    "console.log(JSON.stringify({ ok: true, build_run_id: runId, as_of: AS_OF, ...output }, null, 2));",
    "console.log(JSON.stringify({ ok: true, build_run_id: runId, as_of: AS_OF, input_counts: sourceCounts.input_counts, ...output }, null, 2));",
    'proof payload',
  );

  return src;
}

function parseProof(stdout) {
  const marker = '{\n  "ok": true';
  const i = stdout.lastIndexOf(marker);
  if (i < 0) throw new Error('builder did not emit final proof JSON');
  return JSON.parse(stdout.slice(i));
}

async function main() {
  const [completeBouts, results, roundRows] = await Promise.all([
    exactCount('ufc_bouts', 'id', '&status=eq.complete'),
    exactCount('ufc_bout_results', 'bout_id'),
    exactCount('ufc_bout_round_stats', 'bout_id'),
  ]);

  console.log(JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY_RUN',
    as_of: AS_OF,
    fighter: ONLY_FIGHTER,
    source_counts: { complete_bouts: completeBouts, results, round_rows: roundRows },
  }, null, 2));

  fs.writeFileSync(TEMP, patchedBuilder(), 'utf8');
  try {
    const childArgs = [TEMP, '--as-of', AS_OF];
    if (ONLY_FIGHTER) childArgs.push('--fighter', ONLY_FIGHTER);
    if (!APPLY) childArgs.push('--dry-run');

    const p = spawnSync(process.execPath, childArgs, {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (p.stdout) process.stdout.write(p.stdout);
    if (p.stderr) process.stderr.write(p.stderr);
    if (p.status !== 0) throw new Error(`patched builder exited ${p.status}`);

    const proof = parseProof(p.stdout || '');
    const loaded = proof.input_counts || {};
    const failures = [];

    if (loaded.results !== results) failures.push(`results loaded ${loaded.results} != source ${results}`);
    if (proof.round_rows_source !== roundRows) failures.push(`round rows loaded ${proof.round_rows_source} != source ${roundRows}`);
    if (!ONLY_FIGHTER && proof.feature_rows !== loaded.bouts * 2) failures.push(`feature rows ${proof.feature_rows} != 2 x relevant bouts ${loaded.bouts}`);
    if (!proof.snapshots) failures.push('zero snapshots generated');
    if (!proof.historical_snapshots) failures.push('zero historical snapshots generated');
    if (!(proof.distinct_snapshot_dates > 1)) failures.push(`expected multiple historical snapshot dates, got ${proof.distinct_snapshot_dates}`);
    if (!loaded.bouts || loaded.bouts > completeBouts) failures.push(`invalid relevant bout count ${loaded.bouts} / ${completeBouts}`);

    if (!ONLY_FIGHTER) {
      const page = (proof.repair_canaries || []).find((c) => c.name === 'Michael Page');
      const ruz = (proof.repair_canaries || []).find((c) => c.name === 'Nursulton Ruziboev');
      if (!page || page.missing || page.sample_stat_bouts < 5) failures.push(`Michael Page pre-fight stat sample invalid: ${JSON.stringify(page)}`);
      if (!ruz || ruz.missing || ruz.sample_stat_bouts < 6) failures.push(`Nursulton Ruziboev pre-fight stat sample invalid: ${JSON.stringify(ruz)}`);
    }

    console.log(JSON.stringify({
      acceptance: failures.length ? 'FAIL' : 'PASS',
      mode: APPLY ? 'APPLY' : 'DRY_RUN',
      as_of: AS_OF,
      proof: {
        relevant_bouts: loaded.bouts,
        results_loaded: loaded.results,
        round_rows_loaded: proof.round_rows_source,
        feature_rows: proof.feature_rows,
        snapshots: proof.snapshots,
        historical_snapshots: proof.historical_snapshots,
        distinct_snapshot_dates: proof.distinct_snapshot_dates,
        stance_rows: proof.stance_rows,
        stat_snapshots: proof.stat_snapshots,
        repair_canaries: proof.repair_canaries,
      },
      failures,
    }, null, 2));

    if (failures.length) process.exit(1);
  } finally {
    try { fs.unlinkSync(TEMP); } catch {}
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  try { fs.unlinkSync(TEMP); } catch {}
  process.exit(1);
});
