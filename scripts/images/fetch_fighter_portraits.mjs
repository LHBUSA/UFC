#!/usr/bin/env node
// Licensed fighter-portrait pipeline for ufc.propbetedge.ai.
//
//   ufc_fighters -> Wikidata (entity by name + DOB) -> P18 -> Wikimedia Commons
//   imageinfo (license allowlist) -> sharp (portrait/card/thumb) -> Supabase
//   Storage bucket ufc-media -> one ufc_images row per fighter.
//
// Only free Wikimedia Commons licenses are accepted (CC0, Public domain,
// CC BY x.x, CC BY-SA x.x). Nothing else is ever downloaded or stored.
// Fighters without an acceptable image get no row; the site falls back to a
// branded card. See docs/images.md.
//
// Usage: node scripts/images/fetch_fighter_portraits.mjs
//          [--limit N] [--force] [--dry-run] [--fighter <uuid>] [--no-priority]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const sharp = require(path.join(ROOT, 'web', 'node_modules', 'sharp'));

// ---------------------------------------------------------------- config
const USER_AGENT = 'PropBetEdgeUFC/1.0 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';
const BUCKET = 'ufc-media';
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'lookups.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WIKI_MIN_INTERVAL_MS = 500; // ~2 req/s to Wikimedia
const MMA_DESC = /mixed martial art|\bMMA\b|fighter/i;
// Allowlist. Anything that does not match is rejected (fair use, NC, ND, GFDL-only, ...).
const LICENSE_OK = /^(CC0(\s*1\.0)?|Public domain|CC BY \d(\.\d)?|CC BY-SA \d(\.\d)?)$/i;

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const LIMIT = opt('--limit') ? Number(opt('--limit')) : Infinity;
const FORCE = flag('--force');
const DRY = flag('--dry-run');
const ONLY_FIGHTER = opt('--fighter');
const PRIORITY = !flag('--no-priority'); // --priority is the default

// ---------------------------------------------------------------- env
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env)'); process.exit(2); }
const SB_HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastWiki = 0;
async function wikiFetch(url, asJson = true) {
  const wait = lastWiki + WIKI_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastWiki = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: asJson ? 'application/json' : '*/*' } });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return asJson ? res.json() : Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`gave up on ${url}`);
}

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function sbSelectAll(table, query) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { ...SB_HEADERS, Range: `${from}-${from + page - 1}`, 'Range-Unit': 'items' },
    });
    if (res.status === 416) break;
    if (!res.ok) throw new Error(`PostgREST ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

async function sbUpsertImage(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ufc_images?on_conflict=r2_key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`upsert ufc_images ${res.status}: ${await res.text()}`);
}

async function storageUpload(key, buf, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error(`storage upload ${key} ${res.status}: ${await res.text()}`);
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

// ---------------------------------------------------------------- wikidata
function p569Date(entity) {
  const c = entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value;
  if (!c || !c.time) return null;
  if ((c.precision ?? 11) < 11) return null; // year/month precision cannot verify a DOB
  const m = c.time.match(/^[+-](\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function getEntity(qid) {
  const j = await wikiFetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  return j.entities?.[qid];
}

/** Returns {status:'ok', qid, entity} | {status:'no_entity'|'ambiguous', note} */
async function resolveEntity(fighter) {
  const q = encodeURIComponent(fighter.name);
  const j = await wikiFetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=5&search=${q}`);
  const cands = (j.search ?? []).filter((s) => MMA_DESC.test(s.description ?? ''));
  if (cands.length === 0) return { status: 'no_entity', note: 'no MMA candidate on Wikidata' };

  if (fighter.dob) {
    const unverifiable = [];
    for (const c of cands) {
      const entity = await getEntity(c.id);
      const dob = p569Date(entity);
      if (dob === fighter.dob) return { status: 'ok', qid: c.id, entity, note: `${c.id} dob match` };
      if (dob === null) unverifiable.push({ c, entity }); // no P569: keep for the single-candidate rule
      // P569 present and different -> drop
    }
    if (cands.length === 1 && unverifiable.length === 1) {
      return { status: 'ok', qid: cands[0].id, entity: unverifiable[0].entity, note: `${cands[0].id} single candidate, no P569` };
    }
    if (unverifiable.length === 0) return { status: 'no_entity', note: `dob mismatch on ${cands.length} candidate(s)` };
    return { status: 'ambiguous', note: `${cands.length} MMA candidates, dob unverifiable` };
  }

  if (cands.length > 1) return { status: 'ambiguous', note: `${cands.length} MMA candidates, fighter has no dob` };
  const entity = await getEntity(cands[0].id);
  return { status: 'ok', qid: cands[0].id, entity, note: `${cands[0].id} single candidate, no dob on file` };
}

