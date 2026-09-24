// Phase 3 extract: READ-ONLY pull of the historical tables the backtest needs,
// into workers/ufc-simulator/.cache/phase3 (gitignored). GET requests only.
//
// Snapshots are resolved per (fighter, event_date) as the latest row with
// as_of_date <= event_date, then validated against the exclusive cutoff; a
// snapshot that lists a bout dated >= its as_of (the 8 contaminated
// 2026-09-19 rows, or anything else) is replaced by the previous one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.SIM_PHASE3_CACHE || path.join(ROOT, '.cache', 'phase3');
fs.mkdirSync(CACHE, { recursive: true });

const envFile = process.env.UFC_ENV_FILE || 'D:/Workers/secrets/ufc-propbetedge.env';
const env = { ...process.env };
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] ||= line.slice(i + 1).trim(); }
const URL_ = env.SUPABASE_URL.replace(/\/$/, '');
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

async function get(pathq) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${URL_}/rest/v1/${pathq}`, { headers: H, method: 'GET' });
    if (r.ok) return r.json();
    if (r.status >= 500 || r.status === 429) { await new Promise((z) => setTimeout(z, 1000 * (attempt + 1))); continue; }
    throw new Error(`${r.status} ${pathq.slice(0, 120)} ${await r.text()}`);
  }
  throw new Error('retries exhausted ' + pathq.slice(0, 120));
}
async function all(pathq, page = 1000) {
  const out = [];
  for (let off = 0; ; off += page) {
    const rows = await get(`${pathq}&offset=${off}&limit=${page}`);
    out.push(...rows);
    if (rows.length < page) return out;
  }
}
const save = (name, data) => { fs.writeFileSync(path.join(CACHE, name), JSON.stringify(data)); console.log(name, Array.isArray(data) ? data.length : Object.keys(data).length); };
const have = (name) => fs.existsSync(path.join(CACHE, name));
const load = (name) => JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'));

const t0 = Date.now();
if (!have('events.json')) save('events.json', await all('ufc_events?select=id,name,event_date,event_series&order=id'));
if (!have('bouts.json')) save('bouts.json', await all('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,weight_class,is_womens,is_title,scheduled_rounds,status,model_scope&order=id'));
if (!have('results.json')) save('results.json', await all('ufc_bout_results?select=bout_id,winner_id,method,round,time_sec,time_format,has_stats,scorecards&order=bout_id'));
if (!have('round_stats.json')) save('round_stats.json', await all('ufc_bout_round_stats?select=bout_id,fighter_id,round,kd,sig_str_landed,sig_str_att,total_str_landed,total_str_att,td_landed,td_att,sub_att,rev,ctrl_sec,head_landed,head_att,body_landed,body_att,leg_landed,leg_att,distance_landed,distance_att,clinch_landed,clinch_att,ground_landed,ground_att&order=bout_id,fighter_id,round'));
if (!have('fighters.json')) save('fighters.json', await all('ufc_fighters?select=id,name,dob,height_in,reach_in,stance&order=id'));
if (!have('bout_features.json')) save('bout_features.json', await all('ufc_fighter_bout_features?select=fighter_id,bout_id,opponent_id,event_date,outcome,method,scheduled_rounds,stats_coverage,round_rows,observed_seconds,opp_totals:raw_stats->opp_totals,totals:raw_stats->totals&feature_version=eq.1&order=fighter_id,event_date,bout_id'));
if (!have('snapshot_index.json')) save('snapshot_index.json', await all('ufc_fighter_dna_snapshots?select=fighter_id,as_of_date,coverage_status,sample_stat_bouts,generated_at&definition_version=eq.1&order=fighter_id,as_of_date'));

// Resolve the snapshot each cohort corner needs (latest as_of <= D), fetch those rows, validate, fall back.
const events = new Map(load('events.json').map((e) => [e.id, e]));
const boutsAll = load('bouts.json');
const boutDate = new Map(boutsAll.map((b) => [b.id, events.get(b.event_id)?.event_date || null]));
const idx = new Map();
for (const s of load('snapshot_index.json')) { if (!idx.has(s.fighter_id)) idx.set(s.fighter_id, []); idx.get(s.fighter_id).push(s.as_of_date); }
for (const arr of idx.values()) arr.sort();
const latestAtOrBefore = (fid, D, skip = new Set()) => { const arr = idx.get(fid) || []; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] <= D && !skip.has(arr[i])) return arr[i]; return null; };

const cohortBouts = boutsAll.filter((b) => b.status === 'complete' && b.model_scope && (boutDate.get(b.id) || '') >= '2015-01-01');
const need = new Map(); // key fighter|as_of -> true
const want = [];
for (const b of cohortBouts) {
  const D = boutDate.get(b.id);
  for (const fid of [b.fighter_a_id, b.fighter_b_id]) { const d = latestAtOrBefore(fid, D); if (d) { need.set(`${fid}|${d}`, { fid, d }); want.push({ bout_id: b.id, fid, D, as_of: d }); } else want.push({ bout_id: b.id, fid, D, as_of: null }); }
}
console.log('cohort candidate bouts', cohortBouts.length, 'snapshot rows to fetch', need.size);
const SNAP_COLS = 'fighter_id,as_of_date,definition_version,sample_bouts,sample_completed_bouts,sample_stat_bouts,sample_rounds,sample_seconds,coverage_status,metrics,round_profile,finish_profile,provenance';
const snapFile = path.join(CACHE, 'snapshots_resolved.json');
const snaps = fs.existsSync(snapFile) ? load('snapshots_resolved.json') : {};
async function fetchKeys(keys) {
  const CH = 40;
  for (let i = 0; i < keys.length; i += CH) {
    const part = keys.slice(i, i + CH).filter((k) => !snaps[k]);
    if (!part.length) continue;
    const or = part.map((k) => { const [fid, d] = k.split('|'); return `and(fighter_id.eq.${fid},as_of_date.eq.${d})`; }).join(',');
    const rows = await get(`ufc_fighter_dna_snapshots?select=${SNAP_COLS}&definition_version=eq.1&or=(${or})&limit=${CH * 2}`);
    for (const r of rows) snaps[`${r.fighter_id}|${r.as_of_date}`] = r;
    if ((i / CH) % 25 === 0) { fs.writeFileSync(snapFile, JSON.stringify(snaps)); console.log('snapshots fetched', Object.keys(snaps).length, 'of', keys.length, Math.round((Date.now() - t0) / 1000) + 's'); }
  }
  fs.writeFileSync(snapFile, JSON.stringify(snaps));
}
await fetchKeys([...need.keys()]);

// Validate the exclusive cutoff against every bout date we know; fall back to the previous snapshot when violated.
const violates = (row) => (row.provenance?.bouts || []).some((bid) => { const d = boutDate.get(bid); return d && d >= row.as_of_date; });
let fallbacks = 0, unresolved = 0;
for (let pass = 0; pass < 3; pass++) {
  const extra = [];
  for (const w of want) {
    if (!w.as_of) continue;
    const row = snaps[`${w.fid}|${w.as_of}`];
    if (!row) { unresolved++; continue; }
    if (violates(row)) {
      const skip = new Set([w.as_of, ...(w.rejected || [])]);
      w.rejected = [...skip];
      const prev = latestAtOrBefore(w.fid, w.D, skip);
      w.as_of = prev;
      if (prev) extra.push(`${w.fid}|${prev}`);
      fallbacks++;
    }
  }
  if (!extra.length) break;
  await fetchKeys([...new Set(extra)]);
}
console.log('fallbacks applied', fallbacks, 'unresolved rows', unresolved);
save('resolution.json', want);
console.log('done in', Math.round((Date.now() - t0) / 1000), 's');
