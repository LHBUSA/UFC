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

/* PORTABILITY NOTE.
 *
 * This module runs in two places: the CLI (Node, sharp, a .env file, a
 * lookup cache on disk) and the ufc-media Worker (workerd, Cloudflare image
 * transformations, KV). Everything that DIFFERS between them is injected
 * through the context object below; everything that MATTERS -- the Wikidata
 * identity resolution, the Commons license allowlist, the candidate scoring,
 * the name lock -- is shared, unchanged, and has exactly one implementation.
 *
 * Nothing is read from process.argv, process.env or the filesystem at module
 * scope. argv is empty in workerd, so an option read at import is frozen for
 * the life of the isolate, and node:fs paths built from import.meta.url throw
 * the Worker's startup before any handler runs.
 */
/* Set once per invocation by main(). Every invocation in a given isolate
 * carries the same bindings, so this is stable rather than shared mutable
 * state in the dangerous sense; it is still the only module-scope value that
 * changes, and it is set before any other function is called. */
let CTX = null;

// ---------------------------------------------------------------- config
const USER_AGENT = 'PropBetEdgeUFC/1.1 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';
const BUCKET = 'ufc-media';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WIKI_MIN_INTERVAL_MS = 500; // ~2 req/s to Wikimedia
const MMA_DESC = /mixed martial art|\bMMA\b|fighter/i;
/* The short description is written by whoever last edited the item, and it
 * is often not about MMA at all: Ross Pearson's reads "English martial
 * artist". Requiring the keyword there left 24 identity-provable TUF alumni
 * with no entity (scout 2026-09-12). The structured claims are the better
 * evidence, so an item also qualifies when it states the occupation or the
 * sport, or carries a UFC / Sherdog / Tapology / ESPN fighter identifier. The
 * DOB check below is unchanged. */
const MMA_OCCUPATION = 'Q11607585';
const MMA_SPORT = 'Q114466';
const MMA_ID_PROPS = ['P9722', 'P2818', 'P9728', 'P10073'];
const CATEGORY_CANDIDATE_LIMIT = 12;
/* Two floors. The free-text search route keeps 420px: there the file is all
 * the evidence there is. A file reached through the fighter's own verified
 * item (its P18, its linked Commons category, or a curated file whose item
 * or structured "depicts" names the fighter) needs only to be usable, and 420
 * rejected genuine portraits such as the 480x360 UFC 100 Fan Expo photographs
 * of Forrest Griffin and Diego Sanchez. */
const MIN_SOURCE_EDGE = 420;
const MIN_VERIFIED_EDGE = 260;
// Allowlist. Anything that does not match is rejected (fair use, NC, ND, GFDL-only, ...).
const LICENSE_OK = /^(CC0(\s*1\.0)?|Public domain|CC BY \d(\.\d)?|CC BY-SA \d(\.\d)?)$/i;

/* CLI flags -> an options object. The Worker passes its own.
 * `missingOnly` defaults TRUE: a run must not re-examine fighters that
 * already have a good stored portrait, and `force` is the deliberate
 * override rather than the default posture. */
export function parseCliOptions(argv = []) {
  const flag = (n) => argv.includes(n);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    limit: opt('--limit') ? Number(opt('--limit')) : Infinity,
    force: flag('--force'),
    dry: flag('--dry-run'),
    onlyFighter: opt('--fighter') || null,
    namesFile: opt('--names') || null,
    missingOnly: flag('--no-missing-only') ? false : true,
    priority: !flag('--no-priority'),
  };
}

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
    return asJson ? res.json() : new Uint8Array(await res.arrayBuffer());
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

/**
 * The first and last name tokens ADJACENT to each other, not merely both
 * present somewhere.
 *
 * nameSignal() above asks only whether both tokens appear in the evidence
 * anywhere, which its own comment justifies as conservative enough WHEN the
 * candidate came from a category already linked to the fighter's verified
 * Wikidata entity. On the text-search fallback that premise does not hold, and
 * on 2026-09-10 it accepted a US Navy carpentry photo for the middleweight
 * Aaron Jeffery: the caption reads "Cmdr. Jeffery P. Eaton saws a baseboard
 * while Aviation Structural Mechanic 2nd Class Aaron Sieg watches". Two
 * different men, neither of them the fighter, and both tokens present.
 *
 * Up to two intervening tokens are allowed so that middle names and patronyms
 * still match ("Antonio Rodrigo Nogueira", "Israel Adesanya" written with a
 * nickname between).
 */
