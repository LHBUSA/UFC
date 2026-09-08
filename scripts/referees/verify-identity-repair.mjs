#!/usr/bin/env node
/**
 * Read-only verification harness for the referee identity repair.
 *
 *   node scripts/referees/verify-identity-repair.mjs            # full report
 *   node scripts/referees/verify-identity-repair.mjs --json out.json
 *
 * Run it BEFORE the repair to establish the preconditions the SQL asserts, and
 * AFTER to confirm the postconditions held. It issues SELECTs only — there is
 * no code path in this file that writes.
 *
 * The point of a separate harness is that the SQL's own assertions run inside
 * the transaction and therefore vanish with it on failure. This leaves a record
 * outside the transaction, before and after, that can be diffed by a person.
 *
 * Exit status is 0 when the observed state matches one of the two expected
 * shapes (before repair, or after repair) and 1 when it matches neither, which
 * is the interesting case: something moved that nobody intended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const KNOWN_FLAGS = new Set(['--json']);
{
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a, i) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && argv[i - 1] !== '--json');
  if (unknown.length) {
    console.error(`unknown option(s): ${unknown.join(' ')}`);
    console.error(`supported: ${[...KNOWN_FLAGS].join(', ')}`);
    process.exit(2);
  }
}
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

for (const f of ['.env', path.join('web', '.env.local')]) {
  const file = path.join(ROOT, f);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#') && !process.env[line.slice(0, i).trim()]) {
      process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const q = async (s) => {
  const r = await fetch(`${URL_}/rest/v1/${s}`, { headers: H });
  if (!r.ok) throw new Error(`${s.split('?')[0]} -> ${r.status}`);
  return r.json();
};
const count = async (s) => {
  const r = await fetch(`${URL_}/rest/v1/${s}`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  if (!r.ok) throw new Error(`${s.split('?')[0]} -> ${r.status}`);
  return Number((r.headers.get('content-range') || '/0').split('/')[1]);
};

/* The two clusters, and the identity each collapses to. Written here rather
 * than discovered, so the harness checks a decision instead of describing
 * whatever it happens to find. */
const CLUSTERS = [
  {
    name: 'Eric McMahon',
    keep: 'Eric Mcmahon',
    keepSlug: 'eric-mcmahon',
    display: 'Eric McMahon',
    absorb: [{ canonical: 'Eric McMahon', slug: 'eric-mcmahon-2', bouts: 3 }],
    keepBoutsBefore: 26,
    totalAfter: 29,
  },
  {
    name: 'Kiselev',
    keep: 'Vyacheslav Kiselev',
    keepSlug: 'vyacheslav-kiselev',
    display: 'Vyacheslav Kiselev',
    absorb: [
      { canonical: 'Vjacheslav Kiselev', slug: 'vjacheslav-kiselev', bouts: 4 },
      { canonical: 'Kiselev Viacheslav', slug: 'kiselev-viacheslav', bouts: 2 },
    ],
    keepBoutsBefore: 4,
    totalAfter: 10,
  },
];

