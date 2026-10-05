/* Fight DNA division context — where a fighter's stored DNA sits inside their division.
 *
 * Runs once per day after a successful full Fight DNA build. It ORDERS stored
 * snapshot values; it never computes a metric, never fills a missing one, and
 * never publishes a value: the document holds ranks and population sizes only
 * (values are UFC Pro; a rank is a summary of them).
 *
 * Population for a (division, metric):
 *   - the fighter is active (ufc_fighters.is_active),
 *   - the latest snapshot at the build's as-of has sample_completed_bouts >= 3,
 *   - the metric is a MetricObject with a numeric value and medium/high confidence,
 *   - the fighter's division is known.
 * Division = the official ranked division (scripts/rankings DIVISIONS) of the
 * fighter's most recent completed, model-scope UFC bout dated before as-of.
 * Catchweight / openweight bouts say nothing about a division, so they are
 * skipped and the most recent bout in a ranked division decides; a fighter
 * with none is left out.
 * Rank 1 is best in the metric's `better` direction; ties break on fighter id.
 *
 * Stored privately (bucket ufc-internal, never public) at
 *   dna/division-context/latest.json and dna/division-context/<as_of>.json */
import { DIVISIONS } from '../../../scripts/rankings/ingest_rankings.mjs';

export const MIN_CONFIDENCE = 'medium';
export const MIN_COMPLETED_BOUTS = 3;
export const BUCKET = 'ufc-internal';
export const PREFIX = 'dna/division-context';

/* key -> [snapshot path, better direction] */
export const METRICS = {
  sig_landed_per_min: ['metrics', 'higher'],
  sig_accuracy: ['metrics', 'higher'],
  sig_defense: ['metrics', 'higher'],
  sig_absorbed_per_min: ['metrics', 'lower'],
  sig_diff_per_min: ['metrics', 'higher'],
  knockdowns_per_15: ['metrics', 'higher'],
  td_attempts_per_15: ['metrics', 'higher'],
  td_landed_per_15: ['metrics', 'higher'],
  td_accuracy: ['metrics', 'higher'],
  control_share: ['metrics', 'higher'],
  sub_attempts_per_15: ['metrics', 'higher'],
  finish_rate: ['finish_profile', 'higher'],
  pace_retention_r3_vs_r1: ['round_profile', 'higher'],
};

const CONF_OK = new Set(['medium', 'high']);
const DIV_BY_KEY = new Map(DIVISIONS.map((d) => [`${d.is_womens ? 'W' : 'M'}:${d.key}`, d]));

export function divisionKey(weightClass, isWomens) {
  const k = `${isWomens ? 'W' : 'M'}:${String(weightClass || '').toUpperCase()}`;
  return DIV_BY_KEY.has(k) ? k : null;
}

/** fighter_id -> division key, from the most recent bout in a ranked division before asOf. */
export function assignDivisions(bouts, asOf) {
  const latest = new Map(); // fighter -> { date, id, div }
  for (const b of bouts) {
    const date = b.event_date;
    if (!date || date >= asOf) continue;
    const div = divisionKey(b.weight_class, b.is_womens);
    if (!div) continue;
    for (const f of [b.fighter_a_id, b.fighter_b_id]) {
      if (!f) continue;
      const cur = latest.get(f);
      if (!cur || date > cur.date || (date === cur.date && String(b.id) > String(cur.id))) latest.set(f, { date, id: b.id, div });
    }
  }
  return new Map([...latest].map(([f, v]) => [f, v.div]));
}

function metricValue(m) {
  if (!m || typeof m !== 'object' || !('value' in m)) return null;
  const v = m.value;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return CONF_OK.has(m.confidence) ? v : null;
}

/**
 * @param {object} p
 * @param {Array<{fighter_id:string, sample_completed_bouts:number, metrics?:object}>} p.snapshots  metric objects keyed by METRICS key
 * @param {Set<string>} p.active
 * @param {Map<string,string>} p.divisions  fighter -> division key
 */
