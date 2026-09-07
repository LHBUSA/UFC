#!/usr/bin/env node
// Shared enrichment + media engine for non-fighter subjects (UFC referees,
// Hall of Fame inductees). Mirrors the disciplined fighter pipeline in
// scripts/images/fetch_fighter_portraits.mjs:
//
//   subject name -> Wikipedia summary (context-checked so a namesake can
//     never attach) -> Wikidata entity (P18 image, P569 DOB, P27 citizenship,
//     P106 occupation) -> Commons imageinfo with the SAME license allowlist
//     (CC0, Public domain, CC BY x.x, CC BY-SA x.x) -> sharp derivatives ->
//   Supabase Storage bucket ufc-media (first-party hosting, never a hotlink)
//   -> one JSON source packet per subject under data/<type>/<slug>.json where
//   every factual claim carries value, source, method and verified_at.
//
// Nothing outside the license allowlist is downloaded or stored. When no
// identity-safe licensed image exists the packet records the search and the
// rejections, and the UI keeps its monogram — a monogram now means "searched
// approved sources, found nothing usable", not "not attempted".
//
// Slots: avatar (1:1), card (4:5), profile (4:5 large). A 16:9 hero slot is
// deliberately not generated for person portraits — cropping a headshot to
// 16:9 forces forehead/chin loss, which the portrait acceptance rules forbid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const sharp = require(path.join(ROOT, 'web', 'node_modules', 'sharp'));

export const USER_AGENT = 'PropBetEdgeUFC/1.2 media-enrichment (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';
// Allowlist identical to the fighter pipeline. Anything else is rejected.
export const LICENSE_OK = /^(CC0(\s*1\.0)?|Public domain|CC BY \d(\.\d)?|CC BY-SA \d(\.\d)?)$/i;
const MIN_SOURCE_EDGE = 320;
const BUCKET = 'ufc-media';
const WIKI_MIN_INTERVAL_MS = 350;
let lastWiki = 0;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[“”"]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const nowIso = () => new Date().toISOString();
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export async function wikiFetch(url, { raw = false } = {}) {
  const wait = WIKI_MIN_INTERVAL_MS - (Date.now() - lastWiki);
  if (wait > 0) await sleep(wait);
  lastWiki = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: raw ? '*/*' : 'application/json' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return raw ? Buffer.from(await r.arrayBuffer()) : await r.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(700 * (attempt + 1));
    }
  }
  return null;
}

/* ---- Wikipedia / Wikidata identity ------------------------------------- */
export async function wikiSummary(title) {
  return wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, '_'))}`);
}
export async function wikiSearch(query, limit = 5) {
  const j = await wikiFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json`);
  return (j?.query?.search || []).map((s) => s.title);
}

/* Does the resolved article actually name this subject? Guards against a
 * search hit for a different person: "Mark Smith" (referee) must not resolve
 * to "Mark Coleman" just because that article mentions MMA. The article title
 * has to carry the subject surname plus the given name or its initial. */
export function titleMatchesSubject(name, title) {
  const norm = (v) => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z ]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  const want = norm(name), got = norm(String(title).replace(/\s*\(.*\)$/, ''));
  if (!want.length || !got.length) return false;
  const surname = want[want.length - 1];
  if (!got.includes(surname)) return false;
  /* Given-name agreement in either direction, so a nickname-prefixed subject
   * ("Big John McCarthy") still matches the plain article title. */
  const wantRest = want.slice(0, -1), gotRest = got.filter((g) => g !== surname);
  if (!wantRest.length || !gotRest.length) return true;
  /* An exact given-name token must agree. Matching on first letters alone
   * would accept "Rickson Gracie" for "Royce Gracie"; only a literal initial
   * ("J. Smith") is allowed to match that way. */
  if (wantRest.some((w) => gotRest.includes(w))) return true;
  return gotRest.some((g) => wantRest.some((w) => (g.length === 1 || w.length === 1) && g[0] === w[0]));
}

/* Resolve the Wikipedia article for a subject. The summary text must match
 * `contextRe` (e.g. /referee/ or /mixed martial art/) AND the article title
 * must name the subject, so a namesake is never attached to a UFC subject. */
