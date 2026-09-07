/* String -> enum normalizers, Worker side. Mirror of scripts/backfill/normalizers.py.
 * Driven by shared/enums.json. In the repo that is ../../../shared/enums.json;
 * scripts/package_worker.py copies shared/ into src/shared/ for the deployable
 * zip so C:\Workers\ufc-stats-ingest is self-contained. Every unknown value
 * throws SchemaAssertionError.
 */
import ENUMS from './shared/enums.json' with { type: 'json' };
import { SchemaAssertionError } from './ufcstats.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normMethod(raw, url) {
  const key = String(raw || '').trim().split(/\r?\n/)[0].trim();
  const m = ENUMS.method.map;
  if (Object.prototype.hasOwnProperty.call(m, key)) return m[key];
  throw new SchemaAssertionError(url, `unknown method ${JSON.stringify(raw)}`);
}

export function normWeightClass(raw, url) {
  const wc = ENUMS.weight_class;
  const s = String(raw || '').trim();
  if (!s) return { weight_class: null, is_womens: false, is_title: false };
  const lower = s.toLowerCase();
  const is_womens = lower.includes(wc.womens_marker.toLowerCase());
  const is_title = wc.title_markers.some((t) => lower.includes(t.toLowerCase()));
  /* Feeder-series prefix. "Road to UFC 3 Bantamweight Tournament Title Bout"
   * is an ordinary Bantamweight title bout staged inside a regional series,
   * and the series name is not part of the division. It has to go before the
   * generic token pass, which would otherwise remove "UFC" and the season
   * number and leave the unmatchable remainder "Road to Bantamweight".
   * Kept identical to scripts/backfill/normalizers.py: the scheduled worker
   * and the historical backfill must agree, or the same card parses one way
   * live and another way on replay. */
  let core = s.replace(/^\s*Road to UFC\b\s*\d*/i, ' ');
  core = core.replace(new RegExp(esc(wc.womens_marker), 'ig'), ' ');
  for (const tok of wc.strip_tokens) core = core.replace(new RegExp(`\\b${esc(tok)}\\b`, 'ig'), ' ');
  core = core.replace(/\b\d+\b/g, ' ');
  core = core.replace(/\b(Latin America|Brazil|China|Nations|Australia vs\.? UK|Team [A-Za-z]+)\b/ig, ' ');
  core = core.replace(/\s+/g, ' ').trim();
  if (!core) return { weight_class: null, is_womens, is_title };   /* "UFC 2 Tournament Title Bout" */
  for (const [k, v] of Object.entries(wc.map)) {
    if (core.toLowerCase() === k.toLowerCase()) return { weight_class: v, is_womens, is_title };
  }
  throw new SchemaAssertionError(url, `unknown weight class ${JSON.stringify(raw)} (core=${JSON.stringify(core)})`);
}

export function normStance(raw, url) {
  const s = String(raw || '').trim();
  const st = ENUMS.stance;
  if (st.null_values.includes(s)) return null;
  if (Object.prototype.hasOwnProperty.call(st.map, s)) return st.map[s];
  throw new SchemaAssertionError(url, `unknown stance ${JSON.stringify(raw)}`);
}

export function scheduledRounds(timeFormat, url) {
  const s = String(timeFormat || '').trim();
  const sr = ENUMS.scheduled_rounds;
  if (s === '' || sr.null_values.some((nv) => nv && s.startsWith(nv))) return null;
  const m = s.match(/^\s*(\d+)\s*Rnd/i);
  if (m) return Number(m[1]);
  throw new SchemaAssertionError(url, `unknown time format ${JSON.stringify(timeFormat)}`);
}

export function mmssToSec(raw, url) {
  const s = String(raw || '').trim();
  if (s === '' || s === '--') return null;
  const m = s.match(/^(\d+):(\d{1,2})$/);
  if (!m) throw new SchemaAssertionError(url, `bad mm:ss ${JSON.stringify(raw)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function xOfY(raw, url) {
  const s = String(raw || '').trim();
  if (['', '--', '---'].includes(s)) return [null, null];
  const m = s.match(/^(\d+)\s+of\s+(\d+)$/i);
  if (!m) throw new SchemaAssertionError(url, `bad 'x of y' ${JSON.stringify(raw)}`);
  return [Number(m[1]), Number(m[2])];
}

export function intOrNull(raw, url) {
  const s = String(raw || '').trim();
  if (['', '--', '---'].includes(s)) return null;
  if (!/^\d+$/.test(s)) throw new SchemaAssertionError(url, `bad int ${JSON.stringify(raw)}`);
  return Number(s);
}

export function numOrNull(raw, url) {
  const s = String(raw || '').trim();
  if (s === '' || s === '--') return null;
  const n = Number(s);
  if (Number.isNaN(n)) throw new SchemaAssertionError(url, `bad number ${JSON.stringify(raw)}`);
  return n;
}

export function pctOrNull(raw, url) {
  return numOrNull(String(raw || '').trim().replace(/%$/, ''), url);
}

export function heightIn(raw, url) {
  const s = String(raw || '').trim();
  if (s === '' || s === '--') return null;
  const m = s.match(/^(\d+)'\s*(\d+)"?$/);
  if (!m) throw new SchemaAssertionError(url, `bad height ${JSON.stringify(raw)}`);
  return Number(m[1]) * 12 + Number(m[2]);
}

export function reachIn(raw, url) {
  return numOrNull(String(raw || '').trim().replace(/"$/, '').trim(), url);
}

export function weightLbs(raw, url) {
  return numOrNull(String(raw || '').trim().replace(/\s*lbs\.?$/i, ''), url);
}

export function record(raw, url) {
  const m = String(raw || '').match(/Record:\s*(\d+)-(\d+)-(\d+)(?:\s*\((\d+)\s*NC\))?/i);
  if (!m) throw new SchemaAssertionError(url, `bad record ${JSON.stringify(raw)}`);
  return { record_w: Number(m[1]), record_l: Number(m[2]), record_d: Number(m[3]), record_nc: m[4] ? Number(m[4]) : 0 };
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function eventDate(raw, url) {
  const m = String(raw || '').trim().match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/);
  const mon = m && MONTHS[m[1].toLowerCase()];
  if (!mon) throw new SchemaAssertionError(url, `bad event date ${JSON.stringify(raw)}`);
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

export function dob(raw, url) {
  const s = String(raw || '').trim();
  if (s === '' || s === '--') return null;
  return eventDate(s, url);
}

export function scorecards(details) {
  const found = [...String(details || '').matchAll(/([A-Za-z][A-Za-z .'\-]+?)\s+(\d{1,3}\s*-\s*\d{1,3})\s*\.?/g)];
  if (!found.length) return null;
  return found.map((m) => ({ judge: m[1].trim(), score: m[2].replace(/\s+/g, '') }));
}
