#!/usr/bin/env node
// Licensed fighter-portrait pipeline for ufc.propbetedge.ai.
//
//   ufc_fighters -> verified Wikidata identity ->
//     (P18 image OR exact Wikidata-linked Commons category fallback) ->
//   Commons imageinfo (license allowlist) -> sharp derivatives -> Supabase
//   Storage bucket ufc-media -> one ufc_images row per fighter.
//
// A small reviewed `commons_overrides.json` may identify a specific Commons
// file for a fighter when Wikidata lacks a usable identity/image link. Those
// overrides are still license-checked at runtime and name-locked to the stored
// fighter row; they do not bypass the Commons license gate.
//
// Only free Wikimedia Commons licenses are accepted (CC0, Public domain,
// CC BY x.x, CC BY-SA x.x). Nothing else is ever downloaded or stored.
// Fighters without an identity-safe, acceptable image get no row; the site
// falls back to a branded card. See docs/images.md.
//
// Usage: node scripts/images/fetch_fighter_portraits.mjs
//          [--limit N] [--force] [--dry-run] [--fighter <uuid>]
//          [--missing-only] [--no-priority]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const sharp = require(path.join(ROOT, 'web', 'node_modules', 'sharp'));

// ---------------------------------------------------------------- config
const USER_AGENT = 'PropBetEdgeUFC/1.1 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';
const BUCKET = 'ufc-media';
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'lookups.json');
const OVERRIDES_FILE = path.join(__dirname, 'commons_overrides.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WIKI_MIN_INTERVAL_MS = 500; // ~2 req/s to Wikimedia
const MMA_DESC = /mixed martial art|\bMMA\b|fighter/i;
const CATEGORY_CANDIDATE_LIMIT = 12;
const MIN_SOURCE_EDGE = 420;
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
// A reviewed list of names to work through, so a surface that needs pictures
// — the TUF archive, the Contender Series roster — can be filled without
// walking all 2,500 fighters. Names are resolved against ufc_fighters and
// anything that does not resolve is reported rather than guessed at; the
// license gate and the identity lock below are unchanged.
const NAMES_FILE = opt('--names');
const MISSING_ONLY = flag('--missing-only');
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

function norm(s) {
  return stripHtml(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameSignal(fighterName, text) {
  const parts = norm(fighterName).split(/\s+/).filter(Boolean);
  const hay = ` ${norm(text)} `;
  if (!parts.length) return false;
  if (parts.length === 1) return hay.includes(` ${parts[0]} `);
  // Exact first + last token is conservative enough when the source category
  // itself is already linked from the fighter's verified Wikidata entity.
  return hay.includes(` ${parts[0]} `) && hay.includes(` ${parts[parts.length - 1]} `);
}

function loadOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw new Error(`invalid ${path.basename(OVERRIDES_FILE)}: ${e.message}`);
  }
}
const COMMONS_OVERRIDES = loadOverrides();

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

function p373Category(entity) {
  return entity?.claims?.P373?.[0]?.mainsnak?.datavalue?.value || null;
}

function commonsCategory(entity) {
  const p373 = p373Category(entity);
  if (p373) return String(p373).replace(/^Category:/i, '').trim();
  const sitelink = entity?.sitelinks?.commonswiki?.title;
  if (sitelink && /^Category:/i.test(sitelink)) return sitelink.replace(/^Category:/i, '').trim();
  return null;
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
  const clean = String(filename).replace(/^File:/i, '');
  const title = encodeURIComponent(`File:${clean}`);
  const j = await wikiFetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1200&titles=${title}`);
  const page = Object.values(j.query?.pages ?? {})[0];
  const ii = page?.imageinfo?.[0];
  if (!ii) return null;
  const md = ii.extmetadata ?? {};
  return {
    filename: clean,
    license: stripHtml(md.LicenseShortName?.value ?? ''),
    author: stripHtml(md.Artist?.value ?? '') || null,
    description: stripHtml(md.ImageDescription?.value ?? '') || null,
    categories: stripHtml(md.Categories?.value ?? '') || null,
    url: ii.url,
    thumburl: ii.thumburl,
    descriptionurl: ii.descriptionurl,
    width: ii.width, height: ii.height, mime: ii.mime,
  };
}

async function commonsCategoryFiles(category) {
  const title = encodeURIComponent(`Category:${category}`);
  const j = await wikiFetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&list=categorymembers&cmtitle=${title}&cmnamespace=6&cmtype=file&cmlimit=${CATEGORY_CANDIDATE_LIMIT}`);
  return (j.query?.categorymembers ?? []).map((x) => String(x.title || '').replace(/^File:/i, '')).filter(Boolean);
}

