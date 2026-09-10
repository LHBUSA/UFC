#!/usr/bin/env node
// PropBetEdge UFC Fight DNA v1 deterministic builder.
//
// Source facts:
//   ufc_fighters + ufc_events + ufc_bouts + ufc_bout_results
//   + ufc_bout_round_stats
//
// Output:
//   ufc_fighter_bout_features   one fighter-side row per completed bout
//   ufc_fighter_dna_snapshots  as-of aggregate used by web/API
//   ufc_fighter_stance_splits  query-friendly opponent-stance aggregates
//   ufc_dna_build_runs          reproducibility / source watermark ledger
//
// Rules:
//   * no current-career UFCStats profile fields are used for historical features
//   * no future bout is included in an as-of snapshot
//   * result DNA works without round stats
//   * round DNA requires observed round rows; missing == null, never zero
//   * all writes are idempotent upserts on the versioned table keys
//
// Usage:
//   node scripts/dna/build_fight_dna.mjs
//   node scripts/dna/build_fight_dna.mjs --as-of 2026-09-06
//   node scripts/dna/build_fight_dna.mjs --fighter <uuid>
//   node scripts/dna/build_fight_dna.mjs --dry-run

/* CONFIGURATION IS INJECTED, NOT READ FROM THE PROCESS.
 *
 * The production owner of this builder is the Cloudflare Worker
 * workers/ufc-intelligence. In workerd there is no argv, no process.env of the
 * shape a CLI expects, and no .env on disk -- and every one of those was read
 * at MODULE SCOPE here, which means importing this file at all used to be a
 * side effect that could not succeed. So the settings live in module-level
 * bindings assigned by buildFightDna() at the start of a run, and the Node
 * imports moved into the CLI guard at the foot of the file where they can
 * still be used for local rebuilds.
 *
 * The 700 lines of DNA logic below are untouched: they read these bindings by
 * name exactly as before. Rewriting the builder to move a schedule would risk
 * changing what a metric MEANS, and every historical snapshot was computed by
 * the current definition. */
const BUILDER = 'ufc-intelligence/build_fight_dna@v1.1';
const DEFINITION_VERSION = 1;
const FEATURE_VERSION = 1;

let AS_OF = new Date().toISOString().slice(0, 10);
let ONLY_FIGHTER = null;
let DRY_RUN = false;
let SUPABASE_URL = null;
let SERVICE_KEY = null;
let HEADERS = {};

/* One build at a time per isolate. The bindings above are module-level, so two
 * concurrent runs would read each other's as-of date and write snapshots
 * stamped with the wrong day. A cron and a manual admin run overlapping is not
 * hypothetical -- it is the normal way this gets triggered twice. */
let inFlight = null;

/**
 * Build Fight DNA. Deterministic, idempotent, versioned.
 *
 * @param {object} cfg
 * @param {string} cfg.supabaseUrl
 * @param {string} cfg.serviceKey
 * @param {string} [cfg.asOf]       YYYY-MM-DD, defaults to today UTC
 * @param {string} [cfg.fighterId]  rebuild one fighter only
 * @param {boolean}[cfg.dry]
 */
export async function buildFightDna(cfg = {}) {
  if (inFlight) return { ok: false, skipped: 'a build is already running in this isolate' };
  const asOf = cfg.asOf || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('asOf must be YYYY-MM-DD');
  const url = String(cfg.supabaseUrl || '').replace(/\/$/, '');
  const key = String(cfg.serviceKey || '');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');

  AS_OF = asOf;
  ONLY_FIGHTER = cfg.fighterId || null;
  DRY_RUN = Boolean(cfg.dry);
  SUPABASE_URL = url;
  SERVICE_KEY = key;
  HEADERS = { apikey: key, Authorization: `Bearer ${key}` };

  inFlight = main();
  try { return await inFlight; } finally { inFlight = null; }
}

const ROUND_KEYS = [
  'kd', 'sig_str_landed', 'sig_str_att', 'total_str_landed', 'total_str_att',
  'td_landed', 'td_att', 'sub_att', 'rev', 'ctrl_sec',
  'head_landed', 'head_att', 'body_landed', 'body_att', 'leg_landed', 'leg_att',
  'distance_landed', 'distance_att', 'clinch_landed', 'clinch_att', 'ground_landed', 'ground_att',
];

const n = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const nullable = (v) => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
const round4 = (v) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000;
const ratio = (a, b) => b > 0 ? round4(a / b) : null;
const perMin = (a, seconds) => seconds > 0 ? round4(a * 60 / seconds) : null;
const per15 = (a, seconds) => seconds > 0 ? round4(a * 900 / seconds) : null;
const median = (values) => {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : round4((xs[m - 1] + xs[m]) / 2);
};

function stance(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return 'UNKNOWN';
  if (s.includes('ORTHODOX')) return 'ORTHODOX';
  if (s.includes('SOUTHPAW')) return 'SOUTHPAW';
  if (s.includes('SWITCH')) return 'SWITCH';
  if (s.includes('SIDEWAYS')) return 'SIDEWAYS';
  return s.replace(/\s+/g, '_');
}

function stanceContext(a, b) {
  if (!a || !b || a === 'UNKNOWN' || b === 'UNKNOWN') return 'unknown';
  if (a === 'SWITCH' || b === 'SWITCH') return 'switch_involved';
  if (a === b) return 'same';
  if ((a === 'ORTHODOX' && b === 'SOUTHPAW') || (a === 'SOUTHPAW' && b === 'ORTHODOX')) return 'open';
  return 'unknown';
}

function resultOutcome(result, fighterId, opponentId) {
  if (!result) return null;
  if (result.method === 'NC') return 'NC';
  if (result.method === 'DRAW') return 'D';
  if (result.winner_id === fighterId) return 'W';
  if (result.winner_id === opponentId) return 'L';
  return result.winner_id ? 'L' : 'D';
}

