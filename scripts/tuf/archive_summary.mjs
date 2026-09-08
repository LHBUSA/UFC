#!/usr/bin/env node
/**
 * The one authoritative count of what the TUF archive holds.
 *
 *   node scripts/tuf/archive_summary.mjs [--json <path>]
 *
 * Written because the same archive was being described with several different
 * numbers depending on which file was counted — 726 and 740 bouts, 43 and 45
 * professional, 62 verified finals against 45 professional bracket bouts —
 * and none of those pairs is a contradiction once you say which collection is
 * being counted. This says so, and then asserts the arithmetic rather than
 * printing totals and hoping.
 *
 * There are TWO collections, and they overlap without either containing the
 * other:
 *
 *   THE BRACKET      every bout in web/data/tuf/seasons/*.json. This is the
 *                    fight-by-fight archive. Each bout carries exactly one
 *                    classification: professional, exhibition or unverified.
 *
 *   THE FINALS       the verified final bouts in seasons.json. These are not
 *                    a subset of the bracket: a season can have a final
 *                    verified against our own result rows while its bracket
 *                    is only partly loaded, and one bracket final can be
 *                    missing from the inventory while another is present.
 *
 * Where they overlap, the numbers must agree. Where they do not, the gap is
 * named per season rather than netted off.
 *
 * Read-only. Reads the repository, not the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairMatch, cornerNames } from './lib/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'web', 'data', 'tuf', 'seasons');
const INV = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons.json'), 'utf8'));

const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

/**
 * Do these two bout records name the same fight?
 *
 * Delegated to the shared matcher, which knows the spelling conventions this
 * archive actually contains, so the summary cannot disagree with the importer
 * and the classifier about who fought whom. Each side is tried under every
 * spelling the record carries.
 */
function sameFight(x, y) {
  const xa = cornerNames(x, 'a').concat(x.name_in_archive || []);
  const xb = cornerNames(x, 'b').concat(x.name_in_archive || []);
  const ya = cornerNames(y, 'a').concat(y.name_in_archive || []);
  const yb = cornerNames(y, 'b').concat(y.name_in_archive || []);
  for (const a1 of xa) for (const b1 of xb) {
    if (a1 === b1) continue;
    for (const a2 of ya) for (const b2 of yb) {
      if (a2 === b2) continue;
      const m = pairMatch(a1, b1, a2, b2);
      if (m.same) return m;
    }
  }
  return { same: false, rules: [] };
}

const problems = [];
const assert = (cond, msg) => { if (!cond) problems.push(msg); };

/* ---------- the bracket ---------- */

const CLASSES = ['professional', 'exhibition', 'unverified'];
const bracket = { total: 0, professional: 0, exhibition: 0, unverified: 0, winnerless: 0, recordEligible: 0, excluded: 0 };
const bracketFinalsBySeason = new Map();

for (const row of INV.seasons) {
  const file = path.join(DIR, `${row.slug}.json`);
  if (!fs.existsSync(file)) { assert(false, `${row.slug}: no detail file`); continue; }
  const season = JSON.parse(fs.readFileSync(file, 'utf8'));
  const finals = [];
  for (const div of season.bracket || []) {
    for (const st of div.stages) {
      for (const b of st.bouts) {
        bracket.total += 1;
        assert(CLASSES.includes(b.classification), `${row.slug}: bout has classification "${b.classification}"`);
        bracket[b.classification] += 1;
        if (!b.winner) bracket.winnerless += 1;

        /* The single rule the rest of the site uses. Repeated here rather than
         * imported so this report cannot silently agree with a broken one. */
        const counts = b.classification === 'professional' && Boolean(b.classification_source);
        if (counts) bracket.recordEligible += 1; else bracket.excluded += 1;

        if (counts) assert(Boolean(b.winner), `${row.slug}: a record-eligible bout has no winner (${b.a} vs ${b.b})`);
        if (st.stage === 'final') finals.push({ ...b, weight_class: div.weight_class });
      }
    }
  }
  bracketFinalsBySeason.set(row.slug, finals);
}

/* ---------- the finals in the inventory ---------- */

const finals = { total: 0, matchedInBracket: 0, absentFromBracket: 0 };
const absent = [];
const bracketFinalsNotVerified = [];

for (const row of INV.seasons) {
  const inventoryFinals = row.final_bouts || [];
  const brFinals = bracketFinalsBySeason.get(row.slug) || [];
  const brKeys = brFinals.map((b) => ({ b }));
  const used = new Set();

  for (const f of inventoryFinals) {
    finals.total += 1;
    const hit = brKeys.find(({ b }) => sameFight(f, b).same);
    if (hit) {
      finals.matchedInBracket += 1;
      used.add(hit.b);
      assert(
        hit.b.classification === 'professional',
        `${row.slug}: "${f.a} vs ${f.b}" is a verified final but its bracket bout is ${hit.b.classification}`,
      );
    } else {
      finals.absentFromBracket += 1;
      absent.push({ slug: row.slug, weight_class: f.weight_class, bout: `${f.a} vs ${f.b}`, event: f.event, date: f.date });
    }
  }

  for (const { b } of brKeys) {
    if (used.has(b)) continue;
    if (b.classification === 'professional') {
      bracketFinalsNotVerified.push({ slug: row.slug, weight_class: b.weight_class, bout: `${b.a} vs ${b.b}` });
    }
  }
}

