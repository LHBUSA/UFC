#!/usr/bin/env node
// Licensed referee-portrait pipeline.
//
//   ufc_referee_directory -> Wikidata identity (must be a referee) ->
//   Commons imageinfo (same license allowlist as the fighter pipeline) ->
//   sharp derivative -> Supabase Storage bucket ufc-media -> image_url,
//   image_source_url, image_credit and image_license on the referee rows.
//
// Usage: node scripts/images/fetch_referee_portraits.mjs
//          [--limit N] [--min-bouts N] [--dry-run] [--force] [--name "..."]
//
// Why a separate script rather than a flag on the fighter one: a referee is
// not a row in ufc_fighters and its images are not rows in ufc_images. The
// referee tables carry their own image_url/credit/license columns, so the
// destination differs even though every rule about getting there is shared.
//
// The rules that are shared, and are not relaxed here:
//
//   Only free Wikimedia licenses (CC0, Public domain, CC BY x.x, CC BY-SA
//   x.x). Anything else is rejected and nothing is downloaded.
//
//   Identity is locked before an image is accepted. A Wikidata entity is only
//   used if it actually describes a referee or an official — matching on a
//   name alone is how a photograph of a different person with the same name
//   ends up on a profile, which is worse than having no photograph.
//
//   Stored first-party. Commons is not hotlinked; the derivative is uploaded
//   to our own bucket and the referee row points at that.
//
// A referee with no identity-safe, acceptably licensed image gets no row
// change at all, and the site keeps its initials fallback.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const sharp = require(path.join(ROOT, 'web', 'node_modules', 'sharp'));

const USER_AGENT = 'PropBetEdgeUFC/1.1 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';
const BUCKET = 'ufc-media';
const WIKI_MIN_INTERVAL_MS = 500;
const MIN_SOURCE_EDGE = 320;
const LICENSE_OK = /^(CC0(\s*1\.0)?|Public domain|CC BY \d(\.\d)?|CC BY-SA \d(\.\d)?)$/i;
/* The entity must read as an official, not merely as a person with this name. */
const REFEREE_DESC = /referee|mixed martial art|\bMMA\b|official/i;

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const flag = (n) => argv.includes(n);
const LIMIT = opt('--limit') ? Number(opt('--limit')) : Infinity;
const MIN_BOUTS = opt('--min-bouts') ? Number(opt('--min-bouts')) : 40;
const ONLY_NAME = opt('--name');
const DRY = flag('--dry-run');
const FORCE = flag('--force');

/* Load .env the same way the rest of the backfill does. */
for (const f of ['.env', '.env.local']) {
  const file = path.join(ROOT, f);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.trimStart().startsWith('#')) continue;
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }
const SB = { apikey: KEY, Authorization: `Bearer ${KEY}` };

let lastWiki = 0;
async function wikiFetch(url) {
  const wait = WIKI_MIN_INTERVAL_MS - (Date.now() - lastWiki);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastWiki = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`wiki ${res.status} ${url.slice(0, 90)}`);
  return res.json();
}

async function sb(pathAndQuery, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { ...SB, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`supabase ${res.status} on ${pathAndQuery.split('?')[0]}: ${(await res.text()).slice(0, 160)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function storageUpload(key, buf, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { ...SB, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error(`storage upload ${key} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`;
}

/* ---- identity ----------------------------------------------------------- */

async function findEntity(name) {
  const j = await wikiFetch(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=6&search=${encodeURIComponent(name)}`,
  );
  const hits = j?.search || [];
  const plausible = hits.filter((h) => REFEREE_DESC.test(`${h.description || ''} ${h.label || ''}`));
  if (!plausible.length) return { entity: null, why: 'no referee/official candidate on Wikidata' };
  if (plausible.length > 1) {
    /* An exact label match breaks a tie; anything else is left alone rather
     * than resolved by guesswork. */
    const exact = plausible.filter((h) => String(h.label).toLowerCase() === name.toLowerCase());
    if (exact.length !== 1) return { entity: null, why: `${plausible.length} plausible entities, none decisive` };
    return { entity: exact[0].id, why: null };
  }
  return { entity: plausible[0].id, why: null };
}

/* Reviewed name variants. Referees are often catalogued under a nickname —
 * "Big John McCarthy" is the same official as "John McCarthy" — and searching
 * the bare directory name finds nothing. These are aliases for the LOOKUP
 * only; the identity lock and the license gate are unchanged, and nothing is
 * written under a different name. */
const NAME_ALIASES = {
  'John McCarthy': ['Big John McCarthy'],
  'Mario Yamasaki': ['Mario Yamasaki'],
  'Marc Goddard': ['Marc Goddard'],
};