function isKo(method) { return method === 'KO_TKO'; }
function isSub(method) { return method === 'SUB'; }
function isDecision(method) { return /^DEC_/.test(String(method || '')); }
function isFinish(method) { return isKo(method) || isSub(method); }

function resultFightSeconds(result) {
  if (!result || !Number.isFinite(Number(result.round)) || !Number.isFinite(Number(result.time_sec))) return null;
  const r = Number(result.round);
  const t = Number(result.time_sec);
  if (r < 1 || t < 0 || t > 300) return null;
  return (r - 1) * 300 + t;
}

function roundSeconds(roundNo, result) {
  if (!result || !Number.isFinite(Number(result.round))) return 300;
  const endingRound = Number(result.round);
  if (roundNo < endingRound) return 300;
  if (roundNo > endingRound) return 0;
  const t = nullable(result.time_sec);
  return t == null ? 300 : Math.min(300, Math.max(0, t));
}

function emptyTotals() {
  return {
    kd: 0, sig_str_landed: 0, sig_str_att: 0, total_str_landed: 0, total_str_att: 0,
    td_landed: 0, td_att: 0, sub_att: 0, rev: 0, ctrl_sec: 0,
    head_landed: 0, head_att: 0, body_landed: 0, body_att: 0, leg_landed: 0, leg_att: 0,
    distance_landed: 0, distance_att: 0, clinch_landed: 0, clinch_att: 0, ground_landed: 0, ground_att: 0,
    rounds: 0, seconds: 0,
  };
}

function addTotals(dst, row) {
  for (const k of ROUND_KEYS) dst[k] += n(row?.[k]);
  return dst;
}

function compactTotals(t) {
  return {
    kd: t.kd, sig_l: t.sig_str_landed, sig_a: t.sig_str_att,
    tot_l: t.total_str_landed, tot_a: t.total_str_att,
    td_l: t.td_landed, td_a: t.td_att, sub: t.sub_att, rev: t.rev, ctrl: t.ctrl_sec,
    head_l: t.head_landed, head_a: t.head_att, body_l: t.body_landed, body_a: t.body_att,
    leg_l: t.leg_landed, leg_a: t.leg_att, dist_l: t.distance_landed, dist_a: t.distance_att,
    clinch_l: t.clinch_landed, clinch_a: t.clinch_att, ground_l: t.ground_landed, ground_a: t.ground_att,
    rounds: t.rounds, seconds: t.seconds,
  };
}

function featureValues(self, opp, roundRows) {
  const seconds = self.seconds;
  const byRound = new Map(roundRows.map((r) => [r.round, r]));
  const rPace = (r) => byRound.get(r)?.seconds > 0 ? perMin(byRound.get(r).self.sig_str_att, byRound.get(r).seconds) : null;
  const rAbs = (r) => byRound.get(r)?.seconds > 0 ? perMin(byRound.get(r).opp.sig_str_landed, byRound.get(r).seconds) : null;
  const r1 = rPace(1), r2 = rPace(2), r3 = rPace(3);
  const lateRows = roundRows.filter((r) => r.round >= 4 && r.seconds > 0);
  const lateSec = lateRows.reduce((a, r) => a + r.seconds, 0);
  const lateAtt = lateRows.reduce((a, r) => a + r.self.sig_str_att, 0);
  const latePace = lateSec > 0 ? perMin(lateAtt, lateSec) : null;
  const earlyRows = roundRows.filter((r) => r.round <= 3 && r.seconds > 0);
  const earlySec = earlyRows.reduce((a, r) => a + r.seconds, 0);
  const earlyAtt = earlyRows.reduce((a, r) => a + r.self.sig_str_att, 0);
  const earlyPace = earlySec > 0 ? perMin(earlyAtt, earlySec) : null;
  return {
    kd_per_15: per15(self.kd, seconds),
    kd_absorbed_per_15: per15(opp.kd, seconds),
    sig_landed_per_min: perMin(self.sig_str_landed, seconds),
    sig_absorbed_per_min: perMin(opp.sig_str_landed, seconds),
    sig_diff_per_min: seconds > 0 ? perMin(self.sig_str_landed - opp.sig_str_landed, seconds) : null,
    sig_accuracy: ratio(self.sig_str_landed, self.sig_str_att),
    sig_defense: opp.sig_str_att > 0 ? round4(1 - opp.sig_str_landed / opp.sig_str_att) : null,
    head_attack_share: ratio(self.head_att, self.sig_str_att),
    body_attack_share: ratio(self.body_att, self.sig_str_att),
    leg_attack_share: ratio(self.leg_att, self.sig_str_att),
    distance_attack_share: ratio(self.distance_att, self.sig_str_att),
    clinch_attack_share: ratio(self.clinch_att, self.sig_str_att),
    ground_attack_share: ratio(self.ground_att, self.sig_str_att),
    td_attempts_per_15: per15(self.td_att, seconds),
    td_landed_per_15: per15(self.td_landed, seconds),
    td_accuracy: ratio(self.td_landed, self.td_att),
    control_seconds_per_td: self.td_landed > 0 ? round4(self.ctrl_sec / self.td_landed) : null,
    control_share: seconds > 0 ? round4(self.ctrl_sec / seconds) : null,
    sub_attempts_per_15: per15(self.sub_att, seconds),
    reversals_per_15: per15(self.rev, seconds),
    r1_sig_att_per_min: r1,
    r2_sig_att_per_min: r2,
    r3_sig_att_per_min: r3,
    r4_sig_att_per_min: rPace(4),
    r5_sig_att_per_min: rPace(5),
    r1_absorbed_per_min: rAbs(1),
    r3_absorbed_per_min: rAbs(3),
    pace_retention_r2_vs_r1: r1 > 0 && r2 != null ? round4(r2 / r1) : null,
    pace_retention_r3_vs_r1: r1 > 0 && r3 != null ? round4(r3 / r1) : null,
    late_round_sig_att_per_min: latePace,
    championship_round_delta: latePace != null && earlyPace != null ? round4(latePace - earlyPace) : null,
    defensive_drift_r3_vs_r1: rAbs(1) != null && rAbs(3) != null ? round4(rAbs(3) - rAbs(1)) : null,
  };
}