function imageCandidateScore(fighter, info) {
  if (!info?.url || !LICENSE_OK.test(info.license || '')) return -Infinity;
  if (!/^image\//i.test(info.mime || '')) return -Infinity;
  if ((info.width || 0) < MIN_SOURCE_EDGE || (info.height || 0) < MIN_SOURCE_EDGE) return -Infinity;

  const evidence = `${info.filename || ''} ${info.description || ''} ${info.categories || ''}`;
  if (!nameSignal(fighter.name, evidence)) return -Infinity;

  const aspect = info.width / Math.max(1, info.height);
  // Reject panoramic/banner-like files; we are selecting a person portrait.
  if (aspect < 0.38 || aspect > 1.35) return -Infinity;

  let score = 0;
  if (nameSignal(fighter.name, info.filename || '')) score += 40;
  if (nameSignal(fighter.name, info.description || '')) score += 20;
  if (aspect >= 0.55 && aspect <= 1.0) score += 20;
  else if (aspect <= 1.18) score += 10;
  score += Math.min(12, Math.log2(Math.max(info.width, info.height) / MIN_SOURCE_EDGE + 1) * 4);

  const fileKey = norm(info.filename || '');
  if (/portrait|headshot|weigh in|media day/.test(fileKey)) score += 4;
  if (/with | and | vs |group|team|crowd|press conference/.test(fileKey)) score -= 18;
  return score;
}

async function findCommonsCategoryFallback(fighter, entity) {
  const category = commonsCategory(entity);
  if (!category) return null;
  const files = await commonsCategoryFiles(category);
  const candidates = [];
  for (const filename of files) {
    const info = await commonsImageInfo(filename);
    const score = imageCandidateScore(fighter, info);
    if (Number.isFinite(score)) candidates.push({ info, score, category });
  }
  candidates.sort((a, b) => b.score - a.score || String(a.info.filename).localeCompare(String(b.info.filename)));
  return candidates[0] || null;
}

// ---------------------------------------------------------------- images
const JPEG = { quality: 84, mozjpeg: true };
async function deriveAndUpload(fighterId, srcBuf) {
  const base = sharp(srcBuf, { failOn: 'none' }).rotate();
  // portrait: preserve the original composition; it is the lossless visual
  // source used for article heroes and any future focal-point reprocessing.
  const portrait = await base.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg(JPEG).toBuffer();
  // card/thumb: Sharp attention keeps the salient subject but does not replace
  // frontend art direction. The UI must not hard-pin these crops to y=0.
  const card = await base.clone().resize(800, 1000, { fit: 'cover', position: sharp.strategy.attention }).jpeg(JPEG).toBuffer();
  const thumb = await base.clone().resize(320, 400, { fit: 'cover', position: sharp.strategy.attention }).jpeg(JPEG).toBuffer();
  const prefix = `fighters/${fighterId}`;
  await storageUpload(`${prefix}/portrait.jpg`, portrait, 'image/jpeg');
  await storageUpload(`${prefix}/card.jpg`, card, 'image/jpeg');
  await storageUpload(`${prefix}/thumb.jpg`, thumb, 'image/jpeg');
  return [portrait.length, card.length, thumb.length].map((n) => `${Math.round(n / 1024)}k`).join('/');
}

async function finalizeImage(f, info, { qid = null, source }) {
  if (!info || !info.url) return { status: 'no_image', qid, note: `Commons has no imageinfo for ${source}` };
  if (!LICENSE_OK.test(info.license || '')) {
    return { status: 'license_rejected', qid, note: `${info.license || '(no license)'} - ${info.descriptionurl || source}` };
  }
  if (!/^image\//i.test(info.mime || '')) return { status: 'no_image', qid, note: `not an image MIME: ${info.mime || '?'} <- ${source}` };

  const r2_key = `fighters/${f.id}/portrait.jpg`;
  const row = { kind: 'wikimedia', r2_key, license: info.license, author: info.author, source_url: info.descriptionurl, fighter_id: f.id };
  if (DRY) return { status: 'ok', qid, note: `DRY ${info.license} by ${info.author ?? '?'} <- ${source}`, row };

  const srcUrl = info.thumburl && info.width > 1200 ? info.thumburl : info.url;
  const buf = await wikiFetch(srcUrl, false);
  const sizes = await deriveAndUpload(f.id, buf);
  await sbUpsertImage(row);
  return { status: 'ok', qid, note: `${info.license} by ${info.author ?? '?'} (${sizes}) <- ${source}`, row };
}

// ---------------------------------------------------------------- per fighter
async function processFighter(f) {
  const manual = COMMONS_OVERRIDES[f.id];
  if (manual) {
    if (!manual.name || norm(manual.name) !== norm(f.name)) {
      return { status: 'error', note: `curated override name mismatch: ${manual.name || '(missing)'} != ${f.name}` };
    }
    if (!manual.file) return { status: 'error', note: 'curated override missing file' };
    const info = await commonsImageInfo(manual.file);
    const evidence = `${info?.filename || ''} ${info?.description || ''} ${info?.categories || ''}`;
    if (!info || !nameSignal(f.name, evidence)) {
      return { status: 'error', note: `curated Commons file no longer carries identity evidence for ${f.name}: ${manual.file}` };
    }
    return finalizeImage(f, info, { source: `CURATED:${manual.file}` });
  }

  const ent = await resolveEntity(f);
  if (ent.status !== 'ok') {
    // No Wikidata entity says nobody has written a structured record for this
    // fighter. It says nothing about whether a freely licensed photograph of
    // them exists, and treating the two as the same thing left most of the
    // roster unpictured for no good reason. The gated search still applies:
    // the filename must carry the name and tie it to the sport, so an absent
    // entity costs us the DOB cross-check but never lowers the identity bar
    // to a bare name match.
    const searched = await findCommonsSearchFallback(f);
    if (!searched) return { status: ent.status, note: `${ent.note}; gated commons search found nothing usable` };
    return finalizeImage(f, searched.info, { qid: null, source: `Search/${searched.info.filename}` });
  }

  const p18 = ent.entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  let info = p18 ? await commonsImageInfo(p18) : null;
  let source = p18 ? `P18:${p18}` : null;
  let rejectedP18 = null;

  if (info && !LICENSE_OK.test(info.license || '')) {
    rejectedP18 = `${info.license || '(no license)'} - ${info.descriptionurl}`;
    info = null;
  }

  // A missing or non-redistributable P18 is not the end of the search. If the
  // verified Wikidata entity links an exact Commons category, inspect a small
  // bounded set of portrait-like files from THAT category only. This expands
  // coverage without doing dangerous free-text image search across Commons.
  if (!info) {
    const fallback = await findCommonsCategoryFallback(f, ent.entity);
    if (fallback) {
      info = fallback.info;
      source = `Category:${fallback.category}/${fallback.info.filename}`;
    }
  }

  // Third route, added after a coverage pass showed the two above leave most
  // of the roster with nothing: a free-text Commons search, gated hard.
  //
  // The original note here warned that free-text image search across Commons
  // is dangerous, and it is right — a name query returns photographs of other
  // people with the same name, and putting one of those on a fighter's page
  // is worse than leaving the page without a face. So the search is only a
  // CANDIDATE GENERATOR: every file must then carry the fighter's name in its
  // filename AND something that ties it to this sport before it is even sent
  // for a license check. A file that merely matches the name is discarded.
  if (!info) {
    const searched = await findCommonsSearchFallback(f);
    if (searched) {
      info = searched.info;
      source = `Search/${searched.info.filename}`;
    }
  }

  if (!info || !info.url) {
    if (rejectedP18) return { status: 'license_rejected', qid: ent.qid, note: `P18 rejected (${rejectedP18}); no safe category or search fallback` };
    return { status: 'no_image', qid: ent.qid, note: `${ent.qid} has no safe P18/category/search portrait` };
  }

  return finalizeImage(f, info, { qid: ent.qid, source });
}

/** Does this filename plausibly depict THIS fighter in THIS sport? */
function fighterFilenameGate(file, name) {
  const f = String(file).toLowerCase().replace(/[_-]+/g, ' ');
  const n = String(name).toLowerCase();
  const parts = n.split(/\s+/).filter((x) => x.length > 2);
  const surname = parts[parts.length - 1] || '';
  // Every part of the name, or at least a distinctive surname, must appear.
  const allParts = parts.length > 1 && parts.every((p) => f.includes(p));
  if (!allParts && !(surname.length > 5 && f.includes(surname))) {
    return { ok: false, why: 'filename does not carry the name' };
  }
  if (!/(mma|ufc|bellator|octagon|cage|weigh|fight night|ufc \d)/.test(f)) {
    return { ok: false, why: 'filename carries the name but nothing tying it to the sport' };
  }
  return { ok: true };
}

/**
 * Candidate generator of last resort. Returns an accepted, license-checked
 * image or null; never a guess.
 */
async function findCommonsSearchFallback(f) {
  let hits;
  try {
    const j = await wikiFetch(
      `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=20&srsearch=${encodeURIComponent(f.name)}`,
    );
    hits = (j?.query?.search || []).map((h) => String(h.title).replace(/^File:/, ''));
  } catch { return null; }

  for (const file of hits) {
    if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
    if (!fighterFilenameGate(file, f.name).ok) continue;
    let info = null;
    try { info = await commonsImageInfo(file); } catch { continue; }
    if (!info || !info.url) continue;
    if (!LICENSE_OK.test(info.license || '')) continue;
    if (Math.min(info.width || 0, info.height || 0) < MIN_SOURCE_EDGE) continue;
    return { info };
  }
  return null;
}

// ---------------------------------------------------------------- main
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  let fighters = ONLY_FIGHTER
    ? await sbSelectAll('ufc_fighters', `select=id,name,nickname,dob&id=eq.${ONLY_FIGHTER}`)
    : await sbSelectAll('ufc_fighters', 'select=id,name,nickname,dob&order=name.asc');
  if (ONLY_FIGHTER && fighters.length === 0) { console.error(`fighter ${ONLY_FIGHTER} not found`); process.exit(1); }
  /* The full roster, captured before any filtering, so a name-list report can
   * tell "not in ufc_fighters at all" from "filtered out for another reason". */
  const allNames = new Set(fighters.map((f) => String(f.name)));

  if (NAMES_FILE) {
    const wanted = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
    /* Accent-folded, because the archive spells names as its sources do
     * ("Alejandro Pérez", "Antônio Rodrigo Nogueira") and ufc_fighters
     * generally does not. Folding is only for MATCHING; the stored row keeps
     * whatever the database already has, and no name is rewritten. */
    const fold = (n) => String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const want = new Set(wanted.map(fold));
    const before = fighters.length;
    fighters = fighters.filter((f) => want.has(fold(f.name)));
    /* Preserve the caller's ordering: the list is written most-important
     * first (coaches and champions before contestants) and that is the order
     * a limited run should work through. */
    const rank = new Map(wanted.map((n, i) => [fold(n), i]));
    fighters.sort((a, b) => (rank.get(fold(a.name)) ?? 1e9) - (rank.get(fold(b.name)) ?? 1e9));
    const got = new Set(fighters.map((f) => fold(f.name)));
    /* Two very different reasons a name is not in the work list, and calling
     * both "unresolved" reads as a data gap when half of them are successes. */
    const known = new Set([...allNames].map(fold));
    const absent = wanted.filter((n) => !known.has(fold(n)));
    const pictured = wanted.filter((n) => known.has(fold(n)) && !got.has(fold(n)));
    console.log(`name list: ${fighters.length} of ${wanted.length} queued (from ${before} candidate fighters)`);
    if (pictured.length) console.log(`  already have stored media, skipped: ${pictured.length}`);
    if (absent.length) console.log(`  no fighter row, left alone: ${absent.length} — ${absent.slice(0, 10).join(', ')}${absent.length > 10 ? ` … +${absent.length - 10}` : ''}`);
  }

  if (MISSING_ONLY && !ONLY_FIGHTER) {
    const existing = await sbSelectAll('ufc_images', 'select=fighter_id&kind=eq.wikimedia&fighter_id=not.is.null');
    const pictured = new Set(existing.map((r) => r.fighter_id).filter(Boolean));
    fighters = fighters.filter((f) => !pictured.has(f.id));
  }

  const prioritySet = new Set();
  if (PRIORITY && !ONLY_FIGHTER && !NAMES_FILE) {
    const bouts = await sbSelectAll('ufc_bouts', `select=fighter_a_id,fighter_b_id,ufc_events!inner(event_date)&ufc_events.event_date=gte.${today}`);
    for (const b of bouts) { prioritySet.add(b.fighter_a_id); prioritySet.add(b.fighter_b_id); }
    fighters.sort((a, b) => (prioritySet.has(b.id) - prioritySet.has(a.id)) || a.name.localeCompare(b.name));
  }

  const cache = loadCache();
  const counts = { ok: 0, no_entity: 0, no_image: 0, license_rejected: 0, ambiguous: 0, error: 0, skipped: 0 };
  console.log(`${fighters.length} fighters selected${MISSING_ONLY ? ' without stored media' : ' from ufc_fighters'}, ${prioritySet.size} on upcoming cards, ${Object.keys(COMMONS_OVERRIDES).length} curated override(s)${DRY ? ' [DRY RUN]' : ''}${FORCE ? ' [FORCE]' : ''}`);

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