// ---------------------------------------------------------------- commons
async function commonsImageInfo(filename) {
  const title = encodeURIComponent(`File:${filename}`);
  const j = await wikiFetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1200&titles=${title}`);
  const page = Object.values(j.query?.pages ?? {})[0];
  const ii = page?.imageinfo?.[0];
  if (!ii) return null;
  const md = ii.extmetadata ?? {};
  return {
    license: stripHtml(md.LicenseShortName?.value ?? ''),
    author: stripHtml(md.Artist?.value ?? '') || null,
    url: ii.url,
    thumburl: ii.thumburl,
    descriptionurl: ii.descriptionurl,
    width: ii.width, height: ii.height, mime: ii.mime,
  };
}

// ---------------------------------------------------------------- images
const JPEG = { quality: 82, mozjpeg: true };
async function deriveAndUpload(fighterId, srcBuf) {
  const base = sharp(srcBuf, { failOn: 'none' }).rotate();
  const portrait = await base.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg(JPEG).toBuffer();
  const card = await base.clone().resize(800, 1000, { fit: 'cover', position: sharp.strategy.attention }).jpeg(JPEG).toBuffer();
  const thumb = await base.clone().resize(320, 400, { fit: 'cover', position: sharp.strategy.attention }).jpeg(JPEG).toBuffer();
  const prefix = `fighters/${fighterId}`;
  await storageUpload(`${prefix}/portrait.jpg`, portrait, 'image/jpeg');
  await storageUpload(`${prefix}/card.jpg`, card, 'image/jpeg');
  await storageUpload(`${prefix}/thumb.jpg`, thumb, 'image/jpeg');
  return [portrait.length, card.length, thumb.length].map((n) => `${Math.round(n / 1024)}k`).join('/');
}

// ---------------------------------------------------------------- per fighter
async function processFighter(f) {
  const ent = await resolveEntity(f);
  if (ent.status !== 'ok') return { status: ent.status, note: ent.note };

  const p18 = ent.entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!p18) return { status: 'no_image', qid: ent.qid, note: `${ent.qid} has no P18` };

  const info = await commonsImageInfo(p18);
  if (!info || !info.url) return { status: 'no_image', qid: ent.qid, note: `Commons has no imageinfo for ${p18}` };
  if (!LICENSE_OK.test(info.license)) {
    return { status: 'license_rejected', qid: ent.qid, note: `${info.license || '(no license)'} - ${info.descriptionurl}` };
  }

  const r2_key = `fighters/${f.id}/portrait.jpg`;
  const row = { kind: 'wikimedia', r2_key, license: info.license, author: info.author, source_url: info.descriptionurl, fighter_id: f.id };
  if (DRY) return { status: 'ok', qid: ent.qid, note: `DRY ${info.license} by ${info.author ?? '?'} <- ${p18}`, row };

  const srcUrl = info.thumburl && info.width > 1200 ? info.thumburl : info.url;
  const buf = await wikiFetch(srcUrl, false);
  const sizes = await deriveAndUpload(f.id, buf);
  await sbUpsertImage(row);
  return { status: 'ok', qid: ent.qid, note: `${info.license} by ${info.author ?? '?'} (${sizes}) <- ${p18}`, row };
}

// ---------------------------------------------------------------- main
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const fighters = ONLY_FIGHTER
    ? await sbSelectAll('ufc_fighters', `select=id,name,nickname,dob&id=eq.${ONLY_FIGHTER}`)
    : await sbSelectAll('ufc_fighters', 'select=id,name,nickname,dob&order=name.asc');
  if (ONLY_FIGHTER && fighters.length === 0) { console.error(`fighter ${ONLY_FIGHTER} not found`); process.exit(1); }

  const prioritySet = new Set();
  if (PRIORITY && !ONLY_FIGHTER) {
    const bouts = await sbSelectAll('ufc_bouts', `select=fighter_a_id,fighter_b_id,ufc_events!inner(event_date)&ufc_events.event_date=gte.${today}`);
    for (const b of bouts) { prioritySet.add(b.fighter_a_id); prioritySet.add(b.fighter_b_id); }
    fighters.sort((a, b) => (prioritySet.has(b.id) - prioritySet.has(a.id)) || a.name.localeCompare(b.name));
  }

  const cache = loadCache();
  const counts = { ok: 0, no_entity: 0, no_image: 0, license_rejected: 0, ambiguous: 0, error: 0, skipped: 0 };
  console.log(`${fighters.length} fighters in ufc_fighters, ${prioritySet.size} on upcoming cards${DRY ? ' [DRY RUN]' : ''}${FORCE ? ' [FORCE]' : ''}`);

  let processed = 0;
  for (const f of fighters) {
    if (processed >= LIMIT) break;
    const c = cache[f.id];
    const fresh = c && Date.now() - Date.parse(c.checked_at) < CACHE_TTL_MS;
    if (fresh && !FORCE && !ONLY_FIGHTER) { counts.skipped++; continue; }
    processed++;
    const tag = prioritySet.has(f.id) ? '*' : ' ';
    let r;
    try { r = await processFighter(f); }
    catch (e) { r = { status: 'error', note: e.message }; }
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    console.log(`${tag} ${f.id}  ${f.name.padEnd(28)} ${r.status.padEnd(17)} ${r.note ?? ''}`);
    if (!DRY && r.status !== 'error') {
      cache[f.id] = { status: r.status, checked_at: new Date().toISOString(), name: f.name, qid: r.qid ?? null, license: r.row?.license ?? null };
      saveCache(cache);
    }
  }

  console.log('\nsummary');
  console.log(`  ok               ${counts.ok}`);
  console.log(`  no entity        ${counts.no_entity}`);
  console.log(`  no image         ${counts.no_image}`);
  console.log(`  rejected         ${counts.license_rejected}`);
  console.log(`  ambiguous        ${counts.ambiguous}`);
  console.log(`  error (retry)    ${counts.error}`);
  console.log(`  skipped (cached) ${counts.skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