function confidenceByBouts(bouts, { min = 1, medium = 5, high = 10 } = {}) {
  if (bouts < min) return 'insufficient';
  if (bouts >= high) return 'high';
  if (bouts >= medium) return 'medium';
  return 'low';
}

function roundConfidence(bouts, rounds, seconds, minBouts = 1, minRounds = 1, minSeconds = 1) {
  if (bouts < minBouts || rounds < minRounds || seconds < minSeconds) return 'insufficient';
  if (bouts >= 10 && rounds >= 25 && seconds >= 6000) return 'high';
  if (bouts >= 5 && rounds >= 12 && seconds >= 3000) return 'medium';
  if (bouts >= 2 && rounds >= 4 && seconds >= 600) return 'medium';
  return 'low';
}

function coverageStatus(statBouts, rounds, seconds) {
  if (!statBouts || !rounds || !seconds) return 'insufficient';
  if (statBouts >= 10 && rounds >= 25 && seconds >= 6000) return 'high';
  if (statBouts >= 5 && rounds >= 12 && seconds >= 3000) return 'medium';
  return 'low';
}

function metric({ key, value, unit, numerator = null, denominator = null, sampleBouts = 0, sampleRounds = 0, sampleSeconds = 0, sourceFamilies = ['ufcstats'], confidence = null, coverage = null }) {
  return {
    metric_key: key,
    definition_version: DEFINITION_VERSION,
    value: value == null ? null : value,
    unit,
    numerator,
    denominator,
    sample_bouts: sampleBouts,
    sample_rounds: sampleRounds,
    sample_seconds: sampleSeconds,
    confidence: confidence || (sourceFamilies.includes('ufcstats') ? roundConfidence(sampleBouts, sampleRounds, sampleSeconds) : confidenceByBouts(sampleBouts)),
    coverage_status: coverage || (sourceFamilies.includes('ufcstats') ? coverageStatus(sampleBouts, sampleRounds, sampleSeconds) : (sampleBouts ? 'high' : 'insufficient')),
    source_families: sourceFamilies,
    as_of_date: AS_OF,
    origin: 'pbe_derived',
  };
}