async function entityImage(qid, name) {
  const j = await wikiFetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const e = j?.entities?.[qid];
  const label = e?.labels?.en?.value || '';
  /* Name lock: the entity we are about to take a face from must be the person
   * the referee row names. */
  if (label && label.toLowerCase() !== name.toLowerCase()) {
    const a = new Set((e?.aliases?.en || []).map((x) => String(x.value).toLowerCase()));
    for (const alias of NAME_ALIASES[name] || []) a.add(String(alias).toLowerCase());
    if (!a.has(name.toLowerCase())) return { file: null, why: `entity label "${label}" does not match "${name}"` };
  }
  const file = e?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (file) return { file, why: null, via: 'P18' };
  /* No P18. The entity's own Commons category is still an identity-linked
   * source — it is the category Wikidata itself points at for this person —
   * so a file from it is name-locked in the same way a P18 is. A category we
   * had to guess at would not be, and is not attempted. */
  const cat = e?.claims?.P373?.[0]?.mainsnak?.datavalue?.value
    || (e?.sitelinks?.commonswiki?.title || '').replace(/^Category:/, '');
  if (!cat) return { file: null, why: `${qid} has no P18 and no linked Commons category` };
  const files = await commonsCategoryFiles(cat);
  if (!files.length) return { file: null, why: `Commons category "${cat}" has no usable file` };
  return { file: files[0], why: null, via: `Category:${cat}` };
}

/**
 * Direct Commons search, used when Wikidata has nothing.
 *
 * A P18 claim and a linked category are the two identity-safe routes, and
 * most officials have neither — which says the METADATA is thin, not that no
 * photograph exists. So the file namespace is searched directly.
 *
 * The catch is that a name search is not an identity check: "Mark Smith"
 * matches a great many photographs of a great many people. Every candidate
 * therefore has to survive a filename gate before it is even considered — the
 * name must appear, and something in the file must tie it to this sport. A
 * file that merely contains the name is discarded, because a wrong face on an
 * official's profile is worse than no face at all.
 */
async function commonsSearchFiles(name, aliases = []) {
  /* The bare name first. Appending "referee" to the query looked like it
   * would sharpen the search and instead suppressed it: Commons indexes
   * filenames and descriptions, and "Herb Dean referee" matches far less than
   * "Herb Dean" does. The sport check belongs in the identity gate below,
   * where it can look at the actual filename, not in the query. */
  const terms = [name, ...aliases];
  const out = [];
  for (const t of terms) {
    const j = await wikiFetch(
      `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=20&srsearch=${encodeURIComponent(t)}`,
    );
    for (const hit of j?.query?.search || []) {
      const file = String(hit.title).replace(/^File:/, '');
      if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
      out.push({ file, matchedTerm: t });
    }
  }
  return out;
}

/** Does this filename plausibly depict THIS person in THIS sport? */
function filenameIdentityGate(file, name, aliases = []) {
  const f = file.toLowerCase().replace(/[_-]+/g, ' ');
  const names = [name, ...aliases].map((n) => n.toLowerCase());
  const surname = String(name).split(/\s+/).pop().toLowerCase();
  const hasName = names.some((n) => f.includes(n)) || (surname.length > 4 && f.includes(surname));
  if (!hasName) return { ok: false, why: 'filename does not carry the name' };
  const sportish = /(mma|ufc|referee|cage|octagon|fight|bellator|weigh)/.test(f);
  if (!sportish) return { ok: false, why: 'filename carries the name but nothing tying it to the sport' };
  return { ok: true };
}