export async function resolveWiki(name, contextRe, extraTitles = []) {
  const seen = new Set();
  /* A transient REST failure on one candidate must not abandon the subject:
   * each candidate is tried independently and errors fall through. */
  const tryTitle = async (t) => {
    if (!t || seen.has(t)) return null;
    seen.add(t);
    let s = null;
    try { s = await wikiSummary(t); } catch { return null; }
    if (!s || s.type === 'disambiguation' || !s.title) return null;
    if (!titleMatchesSubject(name, s.title)) return null;
    const text = `${s.description || ''} ${s.extract || ''}`;
    return contextRe.test(text) ? s : null;
  };
  for (const t of [...extraTitles, name, `${name} (referee)`, `${name} (fighter)`, `${name} (mixed martial artist)`]) {
    const s = await tryTitle(t);
    if (s) return s;
  }
  for (const q of [`${name} UFC referee`, `${name} UFC`, `${name} mixed martial arts`]) {
    let hits = [];
    try { hits = await wikiSearch(q, 5); } catch { continue; }
    for (const t of hits) { const s = await tryTitle(t); if (s) return s; }
  }
  return null;
}

export async function wikidataEntity(qid) {
  const j = await wikiFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims|descriptions|labels&languages=en&format=json`);
  return j?.entities?.[qid] || null;
}
const claimValue = (ent, prop) => ent?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value ?? null;
const labelCache = new Map();
export async function wikidataLabel(qid) {
  if (labelCache.has(qid)) return labelCache.get(qid);
  const ent = await wikidataEntity(qid);
  const v = ent?.labels?.en?.value || null;
  labelCache.set(qid, v);
  return v;
}

/* Identity facts we are willing to publish: description, DOB (only when the
 * Wikidata precision is day-level), citizenship labels, occupations, P18. */
export async function identityFacts(qid) {
  const ent = await wikidataEntity(qid);
  if (!ent) return null;
  const dob = claimValue(ent, 'P569');
  const cit = (ent.claims?.P27 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const occ = (ent.claims?.P106 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const nationality = [];
  for (const c of cit.slice(0, 2)) { const l = await wikidataLabel(c); if (l) nationality.push(l); }
  const occupations = [];
  for (const o of occ.slice(0, 4)) { const l = await wikidataLabel(o); if (l) occupations.push(l); }
  return {
    qid,
    description: ent.descriptions?.en?.value || null,
    date_of_birth: dob?.time && dob.precision >= 11 ? dob.time.replace(/^\+/, '').slice(0, 10) : null,
    nationality: nationality.length ? nationality.join(' / ') : null,
    occupations,
    image_file: claimValue(ent, 'P18') || null,
  };
}

/* ---- Commons ------------------------------------------------------------ */
export async function commonsInfo(fileTitle) {
  const title = encodeURIComponent(String(fileTitle).startsWith('File:') ? fileTitle : `File:${fileTitle}`);
  const j = await wikiFetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1600&titles=${title}`);
  const page = Object.values(j?.query?.pages || {})[0];
  const ii = page?.imageinfo?.[0];
  if (!ii) return null;
  const md = ii.extmetadata || {};
  return {
    file: page.title,
    url: ii.thumburl || ii.url,
    original_url: ii.url,
    descriptionurl: ii.descriptionurl,
    width: ii.width, height: ii.height, mime: ii.mime,
    license: stripHtml(md.LicenseShortName?.value),
    license_url: stripHtml(md.LicenseUrl?.value) || null,
    author: stripHtml(md.Artist?.value) || null,
    credit: stripHtml(md.Credit?.value) || null,
    description: stripHtml(md.ImageDescription?.value) || null,
    categories: stripHtml(md.Categories?.value) || null,
  };
}
export async function commonsSearch(query, limit = 8) {
  const j = await wikiFetch(`https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=${limit}&format=json`);
  return (j?.query?.search || []).map((s) => s.title);
}

const surname = (name) => String(name).split(/\s+/).filter(Boolean).slice(-1)[0] || name;
const nameMatches = (name, text) => {
  const parts = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter((p) => p.length > 2);
  const t = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return parts.filter((p) => t.includes(p)).length >= Math.min(2, parts.length);
};

/* Combat-sports context required of any search-found file. A name alone is
 * not identity: "Chris Hill" or "Bruce Allen" match dozens of unrelated
 * Commons files. */
const DOMAIN_CONTEXT = /\bUFC\b|mixed martial|\bMMA\b|octagon|referee|cage ?fight|kickbox|jiu-?jitsu|wrestl|\bfighter\b|Bellator|PRIDE FC/i;

