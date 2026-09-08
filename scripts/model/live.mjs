// Shared plumbing for the live prediction pipeline.
//
// Everything in this file is read-only. The three commands that use it -
// predict_upcoming, publish_predictions, grade_predictions - all default to a
// dry run and all require an explicit --apply to write anything at all.
//
// ONE RULE ABOUT WRITES
// ---------------------
// A dry run is only worth having if it exercises the same code as the real one.
// So the commands build the exact rows they would send, print them, and stop
// before the request. They do not take a different branch that skips half the
// work and prints an optimistic summary, because that would make the dry run a
// rehearsal of a different play.

import fs from 'node:fs';
import path from 'node:path';
import { rest, cacheDir, readJsonl, ROOT, round } from './common.mjs';
import { predictOne } from './logistic.mjs';
import { FEATURE_KEYS } from './feature_spec.mjs';
import { marketProbForRow } from './market_baseline.mjs';

export const ARTIFACT_PATH = path.join(ROOT, 'web', 'lib', 'generated', 'model-v1.json');

export function loadArtifact() {
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error(`release artifact missing: ${ARTIFACT_PATH}\nRun: node scripts/model/train_release.mjs`);
  }
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
}

export const argv = process.argv.slice(2);
export const flag = (k) => argv.includes(k);
export const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

export const BAND = (p) => {
  const c = Math.max(p, 1 - p);
  return c < 0.55 ? '50-55' : c < 0.6 ? '55-60' : c < 0.65 ? '60-65' : c < 0.7 ? '65-70' : c < 0.8 ? '70-80' : '80-100';
};

/** The schema's lock cutoff, mirrored here so a command can explain itself
 *  before touching the database. The database enforces it regardless; this is
 *  for the operator, not for safety. */
export const lockCutoff = (eventDate) => new Date(`${eventDate}T00:00:00Z`);

export const hoursUntil = (when, from = new Date()) => (when.getTime() - from.getTime()) / 3600000;

/**
 * Score an upcoming bout from the cached, audited feature dataset.
 *
 * The features come from the SAME builder that produced the backtest, over the
 * same as-of Fight DNA snapshots, with the same leakage checks applied. That is
 * the point: a live prediction that was assembled by a second, subtly different
 * code path would inherit none of the evidence the backtest provides.
 */
export function scoreRow(row, artifact, observationsByBout) {
  const beta = FEATURE_KEYS.map((k) => artifact.model.coefficients[k]);
  const scale = FEATURE_KEYS.map((k) => artifact.model.feature_scale[k]);
  const p1 = predictOne(row.x, beta, scale);

  // The market snapshot is taken at prediction time and compared afterwards.
  // Everything observed so far is fair game for an upcoming bout; the cutoff
  // exists so the same function can be reused on historical rows without
  // quietly reading a closing line.
  const market = marketProbForRow(row, observationsByBout, new Date().toISOString());

  const pick1 = p1 >= 0.5;
  const pickProb = Math.max(p1, 1 - p1);
  const marketPick = market == null ? null : (pick1 ? market.p : 1 - market.p);

  return {
    bout_id: row.bout_id,
    event_id: row.event_id,
    event_date: row.event_date,
    event_name: row.event_name,
    weight_class: row.weight_class,
    is_womens: row.is_womens,
    is_title: row.is_title,
    scheduled_rounds: row.scheduled_rounds,
    card_position: row.card_position,
    bout_status: row.bout_status,

    fighter_1_id: row.fighter_1_id,
    fighter_2_id: row.fighter_2_id,
    fighter_1_name: row.fighter_1_name,
    fighter_2_name: row.fighter_2_name,
    prob_1: round(p1, 8),
    prob_2: round(1 - p1, 8),

    pick_fighter_id: pick1 ? row.fighter_1_id : row.fighter_2_id,
    pick_fighter_name: pick1 ? row.fighter_1_name : row.fighter_2_name,
    pick_probability: round(pickProb, 8),
    confidence_band: BAND(p1),

    market_implied_prob_pick: marketPick == null ? null : round(marketPick, 8),
    market_books: market?.books ?? null,
    model_edge_pts: marketPick == null ? null : round((pickProb - marketPick) * 100, 2),

    feature_vector: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, row.x[i]])),
    feature_availability: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, Boolean(row.available[i])])),
    sample_context: {
      min_prior_bouts: row.min_prior_bouts,
      min_stat_bouts: row.min_stat_bouts,
      features_available: row.available_count,
      features_total: FEATURE_KEYS.length,
      corner_1: { prior_bouts: row.side_1.prior_bouts, stat_bouts: row.side_1.stat_bouts, coverage: row.side_1.coverage_status, snapshot_as_of: row.side_1.snapshot_as_of },
      corner_2: { prior_bouts: row.side_2.prior_bouts, stat_bouts: row.side_2.stat_bouts, coverage: row.side_2.coverage_status, snapshot_as_of: row.side_2.snapshot_as_of },
    },
  };
}