async function commonsCategoryFiles(category) {
  const j = await wikiFetch(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=categorymembers&cmtitle=${encodeURIComponent(`Category:${category}`)}&cmnamespace=6&cmtype=file&cmlimit=12`,
  );
  return (j?.query?.categorymembers || [])
    .map((m) => String(m.title).replace(/^File:/, ''))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
}

async function commonsInfo(filename) {
  const j = await wikiFetch(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1200&titles=${encodeURIComponent(`File:${filename}`)}`,
  );
  const page = Object.values(j?.query?.pages || {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) return { ok: false, why: 'no imageinfo' };
  const meta = info.extmetadata || {};
  const license = String(meta.LicenseShortName?.value || '').trim();
  if (!LICENSE_OK.test(license)) return { ok: false, why: `license not permitted: ${license || 'unknown'}` };
  if (!/^image\/(jpeg|png|webp)$/.test(info.mime || '')) return { ok: false, why: `mime ${info.mime}` };
  if (Math.min(info.width || 0, info.height || 0) < MIN_SOURCE_EDGE) return { ok: false, why: `source too small (${info.width}x${info.height})` };
  const author = String(meta.Artist?.value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null;
  return {
    ok: true,
    url: info.thumburl || info.url,
    license,
    author,
    descriptionurl: info.descriptionurl,
    width: info.width,
    height: info.height,
  };
}

/* ---- main --------------------------------------------------------------- */

const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const main = async () => {
  const q = ONLY_NAME
    ? `ufc_referee_directory?select=name,slug,bouts,image_url&name=eq.${encodeURIComponent(ONLY_NAME)}`
    : `ufc_referee_directory?select=name,slug,bouts,image_url&bouts=gte.${MIN_BOUTS}&order=bouts.desc`;
  let refs = await sb(q);
  if (!FORCE) refs = refs.filter((r) => !r.image_url);

  console.log(`${refs.length} referee(s) without a portrait, ${MIN_BOUTS}+ bouts${DRY ? ' [DRY RUN]' : ''}${FORCE ? ' [FORCE]' : ''}`);
  const counts = { ok: 0, no_entity: 0, no_image: 0, rejected: 0, error: 0 };
  let processed = 0;

  for (const r of refs) {
    if (processed >= LIMIT) break;
    processed += 1;
    const label = `${String(r.name).padEnd(24)} ${String(r.bouts).padStart(4)} bouts`;
    try {
      let { entity, why: ew } = await findEntity(r.name);
      for (const alias of NAME_ALIASES[r.name] || []) {
        if (entity) break;
        ({ entity, why: ew } = await findEntity(alias));
      }

      /* No Wikidata entity is not the end of the search. It means nobody has
       * written a structured record for this official — which says nothing
       * about whether a freely licensed photograph of them exists on Commons.
       * Treating a failed entity lookup as proof of absence is how a
       * perfectly available picture goes unused. */
      let file = null;
      let iw = ew;
      let route = null;
      if (entity) {
        ({ file, why: iw } = await entityImage(entity, r.name));
        if (file) route = 'wikidata';
      }
      if (!file) {
        /* Wikidata had nothing. Search Commons directly and gate every
         * candidate on the filename before accepting one. */
        const candidates = await commonsSearchFiles(r.name, NAME_ALIASES[r.name] || []);
        const gated = [];
        for (const c of candidates) {
          const g = filenameIdentityGate(c.file, r.name, NAME_ALIASES[r.name] || []);
          if (g.ok) gated.push(c.file);
        }
        if (gated.length) { file = gated[0]; route = `commons-search (${candidates.length} candidate(s), ${gated.length} passed the identity gate)`; }
        else if (candidates.length) iw = `${iw}; commons search returned ${candidates.length} file(s), none passed the identity gate`;
        else iw = `${iw}; commons search returned nothing`;
      }
      if (!file) {
        counts[entity ? 'no_image' : 'no_entity'] += 1;
        console.log(`  ${label}  ${entity ? 'no_image ' : 'no_entity'}     ${iw}`);
        continue;
      }

      const info = await commonsInfo(file);
      if (!info.ok) { counts.rejected += 1; console.log(`  ${label}  rejected      ${info.why}`); continue; }

      if (DRY) { counts.ok += 1; console.log(`  ${label}  ok            DRY ${info.license} by ${info.author || '?'} <- ${file} [${route}]`); continue; }

      const src = Buffer.from(await (await fetch(info.url, { headers: { 'User-Agent': USER_AGENT } })).arrayBuffer());
      /* A portrait crop anchored on the upper body, never a blind centre crop
       * — a centred square on a standing photograph takes the chest and cuts
       * the forehead, which is the specific failure this project keeps
       * hitting. `position: top` keeps the head in frame. */
      const webp = await sharp(src).resize(660, 880, { fit: 'cover', position: 'top' }).webp({ quality: 82 }).toBuffer();
      const key = `referees/${r.slug || slugify(r.name)}-660.webp`;
      const publicUrl = await storageUpload(key, webp, 'image/webp');

      const patch = {
        image_url: publicUrl,
        image_source_url: info.descriptionurl,
        image_credit: info.author,
        image_license: info.license,
      };
      /* ufc_referee_directory is a VIEW; the profile row owns these columns
       * and the directory reads them from it, so a listing and a profile
       * cannot disagree about a licence. */
      await sb(`ufc_referee_profiles?canonical_name=eq.${encodeURIComponent(r.name)}`, { method: 'PATCH', body: JSON.stringify(patch) });

      counts.ok += 1;
      console.log(`  ${label}  ok            ${info.license} by ${info.author || '?'} -> ${key}`);
    } catch (e) {
      counts.error += 1;
      console.log(`  ${label}  error         ${String(e.message).slice(0, 110)}`);
    }
  }

  console.log('\nsummary');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log('\nReferees without an identity-safe, freely licensed portrait are left untouched and keep the initials fallback.');
};

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