export function buildDivisionContext({ snapshots, active, divisions, asOf, definitionVersion, generatedAt }) {
  const eligible = snapshots.filter((s) => active.has(s.fighter_id)
    && Number(s.sample_completed_bouts) >= MIN_COMPLETED_BOUTS && divisions.has(s.fighter_id));

  const divOut = {};
  for (const s of eligible) {
    const k = divisions.get(s.fighter_id);
    divOut[k] ??= { label: DIV_BY_KEY.get(k).label, population: 0 };
    divOut[k].population += 1;
  }

  const fighters = {};
  for (const [metric, [, better]] of Object.entries(METRICS)) {
    const byDiv = new Map();
    for (const s of eligible) {
      const v = metricValue(s.metrics?.[metric]);
      if (v == null) continue;
      const k = divisions.get(s.fighter_id);
      if (!byDiv.has(k)) byDiv.set(k, []);
      byDiv.get(k).push([s.fighter_id, v]);
    }
    for (const rows of byDiv.values()) {
      rows.sort((a, b) => (better === 'lower' ? a[1] - b[1] : b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      rows.forEach(([id], i) => {
        fighters[id] ??= { division: divisions.get(id), ranks: {} };
        fighters[id].ranks[metric] = [i + 1, rows.length];
      });
    }
  }

  return {
    as_of: asOf,
    definition_version: definitionVersion,
    generated_at: generatedAt,
    min_confidence: MIN_CONFIDENCE,
    min_completed_bouts: MIN_COMPLETED_BOUTS,
    metrics: Object.fromEntries(Object.entries(METRICS).map(([k, [, better]]) => [k, { better }])),
    divisions: divOut,
    fighters,
  };
}

/* ------------------------------------------------------------------ I/O */

const base = (env) => String(env.SUPABASE_URL).replace(/\/+$/, '');
const auth = (env) => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` });

async function getJson(env, path) {
  const res = await fetch(`${base(env)}/rest/v1/${path}`, { headers: auth(env) });
  if (!res.ok) throw new Error(`PostgREST GET ${path.split('?')[0]} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* Keyset pages of 1000 (PostgREST caps a response at 1000 rows). Sequential, so the
 * shared project sees one light query at a time. */
async function keyset(env, table, select, filter, key) {
  const out = [];
  let after = null;
  for (let page = 0; page < 100; page += 1) {
    const rows = await getJson(env, `${table}?select=${select}${filter}${after ? `&${key}=gt.${after}` : ''}&order=${key}.asc&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) return out;
    after = rows[rows.length - 1][key];
  }
  throw new Error(`${table}: more than 100 pages`);
}

export async function loadInputs(env, asOf) {
  const metricSelect = Object.entries(METRICS).map(([k, [col]]) => `${k}:${col}->${k}`).join(',');
  /* The newest definition version built at as-of; pinning it keeps (fighter_id) unique per row, so keyset paging is exact. */
  const [top] = await getJson(env, `ufc_fighter_dna_snapshots?select=definition_version&as_of_date=eq.${asOf}&order=definition_version.desc&limit=1`);
  if (!top) return { snapshots: [], active: new Set(), bouts: [] };
  const snaps = await keyset(env, 'ufc_fighter_dna_snapshots',
    `fighter_id,definition_version,sample_completed_bouts,${metricSelect}`, `&as_of_date=eq.${asOf}&definition_version=eq.${top.definition_version}`, 'fighter_id');
  const snapshots = snaps.map((r) => ({
    fighter_id: r.fighter_id, definition_version: r.definition_version, sample_completed_bouts: r.sample_completed_bouts,
    metrics: Object.fromEntries(Object.keys(METRICS).map((k) => [k, r[k]])),
  }));
  const activeRows = await keyset(env, 'ufc_fighters', 'id', '&is_active=eq.true', 'id');
  const boutRows = await keyset(env, 'ufc_bouts', 'id,fighter_a_id,fighter_b_id,weight_class,is_womens,ufc_events(event_date)',
    '&status=eq.complete&model_scope=eq.true', 'id');
  const bouts = boutRows.map((b) => ({ ...b, event_date: b.ufc_events?.event_date || null }));
  return { snapshots, active: new Set(activeRows.map((r) => r.id)), bouts };
}

export async function ensureBucket(env) {
  const res = await fetch(`${base(env)}/storage/v1/bucket/${BUCKET}`, { headers: auth(env) });
  if (res.ok) {
    const b = await res.json();
    if (b.public) throw new Error(`bucket ${BUCKET} is public; refusing to write division context there`);
    return 'exists';
  }
  const made = await fetch(`${base(env)}/storage/v1/bucket`, {
    method: 'POST', headers: { ...auth(env), 'content-type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 5242880, allowed_mime_types: ['application/json'] }),
  });
  if (!made.ok) throw new Error(`create bucket ${BUCKET} -> ${made.status}: ${(await made.text()).slice(0, 200)}`);
  return 'created';
}

async function putObject(env, path, body) {
  const res = await fetch(`${base(env)}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST', headers: { ...auth(env), 'content-type': 'application/json', 'x-upsert': 'true', 'cache-control': 'no-cache' }, body,
  });
  if (!res.ok) throw new Error(`upload ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function writeDivisionContext(env, asOf, { dry = false } = {}) {
  const { snapshots, active, bouts } = await loadInputs(env, asOf);
  if (!snapshots.length) throw new Error(`no Fight DNA snapshots at ${asOf}`);
  const versions = [...new Set(snapshots.map((s) => s.definition_version))];
  const doc = buildDivisionContext({
    snapshots, active, divisions: assignDivisions(bouts, asOf), asOf,
    definitionVersion: Math.max(...versions.map(Number)), generatedAt: new Date().toISOString(),
  });
  const body = JSON.stringify(doc);
  const summary = { as_of: asOf, bytes: body.length, fighters: Object.keys(doc.fighters).length, divisions: Object.fromEntries(Object.entries(doc.divisions).map(([k, d]) => [k, d.population])) };
  if (dry) return { ...summary, dry: true };
  const bucket = await ensureBucket(env);
  await putObject(env, `${PREFIX}/${asOf}.json`, body);
  await putObject(env, `${PREFIX}/latest.json`, body);
  return { ...summary, bucket, paths: [`${BUCKET}/${PREFIX}/${asOf}.json`, `${BUCKET}/${PREFIX}/latest.json`] };
}

/** True when the dated document for asOf is already stored (any 2xx on a one-byte ranged read). */
export async function contextExists(env, asOf) {
  const res = await fetch(`${base(env)}/storage/v1/object/authenticated/${BUCKET}/${PREFIX}/${asOf}.json`, { headers: { ...auth(env), Range: 'bytes=0-0' } });
  return res.ok;
}
