#!/usr/bin/env node
// Keep ufc_referee_profiles in step with the referee names the archive holds.
//
// ufc_referee_directory is driven by ufc_referee_stats (computed from bout
// results) LEFT JOINed to ufc_referee_profiles. The profiles table was seeded
// once, at migration time, from the referee names that existed then. Every
// referee the historical backfill introduces therefore appears in the
// directory with a NULL slug, which is a broken /referees/[slug] link.
//
// This script is the repeatable half of that seed: run it after a backfill
// window and every named referee has a profile row and a usable slug.
//
// It will not merge two spellings on its own. Alias merges are declared in
// ALIAS_SEEDS or reported as candidates for a human to confirm, because
// collapsing two officials into one is exactly the kind of silent identity
// error this codebase has been bitten by before.
//
//   node scripts/referees/sync-profiles.mjs [--dry-run] [--report]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
}
const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const DRY = process.argv.includes('--dry-run');

/* Documented nickname/spelling variants. A referee is only listed here when
 * the variant is an established public name for the same official, not a
 * guess from string similarity. */
const ALIAS_SEEDS = [
  { raw: 'Big John McCarthy', canonical: 'John McCarthy', note: 'Long-standing professional nickname of the same official; UFC Stats stores the plain form.' },
];

const slugify = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normKey = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

async function all(q, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) throw new Error(`${q.split('?')[0]} -> ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
async function post(table, rows, prefer) {
  if (!rows.length || DRY) return;
  const r = await fetch(`${URL_}/rest/v1/${table}`, { method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`${table} -> ${r.status} ${await r.text()}`);
}

const main = async () => {
  const [results, profiles, aliases] = await Promise.all([
    all('ufc_bout_results?select=referee'),
    all('ufc_referee_profiles?select=canonical_name,slug,display_name'),
    all('ufc_referee_aliases?select=raw_name,canonical_name'),
  ]);

  const counts = new Map();
  for (const r of results) {
    const n = (r.referee || '').trim();
    if (n) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const aliasRaw = new Map(aliases.map((a) => [a.raw_name, a.canonical_name]));
  const haveProfile = new Map(profiles.map((p) => [p.canonical_name, p]));
  const usedSlugs = new Set(profiles.map((p) => p.slug).filter(Boolean));

  /* A name that is an alias raw form must not get its own profile row. */
  const canonicalNames = new Map();
  for (const [name, n] of counts) {
    const canon = aliasRaw.get(name) || name;
    canonicalNames.set(canon, (canonicalNames.get(canon) || 0) + n);
  }

  const missing = [...canonicalNames.keys()].filter((n) => !haveProfile.has(n)).sort();
  const newRows = [];
  for (const name of missing) {
    let slug = slugify(name), i = 2;
    while (usedSlugs.has(slug)) slug = `${slugify(name)}-${i++}`;   // distinct officials, distinct URLs
    usedSlugs.add(slug);
    newRows.push({ canonical_name: name, slug, display_name: name });
  }

  /* Profiles that exist but never got a slug (directory link would 404). */
  const slugless = profiles.filter((p) => !p.slug);

  const seedRows = ALIAS_SEEDS.filter((a) => canonicalNames.has(a.canonical) || haveProfile.has(a.canonical))
    .filter((a) => !aliasRaw.has(a.raw))
    .map((a) => ({ raw_name: a.raw, canonical_name: a.canonical, source_note: a.note }));
  const seedSkipped = ALIAS_SEEDS.filter((a) => !canonicalNames.has(a.canonical) && !haveProfile.has(a.canonical));

  console.log(`referee names in results   ${counts.size}`);
  console.log(`canonical after aliases    ${canonicalNames.size}`);
  console.log(`profiles present           ${profiles.length}`);
  console.log(`profiles to create         ${newRows.length}${DRY ? ' (dry run)' : ''}`);
  console.log(`profiles missing a slug    ${slugless.length}`);
  console.log(`alias seeds to insert      ${seedRows.length}`);
  for (const a of seedSkipped) console.log(`  alias seed skipped: "${a.raw}" -> "${a.canonical}" (canonical not present in archive yet)`);

  await post('ufc_referee_profiles', newRows, 'resolution=ignore-duplicates');
  await post('ufc_referee_aliases', seedRows, 'resolution=merge-duplicates');
  if (!DRY) {
    for (const p of slugless) {
      let slug = slugify(p.canonical_name), i = 2;
      while (usedSlugs.has(slug)) slug = `${slugify(p.canonical_name)}-${i++}`;
      usedSlugs.add(slug);
      await fetch(`${URL_}/rest/v1/ufc_referee_profiles?canonical_name=eq.${encodeURIComponent(p.canonical_name)}`,
        { method: 'PATCH', headers: H, body: JSON.stringify({ slug }) });
    }
  }

  /* Report-only: spellings that look like the same person. Never auto-merged. */
  const byKey = new Map();
  for (const n of canonicalNames.keys()) {
    const k = normKey(n);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(n);
  }
  const dupes = [...byKey.values()].filter((v) => v.length > 1);
  if (dupes.length) {
    console.log('\ncandidate spelling variants (NOT merged — confirm before adding to ALIAS_SEEDS):');
    for (const v of dupes) console.log(`  ${v.map((n) => `"${n}" (${canonicalNames.get(n)})`).join('  ==  ')}`);
  } else {
    console.log('\nno candidate spelling variants detected');
  }

  if (process.argv.includes('--report')) {
    const top = [...canonicalNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log('\nmost archived assignments:');
    for (const [n, c] of top) console.log(`  ${n.padEnd(26)} ${c}`);
  }
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
