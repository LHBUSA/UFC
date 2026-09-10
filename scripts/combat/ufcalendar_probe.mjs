#!/usr/bin/env node
// Read-only evaluation probe for UFCalendar Fight API.
//
// This script NEVER writes Supabase and NEVER bulk-crawls the provider. It is
// intentionally bounded to one fighter and at most two requests so we can
// evaluate schema/coverage under a trial or paid account before changing
// combat_sources.ufcalendar from review_required.
//
// Usage:
//   UFCAL_KEY=... node scripts/combat/ufcalendar_probe.mjs --slug islam-makhachev
//   UFCAL_KEY=... node scripts/combat/ufcalendar_probe.mjs --slug kayla-harrison --json /tmp/ufcal-eval.json
//
// The optional JSON report contains derived coverage/schema observations only,
// not a raw provider dataset.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.ufcalendar.com/v1';
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};

const slug = String(arg('--slug', '') || '').trim();
const key = process.env.UFCAL_KEY || process.env.UFCALENDAR_API_KEY || '';
if (!slug) {
  console.error('usage: UFCAL_KEY=... node scripts/combat/ufcalendar_probe.mjs --slug <fighter-slug> [--json report.json]');
  process.exit(2);
}
if (!key) {
  console.error('UFCAL_KEY / UFCALENDAR_API_KEY is not set');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
  console.error('fighter slug contains unsupported characters');
  process.exit(2);
}

let requestCount = 0;
async function get(endpoint) {
  if (++requestCount > 2) throw new Error('evaluation request cap exceeded');
  const r = await fetch(`${API}${endpoint}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'PropBetEdge-UFCalendar-Evaluation/1.0' },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* report status below */ }
  if (!r.ok) throw new Error(`${endpoint} -> ${r.status} ${body?.error?.message || body?.message || text.slice(0, 160)}`);
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'data')) throw new Error(`${endpoint} -> response lacks data envelope`);
  return body;
}

const scalarKeys = (v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.entries(v).filter(([, x]) => x == null || ['string','number','boolean'].includes(typeof x)).map(([k]) => k).sort()
  : [];
const objectKeys = (v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort() : [];

function flattenHistory(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of ['history','fights','bouts','career','career_history','results']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

function first(v, keys) {
  if (!v || typeof v !== 'object') return null;
  for (const k of keys) if (v[k] != null && v[k] !== '') return v[k];
  return null;
}

function promotionName(row) {
  const direct = first(row, ['org','organization','promotion','promotion_name','league']);
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') return first(direct, ['slug','name','title']) || 'unknown';
  const event = row?.event;
  if (event && typeof event === 'object') {
    const nested = first(event, ['org','organization','promotion','promotion_name']);
    if (typeof nested === 'string') return nested;
    if (nested && typeof nested === 'object') return first(nested, ['slug','name','title']) || 'unknown';
  }
  return 'unknown';
}

function historySummary(body) {
  const rows = flattenHistory(body?.data);
  const promotions = new Map();
  let withStableFightId = 0;
  let withEvent = 0;
  let withResult = 0;
  let withOpponent = 0;
  let withDate = 0;
  for (const row of rows) {
    const promotion = String(promotionName(row) || 'unknown');
    promotions.set(promotion, (promotions.get(promotion) || 0) + 1);
    if (first(row, ['id','fight_id','bout_id','external_id']) != null) withStableFightId++;
    if (first(row, ['event','event_id','event_slug','event_name']) != null) withEvent++;
    if (first(row, ['result','outcome','winner','winner_fighter_id','method']) != null) withResult++;
    if (first(row, ['opponent','opponent_id','opponent_name','fighter_a','fighter_b']) != null) withOpponent++;
    if (first(row, ['date','event_date','starts_at','completed_at']) != null) withDate++;
  }
  return {
    rows: rows.length,
    row_keys: rows[0] ? objectKeys(rows[0]) : [],
    promotion_counts: Object.fromEntries([...promotions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    fields_present: { with_stable_fight_id: withStableFightId, with_event: withEvent, with_result: withResult, with_opponent: withOpponent, with_date: withDate },
  };
}

try {
  const [fighter, history] = await Promise.all([
    get(`/fighters/${encodeURIComponent(slug)}`),
    get(`/fighters/${encodeURIComponent(slug)}/history`),
  ]);
  const h = historySummary(history);
  const f = fighter?.data;
  const report = {
    generated_at: new Date().toISOString(),
    provider: 'ufcalendar',
    mode: 'read_only_single_fighter_evaluation',
    requests: requestCount,
    fighter_slug: slug,
    fighter: {
      top_level_keys: objectKeys(f),
      scalar_keys: scalarKeys(f),
      provider_id_present: first(f, ['id','fighter_id','slug']) != null,
      name_present: first(f, ['name','full_name','display_name']) != null,
      dob_present: first(f, ['dob','date_of_birth','birth_date']) != null,
      image_metadata_present: ['image','images','image_url','photo','photo_url'].some((k) => f?.[k] != null),
      career_scope_present: Array.isArray(f?.career_stats) && f.career_stats.some((s) => s?.scope === 'pro-mma'),
    },
    history: h,
    evaluation: {
      has_multi_promotion_history: Object.keys(h.promotion_counts).filter((p) => p !== 'ufc' && p !== 'unknown').length > 0,
      stable_ids_coverage_pct: h.rows ? Number(((h.fields_present.with_stable_fight_id / h.rows) * 100).toFixed(1)) : 0,
      result_coverage_pct: h.rows ? Number(((h.fields_present.with_result / h.rows) * 100).toFixed(1)) : 0,
      event_coverage_pct: h.rows ? Number(((h.fields_present.with_event / h.rows) * 100).toFixed(1)) : 0,
      opponent_coverage_pct: h.rows ? Number(((h.fields_present.with_opponent / h.rows) * 100).toFixed(1)) : 0,
      date_coverage_pct: h.rows ? Number(((h.fields_present.with_date / h.rows) * 100).toFixed(1)) : 0,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  const out = arg('--json');
  if (out) {
    const dest = path.resolve(String(out));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`);
  }
} catch (e) {
  console.error(`UFCalendar evaluation failed: ${e?.message || e}`);
  process.exit(1);
}
