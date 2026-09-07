#!/usr/bin/env node
// Ingest the curated referee dossiers in data/referees/ into the referee
// tables.
//
//   node scripts/images/ingest_referee_media.mjs [--dry-run] [--limit N] [--force]
//
// Those 64 files already carry a completed media search, a verified Wikidata
// identity, a sourced biography, and — where one was found — a Commons
// portrait with its licence, author, attribution, source dimensions and focal
// point. All of that work was done and then never reached the database, which
// is why every referee listing renders initials and every profile has no bio.
// This is the missing step, not a new pipeline.
//
// What it will not do:
//
//   It writes a portrait only when the dossier recorded one with a licence on
//   our allowlist. A referee whose media search found nothing keeps the
//   initials fallback — a wrong face on an official's profile is worse than
//   no face, and there is no guessing here.
//
//   It writes a biography only when the dossier carries a source URL for it.
//   Nothing is composed, summarised from thin air, or inferred from the
//   fight record. Missing stays missing.
//
//   Images are stored first-party. The Commons URL is the provenance, not the
//   src attribute.
//
// The focal point from the dossier drives the crop, so a standing photograph
// is cropped to the head rather than centred on the chest.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const sharp = require(path.join(ROOT, 'web', 'node_modules', 'sharp'));

const DIR = path.join(ROOT, 'data', 'referees');
const BUCKET = 'ufc-media';
const USER_AGENT = 'PropBetEdgeUFC/1.1 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';
const LICENSE_OK = /^(CC0(\s*1\.0)?|Public domain|CC BY \d(\.\d)?|CC BY-SA \d(\.\d)?)$/i;

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const LIMIT = opt('--limit') ? Number(opt('--limit')) : Infinity;

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

async function sb(pathAndQuery, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { ...SB, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`supabase ${res.status} on ${pathAndQuery.split('?')[0]}: ${(await res.text()).slice(0, 160)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function upload(key, buf) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { ...SB, 'Content-Type': 'image/webp', 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error(`storage ${res.status}: ${(await res.text()).slice(0, 140)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`;
}

/**
 * Crop to a 3:4 portrait around the dossier's focal point.
 *
 * A plain centre crop of a standing photograph takes the torso and cuts the
 * top of the head. focal_y is where the face actually is, so the window is
 * positioned around it and then clamped inside the image — which is what
 * stops a high focal point from producing a crop that runs off the top edge.
 */
async function portrait(buf, focalX = 0.5, focalY = 0.35) {
  const img = sharp(buf);
  const meta = await img.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error('unreadable image');

  const targetRatio = 3 / 4;
  let cw = Math.min(W, Math.round(H * targetRatio));
  let ch = Math.round(cw / targetRatio);
  if (ch > H) { ch = H; cw = Math.round(ch * targetRatio); }

  const left = Math.max(0, Math.min(W - cw, Math.round(focalX * W - cw / 2)));
  const top = Math.max(0, Math.min(H - ch, Math.round(focalY * H - ch / 2)));

  return sharp(buf).extract({ left, top, width: cw, height: ch }).resize(660, 880, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
}

const main = async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  const counts = { image: 0, bio: 0, no_media: 0, rejected: 0, skipped: 0, error: 0 };
  let processed = 0;

  console.log(`${files.length} curated referee dossier(s)${DRY ? ' [DRY RUN]' : ''}${FORCE ? ' [FORCE]' : ''}\n`);

  for (const f of files) {
    if (processed >= LIMIT) break;
    processed += 1;
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const name = j.name;
    const patch = {};

    try {
      /* ---- biography, only when the dossier cites a source ---- */
      if (j.bio?.text && j.bio?.source_url) {
        patch.bio = j.bio.text;
        patch.bio_source_url = j.bio.source_url;
        patch.bio_source_name = j.bio.source_name ?? null;
        patch.bio_verified_at = j.bio.verified_at ?? null;
        counts.bio += 1;
      }
      const country = j.facts?.country?.value ?? j.facts?.nationality?.value ?? null;
      if (country) patch.country = country;

      /* ---- portrait, only when one was found and licensed ---- */
      const m = j.media;
      if (!m || !m.source_url) {
        counts.no_media += 1;
      } else if (!LICENSE_OK.test(String(m.license_type || ''))) {
        counts.rejected += 1;
        console.log(`  ${String(name).padEnd(22)} rejected   licence not permitted: ${m.license_type}`);
      } else if (DRY) {
        counts.image += 1;
        console.log(`  ${String(name).padEnd(22)} would set  ${m.license_type} by ${m.author} (focal ${m.focal_x}/${m.focal_y})`);
      } else {
        const src = Buffer.from(await (await fetch(m.source_url, { headers: { 'User-Agent': USER_AGENT } })).arrayBuffer());
        const webp = await portrait(src, Number(m.focal_x ?? 0.5), Number(m.focal_y ?? 0.35));
        const url = await upload(`referees/${j.slug}-660.webp`, webp);
        patch.image_url = url;
        patch.image_source_url = m.source_page_url ?? null;
        patch.image_credit = m.attribution ?? m.author ?? null;
        patch.image_license = m.license_type ?? null;
        counts.image += 1;
        console.log(`  ${String(name).padEnd(22)} portrait   ${m.license_type} by ${m.author} -> referees/${j.slug}-660.webp`);
      }

      if (!Object.keys(patch).length) { counts.skipped += 1; continue; }
      if (DRY) continue;

      /* ufc_referee_directory is a VIEW over the profile table joined to the
       * bout aggregates, so it is not writable. The profile row is the one
       * that owns these columns; the directory picks them up from it. */
      await sb(`ufc_referee_profiles?canonical_name=eq.${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    } catch (e) {
      counts.error += 1;
      console.log(`  ${String(name).padEnd(22)} error      ${String(e.message).slice(0, 110)}`);
    }
  }

  console.log('\nsummary');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log('\nReferees whose media search found nothing keep the initials fallback, and no biography was written without a source.');
};

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
