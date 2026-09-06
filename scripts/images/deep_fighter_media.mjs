#!/usr/bin/env node
// PropBetEdge UFC deep fighter-media discovery.
//
// Purpose: maximize rights-safe fighter portrait coverage without weakening
// identity or licensing gates. The shallow portrait worker remains the final
// image processor/uploader. This worker expands discovery and records every
// useful candidate in ufc_image_candidates.
//
// Discovery order for a verified fighter identity:
//   1. Wikidata P18
//   2. Wikimedia Structured Data files that `depict` the verified QID
//   3. every file (bounded/paginated) in the exact Commons category linked by
//      the verified Wikidata entity
//   4. exact-name Commons file search
//
// Auto-publish is intentionally stricter than discovery: a candidate must have
// a free/commercially reusable Commons license, strong identity evidence, name
// evidence in file metadata, usable dimensions and portrait-ish composition.
// Anything else stays review-only. No UFC/Getty/ESPN/social scraping occurs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OVERRIDES_PATH = path.join(__dirname, 'commons_overrides.json');
const SHALLOW_WORKER = path.join(__dirname, 'fetch_fighter_portraits.mjs');

const USER_AGENT = 'PropBetEdgeUFCMedia/2.0 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';
const ALLOWED_LICENSE = /^(CC0(\s*1\.0)?|Public domain|CC BY \d(\.\d)?|CC BY-SA \d(\.\d)?)$/i;
const MMA_DESC = /mixed martial art|\bMMA\b|fighter/i;
const MMA_CONTEXT = /\bufc\b|mixed martial|\bmma\b|fighter|fight night|contender series|bellator|pfl|one championship|combat sports|octagon|weigh-?in/i;
const MIN_SOURCE_EDGE = 420;
const MAX_CATEGORY_FILES = 250;
const MAX_SEARCH_FILES = 120;
const MAX_DEPICTS_FILES = 120;
const WIKI_INTERVAL_MS = 350;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const LIMIT = opt('--limit') ? Math.max(1, Number(opt('--limit'))) : 120;
const ONLY_FIGHTER = opt('--fighter') || null;
const DRY_RUN = flag('--dry-run');
const PUBLISH = flag('--publish') && !DRY_RUN;

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
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  process.exit(2);
}
const SB_HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastWikiAt = 0;

async function wikiJson(url) {
  const wait = lastWikiAt + WIKI_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastWikiAt = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  }
  throw new Error(`Wikimedia retries exhausted: ${url}`);
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(value) {
  return stripHtml(value)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameSignal(fighterName, text) {
  const parts = norm(fighterName).split(/\s+/).filter(Boolean);
  const hay = ` ${norm(text)} `;
  if (!parts.length) return false;
  if (parts.length === 1) return hay.includes(` ${parts[0]} `);
  return hay.includes(` ${parts[0]} `) && hay.includes(` ${parts.at(-1)} `);
}

function exactTitleSignal(fighterName, filename) {
  const a = norm(fighterName);
  const b = norm(String(filename || '').replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, ''));
  return Boolean(a && (b === a || b.startsWith(`${a} `) || b.endsWith(` ${a}`)));
}

