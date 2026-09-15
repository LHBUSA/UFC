// Shared READ-ONLY plumbing for the UFC 331 production acceptance gates
// (docs/acceptance/UFC331_PRODUCTION_ACCEPTANCE.md). Every request here is a
// GET. Nothing in scripts/acceptance/ writes to the database, R2 or a Worker.
//
// Credentials, first found wins, never printed:
//   process.env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   <repo>/web/.env.production.local
//   <repo>/.env
//   D:\Workers\secrets\ufc-propbetedge.env

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const file of [path.join(ROOT, 'web', '.env.production.local'), path.join(ROOT, '.env'), 'D:/Workers/secrets/ufc-propbetedge.env']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*\ufeff?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found');
const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, accept: 'application/json' };

export async function get(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers });
  if (!res.ok) throw new Error(`GET ${pathAndQuery.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function count(table, filter = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*${filter}&limit=1`, { headers: { ...headers, prefer: 'count=exact' } });
  if (!res.ok) throw new Error(`COUNT ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return Number(res.headers.get('content-range')?.split('/')[1]);
}

/** GET rows where column in ids, chunked. */
export async function inChunks(table, column, ids, select, extra = '', size = 60) {
  const out = [];
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += size) out.push(...await get(`${table}?select=${select}&${column}=in.(${list.slice(i, i + size).join(',')})${extra}`));
  return out;
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/* Frozen identifiers (docs/acceptance/UFC331_PRODUCTION_ACCEPTANCE.md). */
export const V1 = Object.freeze({
  model_version: 'pbe-fight-model-v1',
  feature_version: 'pbe-fight-features-v1',
  spec_sha256: '75da0a1de14de2e186dea784dcbcfdbd140f592b3719b34bc11988cb52b7155f',
  full_row_sha256: 'c040ffbf1f822f07fcadfe1973b119d36d8703e310b8082164c6f536ea884a7b',
  artifact_sha256: '69d8bdf93a5a187812c03f58f4b6c88483241e382685977f3ddf3c2fc1c70c06',
  manifest_sha256: 'b592c0847dd4281350aa6b8af15a346cb6129edec448a48ec4a9a1837f633e69',
});
export const UFC331 = Object.freeze({
  event_id: '221ca353-f623-4b66-98aa-3a504a418236',
  event_date: '2026-09-19',
  lock_window_opens: '2026-09-18T16:00:00Z',
  lock_window_closes: '2026-09-18T18:00:00Z',
  hourly_capture_from: '2026-09-17T18:00:00Z',
});
export const PUBLIC_SITE = 'https://ufc.propbetedge.ai';

export function print(receipt) {
  console.log(JSON.stringify(receipt, null, 1));
}
