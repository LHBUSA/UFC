// Shared data access for the fighter portrait scripts (queue generator and
// coverage report). Service-role PostgREST over fetch; every list read pages
// with Range because PostgREST caps a response at 1000 rows regardless of
// limit=. The scope rules themselves live in web/lib/fighterMediaPolicy.ts and
// are imported from there, so the scripts and the review UI cannot disagree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScope } from '../../../web/lib/fighterMediaPolicy.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BUCKET = 'ufc-media';

export function loadEnv() {
  const env = { ...process.env };
  for (const file of [process.env.UFC_ENV_FILE, path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')].filter(Boolean)) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (env, UFC_ENV_FILE, .env or web/.env.local)');
  }
  return env;
}

export function client(env) {
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const h = { apikey: key, Accept: 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;

  async function req(p, init = {}) {
    const res = await fetch(`${base}/rest/v1/${p}`, { ...init, headers: { ...h, ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${init.method || 'GET'} ${p.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return { data: text ? JSON.parse(text) : null, headers: res.headers };
  }
  async function all(p) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await req(p, { headers: { Range: `${from}-${from + 999}` } });
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }
  async function count(p) {
    const { headers } = await req(`${p}${p.includes('?') ? '&' : '?'}limit=1`, { headers: { Prefer: 'count=exact' } });
    const r = headers.get('content-range') || '';
    return r.includes('/') ? Number(r.split('/')[1]) : null;
  }
  async function exists(relation) {
    try { await req(`${relation}?select=*&limit=0`); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }
  const mediaUrl = (key) => `${base}/storage/v1/object/public/${BUCKET}/${key}`;
  return { req, all, count, exists, mediaUrl, base };
}

export const isContenderSeries = (name) => /contender series|road to ufc/i.test(name || '');
const today = () => new Date().toISOString().slice(0, 10);

/* Mirrors web/lib/fighterMediaAdmin.ts getPortraitScope(). */
export async function gatherScope(db) {
  const rankingsRes = await fetch(db.mediaUrl('rankings/latest.json'));
  const rankings = rankingsRes.ok ? await rankingsRes.json() : null;
  const EV = 'id,name,event_date';
  const upcomingAll = await db.all(`ufc_events?select=${EV}&event_date=gte.${today()}&order=event_date.asc&limit=40`);
  const recentAll = await db.all(`ufc_events?select=${EV}&event_date=lt.${today()}&order=event_date.desc&limit=25`);
  const upcoming = upcomingAll.filter((e) => !isContenderSeries(e.name)).slice(0, 7);
  const recent = recentAll.filter((e) => !isContenderSeries(e.name));
  const nextEvents = upcoming.slice(0, 3);

  const boutsFor = async (eventIds) => eventIds.length
    ? db.all(`ufc_bouts?select=event_id,fighter_a_id,fighter_b_id,bout_order,status&event_id=in.(${eventIds.join(',')})&order=bout_order.desc`)
    : [];
  const nextBouts = await boutsFor(nextEvents.map((e) => e.id));
  const cards = nextEvents.map((e) => nextBouts.filter((b) => b.event_id === e.id && b.status !== 'cancelled'));

  const stripEvents = [
    ...upcoming.slice(1, 7),
    ...recent.slice(0, 3),
    ...[upcomingAll.find((e) => isContenderSeries(e.name)), recentAll.find((e) => isContenderSeries(e.name))].filter(Boolean),
  ];
  const stripBouts = await boutsFor(stripEvents.map((e) => e.id));
  const mains = new Map();
  for (const b of stripBouts) if (!mains.has(b.event_id)) mains.set(b.event_id, b);
  const divisions = (rankings?.divisions || []).filter((d) => !d.is_p4p);
  const featured = [
    ...[...mains.values()].flatMap((b) => [b.fighter_a_id, b.fighter_b_id]),
    ...divisions.map((d) => d.champion?.fighter_id).filter(Boolean),
    ...divisions.filter((d) => d.champion).flatMap((d) => d.entries.slice(0, 3).map((e) => e.fighter_id)).filter(Boolean),
  ];
  const active = await db.all('ufc_fighters?select=id&is_active=eq.true&order=id');
  const legacy = await db.all('ufc_images?select=fighter_id&fighter_id=not.is.null&order=id');
  return { scope: buildScope({ rankings, cards, featuredIds: featured, activeIds: active.map((r) => r.id), legacyIds: legacy.map((r) => r.fighter_id) }), rankings, nextEvents };
}

export function normalizedName(value) {
  return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