export function nameAdjacent(fighterName, text) {
  const parts = norm(fighterName).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return nameSignal(fighterName, text);
  const first = parts[0];
  const last = parts[parts.length - 1];
  /* Token walk rather than a built regex. norm() has already reduced both
   * sides to [a-z0-9 ], so there is no metacharacter left to escape and an
   * escaping step here would be dead code dressed as a safety measure. */
  const tokens = norm(text).split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== first) continue;
    for (let gap = 1; gap <= 3; gap += 1) {
      if (tokens[i + gap] === last) return true;
    }
  }
  return false;
}

/* Curated Commons files for fighters whose Wikidata entity lacks a usable
 * image link. Reviewed by hand, and still license-checked and name-locked at
 * runtime below -- an override chooses a CANDIDATE, it never bypasses a gate. */
const overrides = () => CTX.overrides || {};

async function sbSelectAll(table, query) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${CTX.supabaseUrl}/rest/v1/${table}?${query}`, {
      headers: { ...CTX.headers, Range: `${from}-${from + page - 1}`, 'Range-Unit': 'items' },
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
  const res = await fetch(`${CTX.supabaseUrl}/rest/v1/ufc_images?on_conflict=r2_key`, {
    method: 'POST',
    headers: { ...CTX.headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`upsert ufc_images ${res.status}: ${await res.text()}`);
}

async function storageUpload(key, buf, contentType) {
  const res = await fetch(`${CTX.supabaseUrl}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { ...CTX.headers, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error(`storage upload ${key} ${res.status}: ${await res.text()}`);
}

/* The lookup cache is 30-day memory of 'we already asked Wikidata about this
 * fighter'. On disk for the CLI, in KV for the Worker; the shape is the same
 * and neither knows about the other. */
const cacheGet = () => CTX.cache.load();
const cacheSet = (c) => CTX.cache.save(c);

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

const claimIds = (entity, prop) => (entity?.claims?.[prop] || []).map((c) => c?.mainsnak?.datavalue?.value?.id || c?.mainsnak?.datavalue?.value).filter(Boolean);

/** Does the item itself say this is a mixed martial artist? */
export function isMmaEntity(entity) {
  if (!entity) return false;
  if (claimIds(entity, 'P106').includes(MMA_OCCUPATION)) return true;
  if (claimIds(entity, 'P641').includes(MMA_SPORT)) return true;
  return MMA_ID_PROPS.some((p) => claimIds(entity, p).length > 0);
}

/** Returns {status:'ok', qid, entity} | {status:'no_entity'|'ambiguous', note} */
async function resolveEntity(fighter) {
  const q = encodeURIComponent(fighter.name);
  const j = await wikiFetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=5&search=${q}`);
  const cands = [];
  for (const s of j.search ?? []) {
    if (MMA_DESC.test(s.description ?? '')) { cands.push(s); continue; }
    if (isMmaEntity(await getEntity(s.id))) cands.push(s);
  }
  if (cands.length === 0) return { status: 'no_entity', note: 'no MMA candidate on Wikidata (description or occupation/sport/fighter-id claims)' };

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

const fileKey = (name) => String(name || '').replace(/^File:/i, '').replace(/_/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

/**
 * Proof that a Commons file depicts the fighter behind a Wikidata item, or
 * null. The item must itself be a mixed martial artist (isMmaEntity), and then
 * either its P18 image is this file, or the file's structured data carries
 * depicts (P180) = the item.
 */
async function entityProvesFile(qid, filename) {
  const entity = await getEntity(qid);
  if (!isMmaEntity(entity)) return null;
  const want = fileKey(filename);
  if ((entity?.claims?.P18 || []).some((c) => fileKey(c?.mainsnak?.datavalue?.value) === want)) return `${qid} P18`;
  const j = await wikiFetch(`https://commons.wikimedia.org/w/api.php?action=wbgetentities&format=json&sites=commonswiki&titles=${encodeURIComponent(`File:${want}`)}`);
  const media = Object.values(j?.entities || {})[0];
  const depicts = (media?.statements?.P180 || []).map((s) => s?.mainsnak?.datavalue?.value?.id);
  return depicts.includes(qid) ? `depicts ${qid}` : null;
}