const problems = [];
const note = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const main = async () => {
  const report = { checked_at: new Date().toISOString(), clusters: [], totals: {}, aliases: [], state: null };

  /* ---- global totals, the conservation baseline ---- */
  report.totals.profiles = await count('ufc_referee_profiles?select=canonical_name');
  report.totals.bout_results_with_referee = await count("ufc_bout_results?select=bout_id&referee=not.is.null");
  report.totals.referee_bouts_rows = await count('ufc_referee_bouts?select=bout_id');
  report.totals.referee_bouts_without_slug = await count('ufc_referee_bouts?select=bout_id&referee_slug=is.null');
  report.totals.directory_rows = await count('ufc_referee_directory?select=name');

  console.log('TOTALS (the conservation baseline)');
  console.log(`  referee profiles                 ${report.totals.profiles}`);
  console.log(`  bout results naming a referee    ${report.totals.bout_results_with_referee}`);
  console.log(`  rows in ufc_referee_bouts        ${report.totals.referee_bouts_rows}`);
  console.log(`  of those with NO slug            ${report.totals.referee_bouts_without_slug}`);
  console.log(`  rows in ufc_referee_directory    ${report.totals.directory_rows}`);

  note(
    report.totals.referee_bouts_rows === report.totals.bout_results_with_referee,
    `every bout result naming a referee should appear once in ufc_referee_bouts (${report.totals.bout_results_with_referee} vs ${report.totals.referee_bouts_rows})`,
  );

  /* ---- existing aliases ---- */
  report.aliases = await q('ufc_referee_aliases?select=raw_name,canonical_name,created_at&order=created_at.asc');
  console.log(`\nEXISTING ALIASES (${report.aliases.length})`);
  for (const a of report.aliases) console.log(`  ${a.created_at.slice(0, 19)}  "${a.raw_name}" -> "${a.canonical_name}"`);

  /* ---- per cluster ---- */
  let anyAbsorbed = false;
  let anyStillSplit = false;

  for (const c of CLUSTERS) {
    console.log(`\nCLUSTER: ${c.name}`);
    const entry = { name: c.name, keep: c.keep, rows: [], raw_spellings: {}, aliases_present: [] };

    const names = [c.keep, ...c.absorb.map((a) => a.canonical)];
    const inList = names.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(',');
    const profiles = await q(`ufc_referee_profiles?select=canonical_name,slug,display_name,created_at&canonical_name=in.(${encodeURIComponent(inList)})`);

    for (const n of names) {
      const p = profiles.find((x) => x.canonical_name === n);
      const bouts = p ? await count(`ufc_referee_bouts?select=bout_id&referee_slug=eq.${encodeURIComponent(p.slug)}`) : 0;
      const raw = await count(`ufc_bout_results?select=bout_id&referee=eq.${encodeURIComponent(n)}`);
      entry.rows.push({ canonical_name: n, present: Boolean(p), slug: p?.slug ?? null, display_name: p?.display_name ?? null, bouts_via_slug: bouts, raw_referee_rows: raw });
      entry.raw_spellings[n] = raw;
      console.log(
        `  ${p ? 'row ' : 'GONE'}  ${n.padEnd(20)} slug=${String(p?.slug ?? '-').padEnd(20)} ` +
        `display=${String(p?.display_name ?? '-').padEnd(20)} bouts=${String(bouts).padStart(3)}  raw referee rows=${raw}`,
      );
      if (n !== c.keep && !p) anyAbsorbed = true;
      if (n !== c.keep && p) anyStillSplit = true;
    }

    for (const a of c.absorb) {
      const present = report.aliases.some((x) => x.raw_name === a.canonical && x.canonical_name === c.keep);
      entry.aliases_present.push({ raw_name: a.canonical, routed: present });
    }

    const rawTotal = Object.values(entry.raw_spellings).reduce((x, y) => x + y, 0);
    const keptSlug = entry.rows.find((r) => r.canonical_name === c.keep);
    entry.raw_total = rawTotal;
    console.log(`  raw referee rows across all spellings: ${rawTotal} (expected ${c.totalAfter})`);
    note(rawTotal === c.totalAfter, `${c.name}: raw referee rows total ${rawTotal}, expected ${c.totalAfter}`);
    note(Boolean(keptSlug?.present), `${c.name}: the identity being kept (${c.keep}) must exist`);
    note(keptSlug?.slug === c.keepSlug, `${c.name}: expected slug ${c.keepSlug}, found ${keptSlug?.slug}`);

    report.clusters.push(entry);
  }

  /* ---- which state are we in ---- */
  const before = anyStillSplit && !anyAbsorbed;
  const after = anyAbsorbed && !anyStillSplit;
  report.state = before ? 'before-repair' : after ? 'after-repair' : 'mixed';

  console.log('\nSTATE');
  if (before) {
    console.log('  BEFORE REPAIR — both clusters are still split across separate profile rows.');
    console.log('  Expected after the repair:');
    for (const c of CLUSTERS) {
      console.log(`    ${c.keep.padEnd(20)} slug=${c.keepSlug.padEnd(20)} display="${c.display}"  bouts ${c.keepBoutsBefore} -> ${c.totalAfter}`);
      for (const a of c.absorb) console.log(`      absorbs "${a.canonical}" (${a.bouts} bouts) via an alias, then its profile row is removed`);
    }
    console.log(`    profiles ${report.totals.profiles} -> ${report.totals.profiles - CLUSTERS.reduce((n, c) => n + c.absorb.length, 0)}`);
    console.log(`    rows in ufc_referee_bouts unchanged at ${report.totals.referee_bouts_rows}, none without a slug`);
  } else if (after) {
    console.log('  AFTER REPAIR — each cluster resolves to one identity.');
    for (const c of CLUSTERS) {
      const kept = report.clusters.find((x) => x.name === c.name).rows.find((r) => r.canonical_name === c.keep);
      note(kept.bouts_via_slug === c.totalAfter, `${c.name}: expected ${c.totalAfter} bouts on ${c.keep}, found ${kept.bouts_via_slug}`);
      note(kept.display_name === c.display, `${c.name}: expected display_name "${c.display}", found "${kept.display_name}"`);
    }
    note(report.totals.referee_bouts_without_slug === 0, 'no bout may be left without a slug');
  } else {
    console.log('  MIXED — part of the repair has been applied. Do not proceed without looking.');
    problems.push('state is neither cleanly before nor cleanly after the repair');
  }

  console.log('\nCHECKS');
  if (problems.length) {
    for (const p of problems) console.log(`  ✖ ${p}`);
  } else {
    console.log('  every check passed');
  }

  report.problems = problems;
  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n'); console.log(`\njson -> ${jsonOut}`); }
  process.exitCode = problems.length ? 1 : 0;
};

main().catch((e) => { console.error('FATAL', e.message); process.exitCode = 2; });