async function sbSelectAll(table, query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { ...SB_HEADERS, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (res.status === 416) break;
    if (!res.ok) throw new Error(`PostgREST ${table} ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function upsertCandidate(row) {
  if (DRY_RUN) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ufc_image_candidates?on_conflict=fighter_id%2Csource_url`, {
    method: 'POST',
    headers: {
      ...SB_HEADERS,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`candidate upsert ${res.status}: ${await res.text()}`);
}

function p569Date(entity) {
  const value = entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value;
  if (!value?.time || (value.precision ?? 11) < 11) return null;
  const m = value.time.match(/^[+-](\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function commonsCategory(entity) {
  const p373 = entity?.claims?.P373?.[0]?.mainsnak?.datavalue?.value;
  if (p373) return String(p373).replace(/^Category:/i, '').trim();
  const sitelink = entity?.sitelinks?.commonswiki?.title;
  if (sitelink && /^Category:/i.test(sitelink)) return sitelink.replace(/^Category:/i, '').trim();
  return null;
}

async function getEntity(qid) {
  const j = await wikiJson(`https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`);
  return j.entities?.[qid] || null;
}

async function resolveEntity(fighter) {
  const q = encodeURIComponent(fighter.name);
  const j = await wikiJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=10&search=${q}`);
  const candidates = (j.search || []).filter((c) => MMA_DESC.test(c.description || ''));
  if (!candidates.length) return { status: 'no_entity', note: 'no MMA Wikidata candidate' };

  if (fighter.dob) {
    const withoutDob = [];
    for (const candidate of candidates) {
      const entity = await getEntity(candidate.id);
      const dob = p569Date(entity);
      if (dob === fighter.dob) return { status: 'ok', qid: candidate.id, entity, evidence: 'dob_match' };
      if (!dob) withoutDob.push({ candidate, entity });
    }
    if (candidates.length === 1 && withoutDob.length === 1) {
      return { status: 'ok', qid: withoutDob[0].candidate.id, entity: withoutDob[0].entity, evidence: 'single_mma_no_wikidata_dob' };
    }
    return { status: 'ambiguous', note: 'Wikidata candidate DOB did not resolve uniquely' };
  }

  if (candidates.length !== 1) return { status: 'ambiguous', note: `${candidates.length} MMA candidates and no stored DOB` };
  return { status: 'ok', qid: candidates[0].id, entity: await getEntity(candidates[0].id), evidence: 'single_mma_candidate' };
}

async function commonsImageInfo(filename) {
  const clean = String(filename || '').replace(/^File:/i, '');
  if (!clean) return null;
  const title = encodeURIComponent(`File:${clean}`);
  const j = await wikiJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1200&titles=${title}`);
  const page = Object.values(j.query?.pages || {})[0];
  const ii = page?.imageinfo?.[0];
  if (!ii) return null;
  const md = ii.extmetadata || {};
  return {
    pageid: page.pageid || null,
    filename: clean,
    license: stripHtml(md.LicenseShortName?.value || ''),
    author: stripHtml(md.Artist?.value || '') || null,
    description: stripHtml(md.ImageDescription?.value || '') || null,
    categories: stripHtml(md.Categories?.value || '') || null,
    source_url: ii.descriptionurl,
    image_url: ii.url,
    thumbnail_url: ii.thumburl || ii.url,
    width: Number(ii.width || 0),
    height: Number(ii.height || 0),
    mime: ii.mime || null,
  };
}

async function searchCommons(search, maxRows) {
  const files = [];
  let offset = 0;
  while (files.length < maxRows) {
    const limit = Math.min(50, maxRows - files.length);
    const j = await wikiJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=${limit}&sroffset=${offset}&srsearch=${encodeURIComponent(search)}`);
    const rows = j.query?.search || [];
    files.push(...rows.map((r) => String(r.title || '').replace(/^File:/i, '')).filter(Boolean));
    if (!rows.length || j.continue?.sroffset == null) break;
    offset = j.continue.sroffset;
  }
  return files.slice(0, maxRows);
}

async function categoryFiles(category, maxRows = MAX_CATEGORY_FILES) {
  const files = [];
  let cmcontinue = null;
  while (files.length < maxRows) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', list: 'categorymembers',
      cmtitle: `Category:${category}`, cmnamespace: '6', cmtype: 'file',
      cmlimit: String(Math.min(50, maxRows - files.length)),
    });
    if (cmcontinue) params.set('cmcontinue', cmcontinue);
    const j = await wikiJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    const rows = j.query?.categorymembers || [];
    files.push(...rows.map((r) => String(r.title || '').replace(/^File:/i, '')).filter(Boolean));
    cmcontinue = j.continue?.cmcontinue || null;
    if (!rows.length || !cmcontinue) break;
  }
  return files.slice(0, maxRows);
}

function scoreCandidate(fighter, info, discoveryMethod) {
  if (!info?.image_url || !ALLOWED_LICENSE.test(info.license || '')) return null;
  if (!/^image\//i.test(info.mime || '')) return null;
  if (Math.min(info.width, info.height) < MIN_SOURCE_EDGE) return null;

  const aspect = info.width / Math.max(info.height, 1);
  if (aspect < 0.30 || aspect > 1.65) return null;

  const evidence = `${info.filename} ${info.description || ''} ${info.categories || ''}`;
  const name = nameSignal(fighter.name, evidence);
  const exactTitle = exactTitleSignal(fighter.name, info.filename);
  const mmaContext = MMA_CONTEXT.test(evidence);

  let identityConfidence = 0.30;
  if (discoveryMethod === 'wikidata_p18') identityConfidence = 1;
  else if (discoveryMethod === 'commons_depicts_qid') identityConfidence = 0.995;
  else if (discoveryMethod === 'wikidata_commons_category') identityConfidence = name ? 0.97 : 0.84;
  else if (exactTitle && mmaContext) identityConfidence = 0.94;
  else if (name && mmaContext) identityConfidence = 0.88;
  else if (name) identityConfidence = 0.74;

  let composition = 0;
  if (aspect >= 0.50 && aspect <= 1.05) composition += 24;
  else if (aspect <= 1.30) composition += 12;
  if (exactTitle) composition += 14;
  if (/portrait|headshot|weigh.?in|media.?day|faceoff/i.test(info.filename)) composition += 10;
  if (/group|crowd|team|press conference| with | and | vs /i.test(info.filename)) composition -= 15;
  if (mmaContext) composition += 6;
  composition += Math.min(10, Math.log2(Math.max(info.width, info.height) / MIN_SOURCE_EDGE + 1) * 3);

  // Existing shallow worker requires name evidence for curated overrides, so
  // we deliberately keep the same condition for automated publication. Files
  // identified only by Structured Data remain excellent review candidates.
  const autoPublish = name && identityConfidence >= 0.95 && composition >= 10;
  return { identityConfidence, composition, name, exactTitle, mmaContext, autoPublish, total: identityConfidence * 100 + composition };
}

function candidateRow(fighter, entityResult, info, method, score) {
  return {
    fighter_id: fighter.id,
    source_family: 'wikimedia_commons',
    provider_asset_id: info.pageid ? String(info.pageid) : info.filename,
    source_url: info.source_url,
    image_url: info.image_url,
    thumbnail_url: info.thumbnail_url,
    license: info.license,
    author: info.author,
    attribution_text: `${info.author || 'Unknown author'}, ${info.license}, via Wikimedia Commons`,
    rights_label: 'verified_free',
    discovery_method: method,
    identity_confidence: score.identityConfidence,
    rights_confidence: 1,
    identity_evidence: {
      qid: entityResult?.qid || null,
      wikidata_evidence: entityResult?.evidence || null,
      fighter_name_in_metadata: score.name,
      exact_title: score.exactTitle,
      mma_context: score.mmaContext,
    },
    metadata: {
      filename: info.filename,
      width: info.width,
      height: info.height,
      composition_score: score.composition,
    },
    status: score.autoPublish ? 'auto_approved' : 'needs_review',
  };
}

async function discoverFighter(fighter) {
  const entityResult = await resolveEntity(fighter);
  const sources = [];
  if (entityResult.status === 'ok') {
    const p18 = entityResult.entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (p18) sources.push({ method: 'wikidata_p18', files: [p18] });

    // Commons CirrusSearch supports Structured Data statement search. This is
    // much stronger identity evidence than free-text because P180 explicitly
    // says the media depicts this verified Wikidata entity.
    sources.push({
      method: 'commons_depicts_qid',
      files: await searchCommons(`haswbstatement:P180=${entityResult.qid}`, MAX_DEPICTS_FILES),
    });

    const category = commonsCategory(entityResult.entity);
    if (category) sources.push({ method: 'wikidata_commons_category', files: await categoryFiles(category) });
  }

  // Exact-name search is discovery-only unless the file independently carries
  // enough identity/context evidence to clear the conservative score.
  sources.push({ method: 'commons_exact_name', files: await searchCommons(`"${fighter.name}"`, MAX_SEARCH_FILES) });

  const seen = new Set();
  const candidates = [];
  for (const source of sources) {
    for (const file of source.files) {
      const key = norm(file);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        const info = await commonsImageInfo(file);
        const score = scoreCandidate(fighter, info, source.method);
        if (!score) continue;
        const row = candidateRow(fighter, entityResult, info, source.method, score);
        await upsertCandidate(row);
        candidates.push({ info, row, score });
      } catch (error) {
        console.warn(`  candidate ${file}: ${error.message}`);
      }
    }
  }

  candidates.sort((a, b) => b.score.total - a.score.total || a.info.filename.localeCompare(b.info.filename));
  return { entityResult, candidates };
}

async function missingPriorityFighters() {
  const fighters = await sbSelectAll('ufc_fighters', 'select=id,name,nickname,dob,is_active,espn_athlete_id,ufcstats_id&order=name.asc');
  const images = await sbSelectAll('ufc_images', 'select=fighter_id&fighter_id=not.is.null');
  const pictured = new Set(images.map((row) => row.fighter_id).filter(Boolean));
  let missing = fighters.filter((fighter) => !pictured.has(fighter.id));

  if (ONLY_FIGHTER) return missing.filter((fighter) => fighter.id === ONLY_FIGHTER);

  const today = new Date().toISOString().slice(0, 10);
  const bouts = await sbSelectAll('ufc_bouts', `select=fighter_a_id,fighter_b_id,ufc_events!inner(event_date)&ufc_events.event_date=gte.${today}&status=neq.cancelled&limit=5000`);
  const booked = new Set();
  for (const bout of bouts) {
    booked.add(bout.fighter_a_id);
    booked.add(bout.fighter_b_id);
  }

  missing.sort((a, b) =>
    Number(booked.has(b.id)) - Number(booked.has(a.id)) ||
    Number(Boolean(b.is_active)) - Number(Boolean(a.is_active)) ||
    a.name.localeCompare(b.name));
  return missing.slice(0, LIMIT);
}

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')); }
  catch { return {}; }
}

function publishCandidate(fighter, candidate) {
  if (!PUBLISH) return false;
  const originalText = fs.readFileSync(OVERRIDES_PATH, 'utf8');
  const overrides = loadOverrides();
  overrides[fighter.id] = {
    name: fighter.name,
    file: candidate.info.filename,
    review_note: `Auto-discovered ${new Date().toISOString()} by deep_fighter_media.mjs via ${candidate.row.discovery_method}; Commons license and identity gates passed.`,
  };

  try {
    fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(overrides, null, 2)}\n`);
    const run = spawnSync(process.execPath, [SHALLOW_WORKER, '--fighter', fighter.id, '--force'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    return run.status === 0 && /\bok\b/i.test(run.stdout || '');
  } finally {
    fs.writeFileSync(OVERRIDES_PATH, originalText);
  }
}

async function main() {
  const fighters = await missingPriorityFighters();
  const totals = {
    selected: fighters.length,
    entities_ok: 0,
    candidates: 0,
    auto_approved: 0,
    published: 0,
    review_only: 0,
    no_candidate: 0,
    errors: 0,
  };

  console.log(`PBE deep fighter media: selected=${fighters.length} dry_run=${DRY_RUN} publish=${PUBLISH}`);

  for (const fighter of fighters) {
    console.log(`\n${fighter.id}  ${fighter.name}`);
    try {
      const result = await discoverFighter(fighter);
      if (result.entityResult.status === 'ok') totals.entities_ok++;
      totals.candidates += result.candidates.length;
      const auto = result.candidates.filter((candidate) => candidate.score.autoPublish);
      totals.auto_approved += auto.length;
      totals.review_only += result.candidates.length - auto.length;

      const best = auto[0] || null;
      if (!result.candidates.length) totals.no_candidate++;
      console.log(`  entity=${result.entityResult.status}${result.entityResult.qid ? ` ${result.entityResult.qid}` : ''} candidates=${result.candidates.length} auto=${auto.length}`);
      if (result.candidates[0]) {
        const top = result.candidates[0];
        console.log(`  top=${top.info.filename} | ${top.info.license} | identity=${top.score.identityConfidence.toFixed(3)} | composition=${top.score.composition.toFixed(1)} | ${top.row.status}`);
      }
      if (best && publishCandidate(fighter, best)) totals.published++;
    } catch (error) {
      totals.errors++;
      console.error(`  ERROR ${error.message}`);
    }
  }

  console.log('\nSUMMARY');
  for (const [key, value] of Object.entries(totals)) console.log(`${key.padEnd(18)} ${value}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