async function commonsCategoryFiles(category) {
  const title = encodeURIComponent(`Category:${category}`);
  const j = await wikiFetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&list=categorymembers&cmtitle=${title}&cmnamespace=6&cmtype=file&cmlimit=${CATEGORY_CANDIDATE_LIMIT}`);
  return (j.query?.categorymembers ?? []).map((x) => String(x.title || '').replace(/^File:/i, '')).filter(Boolean);
}

function imageCandidateScore(fighter, info) {
  if (!info?.url || !LICENSE_OK.test(info.license || '')) return -Infinity;
  if (!/^image\//i.test(info.mime || '')) return -Infinity;
  /* Category route only: the category is linked from the verified item. */
  if ((info.width || 0) < MIN_VERIFIED_EDGE || (info.height || 0) < MIN_VERIFIED_EDGE) return -Infinity;

  const evidence = `${info.filename || ''} ${info.description || ''} ${info.categories || ''}`;
  /* The hard gate. Adjacency, not co-occurrence: this is the line between
   * 'a file that mentions both names' and 'a file about this person'. */
  if (!nameAdjacent(fighter.name, evidence)) return -Infinity;

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
/* portrait / card / thumb, produced by whichever engine the host has.
 *
 * CLI: sharp, with strategy.attention for the salient crop.
 * Worker: Cloudflare image transformations, gravity auto, with the output
 *         dimensions parsed back out of the returned bytes -- an unavailable
 *         transformer returns the ORIGINAL silently, and uploading a 2000px
 *         original as card.jpg would stay invisible until someone looked.
 *
 * Both write the same three keys, because ufc-api and web/lib/db.ts build the
 * card and thumb URLs by string substitution on r2_key, so a missing
 * derivative is a 404 where a fighter's face should be. */
async function deriveAndUpload(fighterId, srcUrl) {
  return CTX.derive({ fighterId, srcUrl, storageUpload, prefix: `fighters/${fighterId}` });
}

async function finalizeImage(f, info, { qid = null, source }) {
  if (!info || !info.url) return { status: 'no_image', qid, note: `Commons has no imageinfo for ${source}` };
  if (!LICENSE_OK.test(info.license || '')) {
    return { status: 'license_rejected', qid, note: `${info.license || '(no license)'} - ${info.descriptionurl || source}` };
  }
  if (!/^image\//i.test(info.mime || '')) return { status: 'no_image', qid, note: `not an image MIME: ${info.mime || '?'} <- ${source}` };

  /* THE REPLACEMENT GATE. A stored portrait is never overwritten by a worse
   * one, and the trap is that a pipeline treats its newest answer as its best
   * one. It is not: Wikidata gets edited, a category gains a badly-cropped
   * file, a good image is superseded by a group shot that scores adequately.
   * The host decides, because only it knows what is already stored. */
  if (CTX.gate) {
    const verdict = await CTX.gate({ fighter: f, info });
    if (verdict && verdict.allow === false) {
      return { status: 'kept_existing', qid, note: verdict.why || 'existing image is not beaten by this candidate' };
    }
  }

  const r2_key = `fighters/${f.id}/portrait.jpg`;

  const row = { kind: 'wikimedia', r2_key, license: info.license, author: info.author, source_url: info.descriptionurl, fighter_id: f.id };
  if (CTX.dry) return { status: 'ok', qid, note: `DRY ${info.license} by ${info.author ?? '?'} <- ${source}`, row };

  const srcUrl = info.thumburl && info.width > 1200 ? info.thumburl : info.url;
  const sizes = await deriveAndUpload(f.id, srcUrl);
  await sbUpsertImage(row);
  return { status: 'ok', qid, note: `${info.license} by ${info.author ?? '?'} (${sizes}) <- ${source}`, row };
}

// ---------------------------------------------------------------- per fighter
async function processFighter(f) {
  const manual = overrides()[f.id];
  if (manual) {
    if (!manual.name || norm(manual.name) !== norm(f.name)) {
      return { status: 'error', note: `curated override name mismatch: ${manual.name || '(missing)'} != ${f.name}` };
    }
    if (!manual.file) return { status: 'error', note: 'curated override missing file' };
    const info = await commonsImageInfo(manual.file);
    const evidence = `${info?.filename || ''} ${info?.description || ''} ${info?.categories || ''}`;
    /* Identity is re-proved at runtime, never trusted from the override: the
     * file text names the fighter, or the override's Wikidata item is an MMA
     * fighter whose P18 is this file or whom the file's structured "depicts"
     * statement names. A filename like "Swick.png" carries no name but is
     * Mike Swick's item's own image. */
    const proof = !info ? null
      : nameAdjacent(f.name, evidence) ? 'file text names the fighter'
        : manual.qid ? await entityProvesFile(manual.qid, manual.file) : null;
    if (!proof) {
      return { status: 'error', note: `curated Commons file no longer carries identity evidence for ${f.name}: ${manual.file}` };
    }
    if (Math.min(info.width || 0, info.height || 0) < MIN_VERIFIED_EDGE) {
      return { status: 'no_image', note: `curated file below ${MIN_VERIFIED_EDGE}px: ${manual.file} (${info.width}x${info.height})` };
    }
    return finalizeImage(f, info, { qid: manual.qid || null, source: `CURATED:${manual.file} (${proof})` });
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
export async function main(injectedEnv, options = {}) {
  const env = injectedEnv || {};
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required');

  const o = {
    limit: options.limit ?? Infinity,
    force: Boolean(options.force),
    dry: Boolean(options.dry),
    onlyFighter: options.onlyFighter || null,
    names: options.names || null,
    missingOnly: options.missingOnly !== false,
    priority: options.priority !== false,
  };
  CTX = {
    supabaseUrl,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    overrides: options.overrides || {},
    cache: options.cache || { load: async () => ({}), save: async () => {} },
    derive: options.derive,
    dry: o.dry,
  };
  if (!CTX.derive) throw new Error('a derive() implementation is required');

  const today = new Date().toISOString().slice(0, 10);

  let fighters = o.onlyFighter
    ? await sbSelectAll('ufc_fighters', `select=id,name,nickname,dob&id=eq.${o.onlyFighter}`)
    : await sbSelectAll('ufc_fighters', 'select=id,name,nickname,dob&order=name.asc');
  if (o.onlyFighter && fighters.length === 0) throw new Error(`fighter ${o.onlyFighter} not found`);
  /* The full roster, captured before any filtering, so a name-list report can
   * tell "not in ufc_fighters at all" from "filtered out for another reason". */
  const allNames = new Set(fighters.map((f) => String(f.name)));

  if (o.names) {
    const wanted = o.names;
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

  if (o.missingOnly && !o.onlyFighter) {
    const existing = await sbSelectAll('ufc_images', 'select=fighter_id&kind=eq.wikimedia&fighter_id=not.is.null');
    const pictured = new Set(existing.map((r) => r.fighter_id).filter(Boolean));
    fighters = fighters.filter((f) => !pictured.has(f.id));
  }

  const prioritySet = new Set();
  if (o.priority && !o.onlyFighter && !o.names) {
    const bouts = await sbSelectAll('ufc_bouts', `select=fighter_a_id,fighter_b_id,ufc_events!inner(event_date)&ufc_events.event_date=gte.${today}`);
    for (const b of bouts) { prioritySet.add(b.fighter_a_id); prioritySet.add(b.fighter_b_id); }
    fighters.sort((a, b) => (prioritySet.has(b.id) - prioritySet.has(a.id)) || a.name.localeCompare(b.name));
  }

  const cache = await cacheGet();
  const counts = { ok: 0, no_entity: 0, no_image: 0, license_rejected: 0, ambiguous: 0, error: 0, skipped: 0, kept_existing: 0 };
  console.log(`${fighters.length} fighters selected${o.missingOnly ? ' without stored media' : ' from ufc_fighters'}, ${prioritySet.size} on upcoming cards, ${Object.keys(overrides()).length} curated override(s)${o.dry ? ' [DRY RUN]' : ''}${o.force ? ' [FORCE]' : ''}`);

  let processed = 0;
  for (const f of fighters) {
    if (processed >= o.limit) break;
    const c = cache[f.id];
    const fresh = c && Date.now() - Date.parse(c.checked_at) < CACHE_TTL_MS;
    if (fresh && !o.force && !o.onlyFighter) { counts.skipped++; continue; }
    processed++;
    const tag = prioritySet.has(f.id) ? '*' : ' ';
    let r;
    try { r = await processFighter(f); }
    catch (e) { r = { status: 'error', note: e.message }; }
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    console.log(`${tag} ${f.id}  ${f.name.padEnd(28)} ${r.status.padEnd(17)} ${r.note ?? ''}`);
    if (!o.dry && r.status !== 'error') {
      cache[f.id] = { status: r.status, checked_at: new Date().toISOString(), name: f.name, qid: r.qid ?? null, license: r.row?.license ?? null };
      await cacheSet(cache);
    }
  }

  console.log('\nsummary');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(17)} ${v}`);

  /* Returned rather than logged-and-grepped, so a Worker can ledger it. */
  return { counts, selected: fighters.length, processed, priority: prioritySet.size, dry: o.dry };
}

