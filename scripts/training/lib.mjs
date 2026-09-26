// Shared plumbing for scripts/training/* (Training & Corner, migration 032).
//
// Credentials, first found wins, never printed:
//   process.env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   <repo>/web/.env.production.local
//   D:\Workers\ufc-propbetedge\web\.env.production.local   (canonical checkout, for worktrees)
//   D:\Workers\secrets\ufc-propbetedge.env

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const file of [
  path.join(ROOT, 'web', '.env.production.local'),
  'D:/Workers/ufc-propbetedge/web/.env.production.local',
  'D:/Workers/secrets/ufc-propbetedge.env',
]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*\ufeff?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!SUPABASE_URL || !KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found');

/* Same header contract as the Workers: sb_secret_* keys go on apikey only. */
function headers(extra = {}) {
  const h = { apikey: KEY, accept: 'application/json', ...extra };
  if (KEY.startsWith('eyJ')) h.authorization = `Bearer ${KEY}`;
  return h;
}

export async function get(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${pathAndQuery.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/* Every row, keyset-paginated on a unique column (PostgREST caps a page at 1000). */
export async function getAll(table, select, key = 'id', filter = '') {
  const out = [];
  let last = null;
  for (;;) {
    const after = last == null ? '' : `&${key}=gt.${encodeURIComponent(last)}`;
    const page = await get(`${table}?select=${select}${filter}&order=${key}.asc&limit=1000${after}`);
    out.push(...page);
    if (page.length < 1000) return out;
    last = page[page.length - 1][key];
  }
}

export async function post(table, rows, prefer = 'return=representation') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: headers({ 'content-type': 'application/json', prefer }), body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`POST ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

export async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`RPC ${fn} -> ${res.status} ${(await res.text()).slice(0, 400)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* Mirrors SQL public.ufc_training_norm: lowercase, non-alphanumerics -> one space. */
export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || null;
}

export function slugify(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fighter by uuid, ESPN athlete id, UFC Stats id, or a profile slug (`name-<id>`). Exact only. */
export async function resolveFighter(ref) {
  const r = String(ref || '').trim();
  const sel = 'select=id,name,espn_athlete_id,ufcstats_id';
  let rows = [];
  if (UUID_RE.test(r)) rows = await get(`ufc_fighters?${sel}&id=eq.${r}`);
  else if (/^\d+$/.test(r)) rows = await get(`ufc_fighters?${sel}&espn_athlete_id=eq.${r}`);
  else if (/^[0-9a-f]{16}$/i.test(r)) rows = await get(`ufc_fighters?${sel}&ufcstats_id=eq.${r}`);
  else {
    const id = r.match(/-([0-9a-z]{6,20})$/)?.[1];
    if (id) rows = await get(`ufc_fighters?${sel}&or=(espn_athlete_id.eq.${id},ufcstats_id.eq.${id})`);
  }
  if (rows.length !== 1) throw new Error(`fighter "${r}": ${rows.length} matches (use a uuid, ESPN id, UFC Stats id or profile slug)`);
  return rows[0];
}