/* Best licensed, identity-safe Commons file.
 *
 * Identity must be established FIRST: a subject with no resolved Wikidata
 * entity gets no image at all, because a free-text Commons name match is not
 * proof of who the person is. With an entity, P18 is trusted outright (the
 * entity is the identity), and any search fallback must additionally carry
 * combat-sports context in its title, description or categories. */
export async function findLicensedImage(name, facts) {
  const rejected = [];
  if (!facts?.qid) return { image: null, rejected: [{ file: '(search not attempted)', reason: 'no resolved Wikidata identity — a name-only Commons match is not identity proof' }] };
  const consider = async (fileTitle, method) => {
    const info = await commonsInfo(fileTitle);
    if (!info) return null;
    if (!LICENSE_OK.test(info.license || '')) { rejected.push({ file: info.file, reason: `license: ${info.license || 'none'}` }); return null; }
    if (!/^image\/(jpeg|png|webp)$/.test(info.mime || '')) { rejected.push({ file: info.file, reason: `mime: ${info.mime}` }); return null; }
    if (Math.min(info.width || 0, info.height || 0) < MIN_SOURCE_EDGE) { rejected.push({ file: info.file, reason: `too small: ${info.width}x${info.height}` }); return null; }
    if (/watermark|logo\.|\.svg$/i.test(info.file)) { rejected.push({ file: info.file, reason: 'logo/watermark candidate' }); return null; }
    if (method !== 'wikidata_p18') {
      /* The name must identify the SUBJECT of the file — its title or one of
       * its curated Commons categories — never just free-text description.
       * A Max Holloway photo whose caption mentions "the UFC's Forrest
       * Griffin Community Award" is not a photo of Forrest Griffin. */
      const subjectText = `${info.file} ${info.categories || ''}`;
      const allText = `${subjectText} ${info.description || ''}`;
      if (!nameMatches(name, subjectText)) { rejected.push({ file: info.file, reason: 'subject name only appears in free-text description, not the file title or categories' }); return null; }
      if (!DOMAIN_CONTEXT.test(allText)) { rejected.push({ file: info.file, reason: 'name matched but no combat-sports context — cannot confirm this is the same person' }); return null; }
      if (/\bvs\b|\bgroup\b|\bcrowd\b|\bteam\b|poster|logo/i.test(`${info.file} ${info.description || ''}`)) { rejected.push({ file: info.file, reason: 'ambiguous group/event image' }); return null; }
      /* Portrait-acceptance proxy. Wikidata P18 is a curated representative
       * image, but an arbitrary Commons file of the right person is often a
       * cage-wide action shot, an expo crowd or a two-person grip-and-grin —
       * all landscape. Requiring a portrait/square source keeps headshots and
       * rejects those without needing face detection. */
      if ((info.height || 0) < (info.width || 0) * 0.95) { rejected.push({ file: info.file, reason: `landscape source ${info.width}x${info.height} — likely an action/crowd frame, not a portrait` }); return null; }
    }
    return { ...info, method };
  };
  if (facts?.image_file) { const hit = await consider(facts.image_file, 'wikidata_p18'); if (hit) return { image: hit, rejected }; }
  for (const t of await commonsSearch(`"${name}"`, 8)) { const hit = await consider(t, 'commons_search'); if (hit) return { image: hit, rejected }; }
  for (const t of await commonsSearch(`${surname(name)} UFC`, 6)) { const hit = await consider(t, 'commons_search_surname'); if (hit) return { image: hit, rejected }; }
  return { image: null, rejected };
}

/* ---- derivatives + first-party hosting ---------------------------------- */
export const SLOTS = { avatar: [400, 400], card: [640, 800], profile: [900, 1125] };
const WEBP = { quality: 84, effort: 5 };

export async function makeDerivatives(buf, prefix, slug) {
  const base = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const files = [];
  for (const [slot, [w, h]] of Object.entries(SLOTS)) {
    const out = await base.clone().resize(w, h, { fit: 'cover', position: sharp.strategy.attention }).webp(WEBP).toBuffer();
    files.push({ slot, key: `${prefix}/${slug}-${slot}.webp`, buf: out, bytes: out.length });
  }
  return { files, source_width: meta.width || null, source_height: meta.height || null };
}

/* Remove previously uploaded derivatives when a subject loses its image (for
 * example after an identity rule is tightened), so no orphaned object can be
 * served or re-referenced later. */