/* CLI ONLY. Importing this module must never fetch, derive or upload: the
 * previous version ran main() at module scope, so loading the file WAS the
 * pipeline. sharp, node:fs and the .env reader are pulled in here and nowhere
 * else, which is what keeps the module loadable inside workerd at all. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('fetch_fighter_portraits.mjs');
if (isCli) {
  const { createRequire } = await import('node:module');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = pathMod.dirname(fileURLToPath(import.meta.url));
  const root = pathMod.resolve(dir, '..', '..');
  const req = createRequire(import.meta.url);
  const sharp = req(pathMod.join(root, 'web', 'node_modules', 'sharp'));
  const JPEG = { quality: 84, mozjpeg: true };

  const envFile = {};
  const envPath = pathMod.join(root, '.env');
  if (fsMod.existsSync(envPath)) {
    for (const line of fsMod.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) envFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const env = { ...envFile, ...process.env };
  const opts = parseCliOptions(process.argv.slice(2));
  const cacheFile = pathMod.join(dir, 'cache', 'lookups.json');
  const overridesFile = pathMod.join(dir, 'commons_overrides.json');

  main(env, {
    ...opts,
    names: opts.namesFile ? JSON.parse(fsMod.readFileSync(opts.namesFile, 'utf8')) : null,
    overrides: fsMod.existsSync(overridesFile) ? JSON.parse(fsMod.readFileSync(overridesFile, 'utf8')) : {},
    cache: {
      load: async () => { try { return JSON.parse(fsMod.readFileSync(cacheFile, 'utf8')); } catch { return {}; } },
      save: async (c) => { fsMod.mkdirSync(pathMod.dirname(cacheFile), { recursive: true }); fsMod.writeFileSync(cacheFile, JSON.stringify(c, null, 1)); },
    },
    derive: async ({ srcUrl, storageUpload: up, prefix }) => {
      const res = await fetch(srcUrl, { headers: { 'User-Agent': USER_AGENT } });
      const buf = Buffer.from(await res.arrayBuffer());
      const base = sharp(buf, { failOn: 'none' }).rotate();
      const portrait = await base.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg(JPEG).toBuffer();
      const card = await base.clone().resize(800, 1000, { fit: 'cover', position: sharp.strategy.attention }).jpeg(JPEG).toBuffer();
      const thumb = await base.clone().resize(320, 400, { fit: 'cover', position: sharp.strategy.attention }).jpeg(JPEG).toBuffer();
      await up(`${prefix}/portrait.jpg`, portrait, 'image/jpeg');
      await up(`${prefix}/card.jpg`, card, 'image/jpeg');
      await up(`${prefix}/thumb.jpg`, thumb, 'image/jpeg');
      return [portrait.length, card.length, thumb.length].map((n) => `${Math.round(n / 1024)}k`).join('/');
    },
  }).catch((e) => { console.error(`portraits FAILED: ${e.message}`); process.exitCode = 1; });
}