async function selectAll(table, query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { ...HEADERS, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (res.status === 416) break;
    if (!res.ok) throw new Error(`select ${table} ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function writeBatch(table, rows, conflict, batch = 200) {
  if (DRY_RUN || !rows.length) return;
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(part),
    });
    if (!res.ok) throw new Error(`upsert ${table} ${res.status}: ${await res.text()}`);
  }
}

async function startRun(sourceCounts) {
  if (DRY_RUN) return `dry-${Date.now()}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ufc_dna_build_runs`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      definition_version: DEFINITION_VERSION,
      mode: ONLY_FIGHTER ? 'fighter' : 'full',
      fighter_id: ONLY_FIGHTER,
      as_of_date: AS_OF,
      source_watermark: sourceCounts.watermark,
      input_counts: sourceCounts.input_counts,
      status: 'running',
    }),
  });
  if (!res.ok) throw new Error(`start build run ${res.status}: ${await res.text()}`);
  return (await res.json())[0].id;
}

async function finishRun(id, status, outputCounts, warnings = [], errors = []) {
  if (DRY_RUN || id.startsWith('dry-')) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ufc_dna_build_runs?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ status, output_counts: outputCounts, warnings, errors, finished_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`finish build run ${res.status}: ${await res.text()}`);
}

function aggregateRows(features) {
  const statFeatures = features.filter((f) => f.observed_seconds > 0 && f.round_rows > 0);
  const self = emptyTotals(), opp = emptyTotals();
  for (const f of statFeatures) {
    const s = f.raw_stats?.totals || {};
    const o = f.raw_stats?.opp_totals || {};
    const map = {
      kd: 'kd', sig_str_landed: 'sig_l', sig_str_att: 'sig_a', total_str_landed: 'tot_l', total_str_att: 'tot_a',
      td_landed: 'td_l', td_att: 'td_a', sub_att: 'sub', rev: 'rev', ctrl_sec: 'ctrl',
      head_landed: 'head_l', head_att: 'head_a', body_landed: 'body_l', body_att: 'body_a', leg_landed: 'leg_l', leg_att: 'leg_a',
      distance_landed: 'dist_l', distance_att: 'dist_a', clinch_landed: 'clinch_l', clinch_att: 'clinch_a', ground_landed: 'ground_l', ground_att: 'ground_a',
    };
    for (const [dst, src] of Object.entries(map)) { self[dst] += n(s[src]); opp[dst] += n(o[src]); }
    self.rounds += n(s.rounds); self.seconds += n(s.seconds);
    opp.rounds += n(o.rounds); opp.seconds += n(o.seconds);
  }
  return { statFeatures, self, opp, rounds: self.rounds, seconds: self.seconds };
}

function recordOf(features) {
  const r = { w: 0, l: 0, d: 0, nc: 0, appearances: 0 };
  for (const f of features) {
    if (!f.outcome) continue;
    r.appearances++;
    if (f.outcome === 'W') r.w++;
    else if (f.outcome === 'L') r.l++;
    else if (f.outcome === 'D') r.d++;
    else if (f.outcome === 'NC') r.nc++;
  }
  return r;
}

function aggregateSplit(features, key = 'split') {
  const record = recordOf(features);
  const wins = features.filter((f) => f.outcome === 'W');
  const koWins = wins.filter((f) => isKo(f.method)).length;
  const subWins = wins.filter((f) => isSub(f.method)).length;
  const decWins = wins.filter((f) => isDecision(f.method)).length;
  const { statFeatures, self, opp, rounds, seconds } = aggregateRows(features);
  const conf = confidenceByBouts(record.appearances, { min: 1, medium: 4, high: 8 });
  const resultCoverage = record.appearances ? 'high' : 'insufficient';
  const roundConf = roundConfidence(statFeatures.length, rounds, seconds);
  return {
    record,
    record_metric: metric({ key: `${key}_record`, value: record, unit: 'record', sampleBouts: record.appearances, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn'], confidence: conf, coverage: resultCoverage }),
    ko_tko_wins: koWins,
    submission_wins: subWins,
    decision_wins: decWins,
    finish_rate: metric({ key: 'stance_finish_rate', value: wins.length ? ratio(koWins + subWins, wins.length) : null, unit: 'ratio', numerator: koWins + subWins, denominator: wins.length, sampleBouts: wins.length, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: confidenceByBouts(wins.length, { min: 2, medium: 5, high: 10 }), coverage: resultCoverage }),
    ko_rate: metric({ key: 'stance_ko_rate', value: record.appearances ? ratio(koWins, record.appearances) : null, unit: 'ratio', numerator: koWins, denominator: record.appearances, sampleBouts: record.appearances, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: conf, coverage: resultCoverage }),
    sub_rate: metric({ key: 'stance_sub_rate', value: record.appearances ? ratio(subWins, record.appearances) : null, unit: 'ratio', numerator: subWins, denominator: record.appearances, sampleBouts: record.appearances, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: conf, coverage: resultCoverage }),
    sig_diff_per_min: metric({ key: 'stance_sig_diff_per_min', value: seconds ? perMin(self.sig_str_landed - opp.sig_str_landed, seconds) : null, unit: 'per_min', numerator: seconds ? self.sig_str_landed - opp.sig_str_landed : null, denominator: seconds || null, sampleBouts: statFeatures.length, sampleRounds: rounds, sampleSeconds: seconds, confidence: roundConf }),
    td_landed_per_15: metric({ key: 'stance_td_rate_15', value: seconds ? per15(self.td_landed, seconds) : null, unit: 'per_15', numerator: seconds ? self.td_landed : null, denominator: seconds || null, sampleBouts: statFeatures.length, sampleRounds: rounds, sampleSeconds: seconds, confidence: roundConf }),
    kd_per_15: metric({ key: 'stance_kd_rate_15', value: seconds ? per15(self.kd, seconds) : null, unit: 'per_15', numerator: seconds ? self.kd : null, denominator: seconds || null, sampleBouts: statFeatures.length, sampleRounds: rounds, sampleSeconds: seconds, confidence: roundConf }),
    stat_bouts: statFeatures.length,
    stat_rounds: rounds,
    observed_seconds: seconds,
    confidence: conf,
  };
}

function buildRoundProfile(features) {
  const grouped = new Map();
  for (const f of features) {
    for (const r of f.raw_stats?.rounds || []) {
      if (!r?.seconds) continue;
      if (!grouped.has(r.round)) grouped.set(r.round, []);
      grouped.get(r.round).push(r);
    }
  }
  const rounds = {};
  for (const [roundNo, rows] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const sec = rows.reduce((a, r) => a + n(r.seconds), 0);
    const sigAtt = rows.reduce((a, r) => a + n(r.self?.sig_str_att), 0);
    const sigLand = rows.reduce((a, r) => a + n(r.self?.sig_str_landed), 0);
    const absorbed = rows.reduce((a, r) => a + n(r.opp?.sig_str_landed), 0);
    const boutCount = new Set(rows.map((r) => r.bout_id)).size;
    const conf = roundConfidence(boutCount, rows.length, sec);
    rounds[String(roundNo)] = {
      rounds: rows.length,
      seconds: sec,
      sig_att_per_min: metric({ key: `r${roundNo}_sig_attempts_per_min`, value: perMin(sigAtt, sec), unit: 'per_min', numerator: sigAtt, denominator: sec, sampleBouts: boutCount, sampleRounds: rows.length, sampleSeconds: sec, confidence: conf }),
      sig_landed_per_min: metric({ key: `r${roundNo}_sig_landed_per_min`, value: perMin(sigLand, sec), unit: 'per_min', numerator: sigLand, denominator: sec, sampleBouts: boutCount, sampleRounds: rows.length, sampleSeconds: sec, confidence: conf }),
      absorbed_per_min: metric({ key: `r${roundNo}_sig_absorbed_per_min`, value: perMin(absorbed, sec), unit: 'per_min', numerator: absorbed, denominator: sec, sampleBouts: boutCount, sampleRounds: rows.length, sampleSeconds: sec, confidence: conf }),
    };
  }
  const r1 = rounds['1']?.sig_att_per_min?.value;
  const r2 = rounds['2']?.sig_att_per_min?.value;
  const r3 = rounds['3']?.sig_att_per_min?.value;
  const r1Abs = rounds['1']?.absorbed_per_min?.value;
  const r3Abs = rounds['3']?.absorbed_per_min?.value;
  const lateRows = [rounds['4'], rounds['5']].filter(Boolean);
  const lateSec = lateRows.reduce((a, r) => a + r.seconds, 0);
  const lateAtt = lateRows.reduce((a, r) => a + (r.sig_att_per_min?.numerator || 0), 0);
  const earlyRows = [rounds['1'], rounds['2'], rounds['3']].filter(Boolean);
  const earlySec = earlyRows.reduce((a, r) => a + r.seconds, 0);
  const earlyAtt = earlyRows.reduce((a, r) => a + (r.sig_att_per_min?.numerator || 0), 0);
  const latePace = lateSec ? perMin(lateAtt, lateSec) : null;
  const earlyPace = earlySec ? perMin(earlyAtt, earlySec) : null;
  const statBouts = new Set(features.filter((f) => f.observed_seconds > 0).map((f) => f.bout_id)).size;
  const allRoundCount = Object.values(rounds).reduce((a, r) => a + r.rounds, 0);
  const allSec = Object.values(rounds).reduce((a, r) => a + r.seconds, 0);
  const baseConf = roundConfidence(statBouts, allRoundCount, allSec);
  return {
    rounds,
    pace_retention_r2_vs_r1: metric({ key: 'pace_retention_r2_vs_r1', value: r1 > 0 && r2 != null ? round4(r2 / r1) : null, unit: 'ratio', numerator: r2 ?? null, denominator: r1 ?? null, sampleBouts: statBouts, sampleRounds: (rounds['1']?.rounds || 0) + (rounds['2']?.rounds || 0), sampleSeconds: (rounds['1']?.seconds || 0) + (rounds['2']?.seconds || 0), confidence: r1 > 0 && r2 != null ? baseConf : 'insufficient' }),
    pace_retention_r3_vs_r1: metric({ key: 'pace_retention_r3_vs_r1', value: r1 > 0 && r3 != null ? round4(r3 / r1) : null, unit: 'ratio', numerator: r3 ?? null, denominator: r1 ?? null, sampleBouts: statBouts, sampleRounds: (rounds['1']?.rounds || 0) + (rounds['3']?.rounds || 0), sampleSeconds: (rounds['1']?.seconds || 0) + (rounds['3']?.seconds || 0), confidence: r1 > 0 && r3 != null ? baseConf : 'insufficient' }),
    championship_round_delta: metric({ key: 'championship_round_delta', value: latePace != null && earlyPace != null ? round4(latePace - earlyPace) : null, unit: 'per_min', numerator: latePace, denominator: earlyPace, sampleBouts: statBouts, sampleRounds: allRoundCount, sampleSeconds: allSec, confidence: latePace != null ? baseConf : 'insufficient' }),
    defensive_drift_r3_vs_r1: metric({ key: 'defensive_drift_r3_vs_r1', value: r1Abs != null && r3Abs != null ? round4(r3Abs - r1Abs) : null, unit: 'per_min', numerator: r3Abs, denominator: r1Abs, sampleBouts: statBouts, sampleRounds: (rounds['1']?.rounds || 0) + (rounds['3']?.rounds || 0), sampleSeconds: (rounds['1']?.seconds || 0) + (rounds['3']?.seconds || 0), confidence: r1Abs != null && r3Abs != null ? baseConf : 'insufficient' }),
  };
}

function buildSnapshot(fighter, features, runId, watermarks) {
  const record = recordOf(features);
  const wins = features.filter((f) => f.outcome === 'W');
  const losses = features.filter((f) => f.outcome === 'L');
  const koWins = wins.filter((f) => isKo(f.method));
  const subWins = wins.filter((f) => isSub(f.method));
  const finishWins = wins.filter((f) => isFinish(f.method));
  const koLosses = losses.filter((f) => isKo(f.method));
  const subLosses = losses.filter((f) => isSub(f.method));
  const finishLosses = losses.filter((f) => isFinish(f.method));
  const { statFeatures, self, opp, rounds, seconds } = aggregateRows(features);
  const statBouts = statFeatures.length;
  const roundConf = roundConfidence(statBouts, rounds, seconds);
  const resultConf = confidenceByBouts(record.appearances, { min: 1, medium: 5, high: 10 });

  const metrics = {};
  const add = (m) => { metrics[m.metric_key] = m; return m; };

  const finishRate = add(metric({ key: 'finish_rate', value: wins.length ? ratio(finishWins.length, wins.length) : null, unit: 'ratio', numerator: finishWins.length, denominator: wins.length, sampleBouts: wins.length, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: confidenceByBouts(wins.length, { min: 2, medium: 5, high: 10 }), coverage: wins.length ? 'high' : 'insufficient' }));
  const koFinishRate = add(metric({ key: 'ko_finish_rate', value: wins.length ? ratio(koWins.length, wins.length) : null, unit: 'ratio', numerator: koWins.length, denominator: wins.length, sampleBouts: wins.length, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: confidenceByBouts(wins.length, { min: 2, medium: 5, high: 10 }), coverage: wins.length ? 'high' : 'insufficient' }));
  const subFinishRate = add(metric({ key: 'submission_finish_rate', value: wins.length ? ratio(subWins.length, wins.length) : null, unit: 'ratio', numerator: subWins.length, denominator: wins.length, sampleBouts: wins.length, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: confidenceByBouts(wins.length, { min: 2, medium: 5, high: 10 }), coverage: wins.length ? 'high' : 'insufficient' }));
  const finishTimes = finishWins.map((f) => nullable(f.features?.finish_elapsed_sec)).filter((v) => v != null);
  const finishTimeMedian = add(metric({ key: 'finish_time_median_sec', value: median(finishTimes), unit: 'seconds', sampleBouts: finishTimes.length, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: confidenceByBouts(finishTimes.length), coverage: finishTimes.length ? 'high' : 'insufficient' }));

  const statMetrics = [
    ['sig_landed_per_min', perMin(self.sig_str_landed, seconds), 'per_min', self.sig_str_landed, seconds],
    ['sig_absorbed_per_min', perMin(opp.sig_str_landed, seconds), 'per_min', opp.sig_str_landed, seconds],
    ['sig_diff_per_min', seconds ? perMin(self.sig_str_landed - opp.sig_str_landed, seconds) : null, 'per_min', seconds ? self.sig_str_landed - opp.sig_str_landed : null, seconds || null],
    ['sig_accuracy', ratio(self.sig_str_landed, self.sig_str_att), 'ratio', self.sig_str_landed, self.sig_str_att],
    ['sig_defense', opp.sig_str_att ? round4(1 - opp.sig_str_landed / opp.sig_str_att) : null, 'ratio', opp.sig_str_att ? opp.sig_str_att - opp.sig_str_landed : null, opp.sig_str_att || null],
    ['head_attack_share', ratio(self.head_att, self.sig_str_att), 'ratio', self.head_att, self.sig_str_att],
    ['body_attack_share', ratio(self.body_att, self.sig_str_att), 'ratio', self.body_att, self.sig_str_att],
    ['leg_attack_share', ratio(self.leg_att, self.sig_str_att), 'ratio', self.leg_att, self.sig_str_att],
    ['distance_attack_share', ratio(self.distance_att, self.sig_str_att), 'ratio', self.distance_att, self.sig_str_att],
    ['clinch_attack_share', ratio(self.clinch_att, self.sig_str_att), 'ratio', self.clinch_att, self.sig_str_att],
    ['ground_attack_share', ratio(self.ground_att, self.sig_str_att), 'ratio', self.ground_att, self.sig_str_att],
    ['knockdowns_per_15', per15(self.kd, seconds), 'per_15', self.kd, seconds || null],
    ['knockdowns_absorbed_per_15', per15(opp.kd, seconds), 'per_15', opp.kd, seconds || null],
    ['td_attempts_per_15', per15(self.td_att, seconds), 'per_15', self.td_att, seconds || null],
    ['td_landed_per_15', per15(self.td_landed, seconds), 'per_15', self.td_landed, seconds || null],
    ['td_accuracy', ratio(self.td_landed, self.td_att), 'ratio', self.td_landed, self.td_att],
    ['control_seconds_per_td', self.td_landed ? round4(self.ctrl_sec / self.td_landed) : null, 'seconds_per_td', self.ctrl_sec, self.td_landed || null],
    ['control_share', seconds ? round4(self.ctrl_sec / seconds) : null, 'ratio', self.ctrl_sec, seconds || null],
    ['sub_attempts_per_15', per15(self.sub_att, seconds), 'per_15', self.sub_att, seconds || null],
    ['reversals_per_15', per15(self.rev, seconds), 'per_15', self.rev, seconds || null],
  ];
  for (const [key, value, unit, numerator, denominator] of statMetrics) {
    add(metric({ key, value, unit, numerator, denominator, sampleBouts: statBouts, sampleRounds: rounds, sampleSeconds: seconds, confidence: roundConf }));
  }

  const roundProfile = buildRoundProfile(features);
  for (const k of ['pace_retention_r2_vs_r1', 'pace_retention_r3_vs_r1', 'championship_round_delta', 'defensive_drift_r3_vs_r1']) add(roundProfile[k]);
  for (const r of Object.values(roundProfile.rounds)) {
    if (r.sig_att_per_min) add(r.sig_att_per_min);
  }

  const dist = (rows) => {
    const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const f of rows) if (Number.isFinite(Number(f.features?.finish_round))) buckets[String(f.features.finish_round)] = (buckets[String(f.features.finish_round)] || 0) + 1;
    return { total: rows.length, buckets };
  };
  const finishRoundDist = metric({ key: 'finish_round_distribution', value: dist(finishWins), unit: 'distribution', numerator: finishWins.length, denominator: wins.length, sampleBouts: finishWins.length, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: confidenceByBouts(finishWins.length), coverage: finishWins.length ? 'high' : 'insufficient' });
  const finishedByRoundDist = metric({ key: 'finished_by_round_distribution', value: dist(finishLosses), unit: 'distribution', numerator: finishLosses.length, denominator: losses.length, sampleBouts: finishLosses.length, sampleRounds: rounds, sampleSeconds: seconds, sourceFamilies: ['espn', 'ufcstats'], confidence: confidenceByBouts(finishLosses.length), coverage: finishLosses.length ? 'high' : 'insufficient' });
  add(finishRoundDist); add(finishedByRoundDist);

  const finishProfile = {
    finish_rate: finishRate,
    ko_finish_rate: koFinishRate,
    submission_finish_rate: subFinishRate,
    finish_time_median_sec: finishTimeMedian,
    finish_round_distribution: finishRoundDist,
    finished_by_round_distribution: finishedByRoundDist,
    finished_by: { ko_tko: koLosses.length, submission: subLosses.length },
  };

  const explicitStances = ['ORTHODOX', 'SOUTHPAW', 'SWITCH', 'SIDEWAYS', 'UNKNOWN'];
  const stanceSplits = {};
  for (const s of explicitStances) stanceSplits[s] = aggregateSplit(features.filter((f) => f.opponent_stance === s), 'stance');
  stanceSplits.open = aggregateSplit(features.filter((f) => f.stance_context === 'open'), 'open_stance');
  stanceSplits.same = aggregateSplit(features.filter((f) => f.stance_context === 'same'), 'same_stance');

  const contextSplits = {
    three_round: aggregateSplit(features.filter((f) => f.scheduled_rounds === 3), 'three_round'),
    five_round: aggregateSplit(features.filter((f) => f.scheduled_rounds === 5), 'five_round'),
    title: aggregateSplit(features.filter((f) => f.is_title), 'title_bout'),
    main_event: aggregateSplit(features.filter((f) => f.is_main_event), 'main_event'),
    short_notice: aggregateSplit(features.filter((f) => f.short_notice_days != null), 'short_notice'),
  };

  return {
    fighter_id: fighter.id,
    as_of_date: AS_OF,
    definition_version: DEFINITION_VERSION,
    sample_bouts: features.length,
    sample_completed_bouts: record.appearances,
    sample_stat_bouts: statBouts,
    sample_rounds: rounds,
    sample_seconds: seconds,
    coverage_status: coverageStatus(statBouts, rounds, seconds),
    metrics,
    stance_splits: stanceSplits,
    round_profile: roundProfile,
    finish_profile: finishProfile,
    context_splits: contextSplits,
    position_profile: {},
    archetype: null,
    provenance: {
      builder: BUILDER,
      build_run_id: runId,
      fighter_stance: stance(fighter.stance),
      record,
      bouts: features.map((f) => f.bout_id),
      watermark: { bouts: features.length, ...watermarks },
    },
    generated_at: new Date().toISOString(),
  };
}

async function main() {
  const started = Date.now();
  console.log(`Fight DNA builder ${BUILDER} as_of=${AS_OF}${ONLY_FIGHTER ? ` fighter=${ONLY_FIGHTER}` : ''}${DRY_RUN ? ' [DRY]' : ''}`);

  /* NO ROW CAPS, AND AN EXPLICIT ORDER.
   *
   * These three queries carried `limit=5000`, `limit=5000` and `limit=10000`
   * while the tables hold 9,348 completed bouts, 9,344 results and 41,542 round
   * rows. selectAll pages with Range headers, but a limit in the query string
   * caps the TOTAL, so paging stopped at the cap: Fight DNA was being computed
   * from roughly a quarter of the round archive. That is the reason so many
   * snapshots report low coverage on small samples.
   *
   * Worse, there was no ORDER BY. Which rows survived a cap was whatever the
   * planner returned, so the build was not deterministic either -- two runs
   * over identical data could disagree. The order clauses are here for that
   * reason as much as for the paging: a stable sort is what makes Range paging
   * correct in the first place.
   */
  const [fighters, events, bouts, results, roundStats] = await Promise.all([
    selectAll('ufc_fighters', 'select=id,name,stance&order=name.asc'),
    selectAll('ufc_events', `select=id,name,event_date&event_date=lte.${AS_OF}&order=event_date.asc`),
    selectAll('ufc_bouts', 'select=id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,scheduled_rounds,is_title,card_position,bout_order,status,short_notice_days,captured_at,updated_at&status=eq.complete&order=id'),
    selectAll('ufc_bout_results', 'select=bout_id,winner_id,method,method_raw,round,time_sec,time_format,result_source,has_stats,source_url,captured_at,stats_source_url,stats_captured_at&order=bout_id'),
    selectAll('ufc_bout_round_stats', `select=bout_id,fighter_id,round,${ROUND_KEYS.join(',')},source_url,captured_at&order=bout_id,fighter_id,round`),
  ]);

  const eventMap = new Map(events.map((e) => [e.id, e]));
  const fighterMap = new Map(fighters.map((f) => [f.id, f]));
  const resultMap = new Map(results.map((r) => [r.bout_id, r]));
  const statsByBout = new Map();
  for (const r of roundStats) {
    if (!statsByBout.has(r.bout_id)) statsByBout.set(r.bout_id, []);
    statsByBout.get(r.bout_id).push(r);
  }

  const relevantBouts = bouts.filter((b) => {
    const e = eventMap.get(b.event_id);
    return e?.event_date && e.event_date <= AS_OF && fighterMap.has(b.fighter_a_id) && fighterMap.has(b.fighter_b_id) && (!ONLY_FIGHTER || b.fighter_a_id === ONLY_FIGHTER || b.fighter_b_id === ONLY_FIGHTER);
  });
  const maxOrderByEvent = new Map();
  for (const b of relevantBouts) maxOrderByEvent.set(b.event_id, Math.max(maxOrderByEvent.get(b.event_id) || 0, n(b.bout_order)));

  const maxTs = (rows, keys) => {
    let max = null;
    for (const row of rows) for (const k of keys) if (row[k] && (!max || String(row[k]) > max)) max = String(row[k]);
    return max;
  };
  const watermarks = {
    stats_captured_at: maxTs(results, ['stats_captured_at']),
    results_captured_at: maxTs(results, ['captured_at']),
    round_stats_captured_at: maxTs(roundStats, ['captured_at']),
  };
  const sourceCounts = {
    watermark: watermarks,
    input_counts: { fighters: fighters.length, events: events.length, bouts: relevantBouts.length, results: results.length, round_rows: roundStats.length, stat_bouts: statsByBout.size },
  };
  const runId = await startRun(sourceCounts);

  try {
    const featureRows = [];
    for (const b of relevantBouts) {
      const event = eventMap.get(b.event_id);
      const result = resultMap.get(b.id) || null;
      const boutStats = statsByBout.get(b.id) || [];
      const sides = [
        [b.fighter_a_id, b.fighter_b_id],
        [b.fighter_b_id, b.fighter_a_id],
      ];

      for (const [fighterId, opponentId] of sides) {
        if (ONLY_FIGHTER && fighterId !== ONLY_FIGHTER) continue;
        const fighter = fighterMap.get(fighterId);
        const opponent = fighterMap.get(opponentId);
        const selfRows = boutStats.filter((r) => r.fighter_id === fighterId).sort((a, c) => a.round - c.round);
        const oppRows = boutStats.filter((r) => r.fighter_id === opponentId).sort((a, c) => a.round - c.round);
        const oppByRound = new Map(oppRows.map((r) => [r.round, r]));
        const self = emptyTotals(), opp = emptyTotals();
        const roundRows = [];
        for (const row of selfRows) {
          const sec = roundSeconds(Number(row.round), result);
          if (sec <= 0) continue;
          const o = oppByRound.get(row.round) || null;
          addTotals(self, row);
          if (o) addTotals(opp, o);
          self.rounds++; self.seconds += sec;
          if (o) { opp.rounds++; opp.seconds += sec; }
          roundRows.push({ bout_id: b.id, round: Number(row.round), seconds: sec, self: Object.fromEntries(ROUND_KEYS.map((k) => [k, n(row[k])])), opp: Object.fromEntries(ROUND_KEYS.map((k) => [k, n(o?.[k])])) });
        }
        const pairedRounds = roundRows.filter((r) => oppByRound.has(r.round)).length;
        const observedSeconds = selfRows.length ? self.seconds : null;
        const expectedRounds = result?.round ? Number(result.round) : null;
        let statsCoverage = 'none';
        if (selfRows.length) statsCoverage = expectedRounds && selfRows.length >= expectedRounds && pairedRounds >= expectedRounds ? 'complete' : 'partial';
        const fv = featureValues(self, opp, roundRows);
        const finishElapsed = isFinish(result?.method) ? resultFightSeconds(result) : null;
        const features = { ...fv, finish_round: isFinish(result?.method) ? nullable(result?.round) : null, finish_elapsed_sec: finishElapsed };
        const fs = stance(fighter?.stance), os = stance(opponent?.stance);
        const sources = [...new Set([result?.result_source || null, selfRows.length ? 'ufcstats' : null].filter(Boolean))];

        featureRows.push({
          fighter_id: fighterId,
          bout_id: b.id,
          event_id: b.event_id,
          opponent_id: opponentId,
          event_date: event.event_date,
          feature_version: FEATURE_VERSION,
          fighter_stance: fs,
          opponent_stance: os,
          stance_context: stanceContext(fs, os),
          outcome: resultOutcome(result, fighterId, opponentId),
          method: result?.method || null,
          scheduled_rounds: nullable(b.scheduled_rounds),
          is_title: Boolean(b.is_title),
          is_main_event: n(b.bout_order) === maxOrderByEvent.get(b.event_id),
          short_notice_days: nullable(b.short_notice_days),
          round_rows: selfRows.length,
          observed_seconds: observedSeconds,
          stats_coverage: statsCoverage,
          raw_stats: {
            time: {
              ending_round: nullable(result?.round), ending_time_sec: nullable(result?.time_sec), fight_seconds: resultFightSeconds(result),
              time_format: result?.time_format || null, fought_rounds: nullable(result?.round), paired_rounds: roundRows.filter((r) => oppByRound.has(r.round)).map((r) => r.round),
            },
            rounds: roundRows,
            totals: compactTotals(self),
            opp_totals: compactTotals(opp),
          },
          features,
          provenance: {
            builder: BUILDER,
            sources,
            result_source: result?.result_source || null,
            result_source_url: result?.source_url || null,
            round_source_url: selfRows.find((r) => r.source_url)?.source_url || null,
            watermark: {
              results_captured_at: result?.captured_at || null,
              stats_captured_at: result?.stats_captured_at || null,
              round_stats_captured_at: selfRows.reduce((max, r) => !max || String(r.captured_at) > max ? String(r.captured_at) : max, null),
            },
          },
          generated_at: new Date().toISOString(),
        });
      }
    }

    console.log(`feature rows=${featureRows.length}`);
    await writeBatch('ufc_fighter_bout_features', featureRows, 'fighter_id,bout_id,feature_version');

    const byFighter = new Map();
    for (const f of featureRows) {
      if (!byFighter.has(f.fighter_id)) byFighter.set(f.fighter_id, []);
      byFighter.get(f.fighter_id).push(f);
    }
    const targetFighters = ONLY_FIGHTER ? fighters.filter((f) => f.id === ONLY_FIGHTER) : fighters;
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

    console.log(`snapshots=${snapshots.length} stance rows=${stanceRows.length}`);
    await writeBatch('ufc_fighter_dna_snapshots', snapshots, 'fighter_id,as_of_date,definition_version', 100);
    await writeBatch('ufc_fighter_stance_splits', stanceRows, 'fighter_id,as_of_date,opponent_stance,definition_version', 150);

    const output = {
      feature_rows: featureRows.length,
      snapshots: snapshots.length,
      stance_rows: stanceRows.length,
      stat_snapshots: snapshots.filter((s) => s.sample_stat_bouts > 0).length,
      stat_bouts_in_snapshots: snapshots.reduce((a, s) => a + s.sample_stat_bouts, 0),
      round_rows_source: roundStats.length,
      elapsed_ms: Date.now() - started,
    };
    await finishRun(runId, 'success', output);
    const summary = { ok: true, build_run_id: runId, as_of: AS_OF, ...output };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } catch (error) {
    console.error(error);
    /* The run row is closed as failed before rethrowing, so a crashed build is
     * visible in ufc_dna_build_runs rather than leaving a row open forever. */
    try { await finishRun(runId, 'failed', {}, [], [String(error?.stack || error)]); } catch (e) { console.error(`failed to close build run: ${e.message}`); }
    throw error;
  }
}

/* CLI ONLY. Importing this module must never read a file or build anything. */
const isCli = typeof process !== 'undefined'
  && process.argv?.[1]?.replace(/\\/g, '/').endsWith('scripts/dna/build_fight_dna.mjs');
if (isCli) {
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const argv = process.argv.slice(2);
  const opt = (x) => { const i = argv.indexOf(x); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    await buildFightDna({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      asOf: opt('--as-of'),
      fighterId: opt('--fighter'),
      dry: argv.includes('--dry-run'),
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