export async function deleteDerivatives(prefix, slug, { dry = false } = {}) {
  const { url, key } = loadEnv();
  if (!url || !key || dry) return 0;
  let removed = 0;
  for (const slot of Object.keys(SLOTS)) {
    const r = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURI(`${prefix}/${slug}-${slot}.webp`)}`, { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (r.ok) removed += 1;
  }
  return removed;
}

export async function uploadDerivatives(files, { dry = false } = {}) {
  const { url, key } = loadEnv();
  const out = {};
  for (const f of files) {
    out[f.slot] = `${url}/storage/v1/object/public/${BUCKET}/${f.key}`;
    if (dry) continue;
    const r = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURI(f.key)}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'image/webp', 'x-upsert': 'true', 'cache-control': 'public, max-age=31536000, immutable' },
      body: f.buf,
    });
    if (!r.ok && r.status !== 409) throw new Error(`storage upload ${f.key} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
  }
  return out;
}

/* Full media metadata block (the model the fighter images use, extended). */
export function mediaBlock({ subjectType, slug, name, image, derived, urls, kind = 'portrait', confidence }) {
  return {
    subject_type: subjectType, subject_id: slug, subject_name: name,
    source_url: image.original_url, source_page_url: image.descriptionurl, source_name: 'Wikimedia Commons',
    license_type: image.license, license_text: image.credit || image.license, license_url: image.license_url,
    author: image.author, attribution: `${image.author || 'Unknown author'} · ${image.license} · via Wikimedia Commons`,
    source_width: derived.source_width, source_height: derived.source_height,
    focal_x: 0.5, focal_y: 0.32, crop_hint: 'attention', preferred_aspect: '4:5',
    confidence, verified_at: nowIso(), kind, method: image.method,
    commercial_display_status: confidence === 'high' ? 'approved' : 'review_required',
    derivatives: urls,
  };
}

/* ---- packets -------------------------------------------------------------- */
export function packetPath(subjectType, slug) { return path.join(ROOT, 'data', subjectType, `${slug}.json`); }
export function readPacket(subjectType, slug) { const p = packetPath(subjectType, slug); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
export function writePacket(subjectType, slug, packet) {
  const p = packetPath(subjectType, slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(packet, null, 2) + '\n');
}
/* Per-subject packets only. Collection files (the Fight Wing set, the curated
 * seed) live in the same folder but are not subjects. */
const NOT_A_PACKET = new Set(['fights.json', 'inductees.json']);
export function listPackets(subjectType) {
  const dir = path.join(ROOT, 'data', subjectType);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !NOT_A_PACKET.has(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
/* Every factual claim carries its value, source, method and verification time. */
export const claim = (value, source, method = 'lookup') => (value == null || value === '' || (Array.isArray(value) && !value.length) ? null : { value, source, method, verified_at: nowIso() });

/* One static JSON the web imports (no runtime fs, works on Vercel). */
export function writeCombined() {
  const out = { generated_at: nowIso(), referees: {}, hof: {}, fights: { fights: [] } };
  for (const [type, key] of [['referees', 'referees'], ['hall-of-fame', 'hof']]) {
    for (const p of listPackets(type)) out[key][p.slug] = p;
  }
  const fightsFile = path.join(ROOT, 'data', 'hall-of-fame', 'fights.json');
  if (fs.existsSync(fightsFile)) out.fights = JSON.parse(fs.readFileSync(fightsFile, 'utf8'));
  const dest = path.join(ROOT, 'web', 'lib', 'generated', 'enrichment.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out) + '\n');
  return { dest, referees: Object.keys(out.referees).length, hof: Object.keys(out.hof).length };
}

/* ---- CLI + Supabase ------------------------------------------------------- */
export function cli() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  return { dry: flag('--dry-run'), limit: opt('--limit') ? Number(opt('--limit')) : Infinity, slug: opt('--slug') || null, resume: flag('--resume'), report: flag('--report'), force: flag('--force') };
}
export function loadEnv() {
  const out = {};
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  }
  return { url: (out.SUPABASE_URL || '').replace(/\/$/, ''), key: out.SUPABASE_SERVICE_ROLE_KEY || '' };
}
export async function rest(pathq) {
  const { url, key } = loadEnv();
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available locally');
  const r = await fetch(`${url}/rest/v1/${pathq}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`rest ${pathq.split('?')[0]} -> ${r.status}`);
  return r.json();
}