/* ---------- arithmetic ---------- */

assert(
  bracket.professional + bracket.exhibition + bracket.unverified === bracket.total,
  `bracket classes do not sum: ${bracket.professional}+${bracket.exhibition}+${bracket.unverified} != ${bracket.total}`,
);
assert(
  bracket.recordEligible + bracket.excluded === bracket.total,
  `record-eligible + excluded != total: ${bracket.recordEligible}+${bracket.excluded} != ${bracket.total}`,
);
assert(
  bracket.recordEligible <= bracket.professional,
  'record-eligible cannot exceed professional — it is professional AND sourced',
);
assert(
  finals.matchedInBracket + finals.absentFromBracket === finals.total,
  'finals matched + absent != total',
);

const coverage = {};
for (const s of INV.seasons) coverage[s.coverage] = (coverage[s.coverage] || 0) + 1;
assert(
  Object.values(coverage).reduce((a, b) => a + b, 0) === INV.seasons.length,
  'coverage buckets do not sum to the season count',
);

/* ---------- output ---------- */

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

console.log('THE BRACKET — every bout in the season detail files');
console.log(`  total                 ${String(bracket.total).padStart(5)}`);
console.log(`    professional        ${String(bracket.professional).padStart(5)}   ${pct(bracket.professional, bracket.total)}`);
console.log(`    exhibition          ${String(bracket.exhibition).padStart(5)}   ${pct(bracket.exhibition, bracket.total)}`);
console.log(`    unverified          ${String(bracket.unverified).padStart(5)}   ${pct(bracket.unverified, bracket.total)}`);
console.log('  these three are mutually exclusive and every bout has exactly one');
console.log();
console.log(`  record-eligible       ${String(bracket.recordEligible).padStart(5)}   professional AND carrying its evidence`);
console.log(`  excluded from records ${String(bracket.excluded).padStart(5)}   everything else`);
console.log(`  winnerless            ${String(bracket.winnerless).padStart(5)}   OVERLAPS the classes above; never record-eligible`);
console.log();
console.log('THE FINALS — verified against our own result rows, in seasons.json');
console.log(`  verified final bouts  ${String(finals.total).padStart(5)}`);
console.log(`    also in the bracket ${String(finals.matchedInBracket).padStart(5)}`);
console.log(`    absent from bracket ${String(finals.absentFromBracket).padStart(5)}`);
console.log();
console.log('OVERLAP');
console.log(`  The two collections share ${finals.matchedInBracket} bouts. Neither contains the other:`);
console.log(`  ${finals.absentFromBracket} verified finals have no bracket bout, and ${bracketFinalsNotVerified.length} professional bracket finals`);
console.log('  are not carried as verified finals in the inventory.');

if (absent.length) {
  console.log('\nverified finals with no bout in the bracket');
  const bySeason = new Map();
  for (const a of absent) {
    if (!bySeason.has(a.slug)) bySeason.set(a.slug, []);
    bySeason.get(a.slug).push(a);
  }
  for (const [slug, list] of bySeason) {
    const row = INV.seasons.find((s) => s.slug === slug);
    console.log(`  ${slug.padEnd(15)} coverage=${row.coverage}`);
    for (const a of list) console.log(`      ${a.weight_class ?? '?'}: ${a.bout}  (${a.event}, ${a.date})`);
  }
}

if (bracketFinalsNotVerified.length) {
  console.log('\nprofessional bracket finals not carried as verified finals');
  for (const b of bracketFinalsNotVerified) console.log(`  ${b.slug.padEnd(15)} ${b.weight_class ?? '?'}: ${b.bout}`);
}

console.log('\nCOVERAGE');
for (const [k, v] of Object.entries(coverage).sort()) console.log(`  ${k.padEnd(18)} ${v}`);
console.log(`  seasons             ${INV.seasons.length}`);

console.log('\nARITHMETIC');
if (problems.length) {
  console.log(`  ${problems.length} assertion(s) FAILED`);
  for (const p of problems) console.log(`    ✖ ${p}`);
} else {
  console.log('  every assertion holds');
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    generated_at: new Date().toISOString(),
    bracket, finals, coverage,
    absent_from_bracket: absent,
    bracket_finals_not_verified: bracketFinalsNotVerified,
    assertions_failed: problems,
  }, null, 2) + '\n');
  console.log(`\njson -> ${jsonOut}`);
}

process.exitCode = problems.length ? 1 : 0;