/** Upcoming, ungraded, dated bouts from the cached dataset. */
export function upcomingRows({ from = new Date().toISOString().slice(0, 10), until = null } = {}) {
  const cache = cacheDir();
  const rows = readJsonl(path.join(cache, 'dataset.jsonl'));
  return rows
    .filter((r) => !r.graded && r.event_date >= from && (!until || r.event_date <= until))
    .filter((r) => r.bout_status !== 'cancelled')
    .sort((a, b) => (a.event_date === b.event_date ? (b.bout_order ?? 0) - (a.bout_order ?? 0) : a.event_date.localeCompare(b.event_date)));
}

export function marketIndex() {
  const cache = cacheDir();
  const byBout = new Map();
  for (const o of readJsonl(path.join(cache, 'market.jsonl'))) {
    if (!byBout.has(o.bout_id)) byBout.set(o.bout_id, []);
    byBout.get(o.bout_id).push(o);
  }
  return byBout;
}

export function cacheAge() {
  const file = path.join(cacheDir(), 'manifest.json');
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { extracted_at: m.extracted_at, hours: (Date.now() - Date.parse(m.extracted_at)) / 3600000 };
}

/**
 * Does the model registered in the database match the artifact on disk?
 *
 * The point of the spec hash is exactly this comparison. Publishing picks
 * produced by coefficients that differ from the registered ones would make the
 * stored model_version a lie, and it is the sort of drift nobody notices
 * because both halves look fine on their own.
 */
export async function checkRegisteredModel(artifact) {
  const db = rest();
  try {
    const rows = await db.selectAll(
      'ufc_model_versions',
      `?select=model_version,status,spec_sha256,feature_version&model_version=eq.${encodeURIComponent(artifact.model.model_version)}`,
    );
    if (!rows.length) {
      return { ok: false, reason: `model_version ${artifact.model.model_version} is not registered in ufc_model_versions`, registered: null };
    }
    const r = rows[0];
    if (r.spec_sha256 !== artifact.model.spec_sha256) {
      return { ok: false, reason: `registered spec_sha256 ${r.spec_sha256} does not match the artifact ${artifact.model.spec_sha256}`, registered: r };
    }
    if (r.status !== 'live') {
      return { ok: false, reason: `model_version ${r.model_version} has status "${r.status}"; only a live version may publish`, registered: r };
    }
    return { ok: true, reason: null, registered: r };
  } catch (e) {
    const missing = /HTTP 404/.test(String(e.message));
    return {
      ok: false,
      missing,
      reason: missing
        ? 'ufc_model_versions does not exist: migration 011 has not been applied to this project'
        : `could not read ufc_model_versions: ${e.message}`,
      registered: null,
    };
  }
}

/** Pretty one-line summary of a scored bout, for the dry-run tables. */
export function line(p) {
  const names = `${p.fighter_1_name} vs ${p.fighter_2_name}`;
  return [
    p.event_date,
    names.length > 42 ? names.slice(0, 41) + '…' : names.padEnd(42),
    `${(p.prob_1 * 100).toFixed(1)}%`.padStart(6),
    `${(p.prob_2 * 100).toFixed(1)}%`.padStart(6),
    (p.pick_fighter_name || '').slice(0, 22).padEnd(22),
    p.confidence_band.padStart(6),
    p.model_edge_pts == null ? '     —' : `${p.model_edge_pts >= 0 ? '+' : ''}${p.model_edge_pts.toFixed(1)}`.padStart(6),
    `${p.sample_context.min_prior_bouts}/${p.sample_context.min_stat_bouts}`.padStart(6),
  ].join('  ');
}

export const LINE_HEADER = [
  'date      ',
  'bout'.padEnd(42),
  ' corner1',
  'corner2',
  'pick'.padEnd(22),
  ' band ',
  '  edge',
  ' prior/stat',
].join('  ');
