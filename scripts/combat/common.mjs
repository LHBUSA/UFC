import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadEnv() {
  const env = { ...process.env };
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim().replace(/^"|"$/g, '');
      if (!env[key]) env[key] = value;
    }
  }
  return env;
}

export function client() {
  const env = loadEnv();
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
  if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, accept: 'application/json' };
  return { base, key, headers };
}

export async function all(resource, { pageSize = 1000, headers = {} } = {}) {
  const c = client();
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${c.base}/rest/v1/${resource}`, {
      headers: { ...c.headers, ...headers, Range: `${from}-${from + pageSize - 1}` },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const e = new Error(`${resource.split('?')[0]} -> ${r.status}${body ? ` ${body.slice(0, 240)}` : ''}`);
      e.status = r.status;
      throw e;
    }
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function rpc(name, body = {}) {
  const c = client();
  const r = await fetch(`${c.base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...c.headers, 'content-type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const e = new Error(`rpc/${name} -> ${r.status}${text ? ` ${text.slice(0, 300)}` : ''}`);
    e.status = r.status;
    throw e;
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
}

export function has(name) {
  return process.argv.slice(2).includes(name);
}

export function pct(n, d) {
  if (!d) return '0.0%';
  return `${((Number(n) / Number(d)) * 100).toFixed(1)}%`;
}

export function writeJson(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
