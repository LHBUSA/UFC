#!/usr/bin/env node
/**
 * Prove the checked-in migration's SQL agrees with the runtime derivation,
 * WITHOUT applying the migration.
 *
 *   node scripts/judges/verify-migration-sql.mjs
 *
 * The migration is deliberately not applied, which leaves its views unproven
 * exactly where it matters most: the orientation and attribution rules. This
 * script lifts the ufc_bout_scorecards body straight out of the migration
 * file, rewrites its one dependency on a table that does not exist yet
 * (public.ufc_judge_aliases) into an inline VALUES list taken from the same
 * file's seed, and runs it as a read-only aggregate through the Supabase
 * Management API. Nothing is created, altered or written.
 *
 * It then compares the totals against the same numbers derived in JS by
 * scripts/judges/audit-coverage.mjs. If the SQL and the TypeScript ever stop
 * agreeing, one of the two is wrong and this fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260908000012_ufc_judge_intelligence.sql');
const REPORT = path.join(ROOT, 'docs', 'judge_scorecard_coverage.json');
const S = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'judgeScoring.ts')).href);

const sql = fs.readFileSync(MIGRATION, 'utf8');

/* The alias seed, verbatim from the migration's two VALUES blocks. */
const aliasRows = [...sql.matchAll(/^\s*\('((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'(spelling_variant|deduction_annotation)',\s*(null|'(?:(?:[^']|'')*)')\)/gm)]
  .map((m) => `(${q(m[1])}, ${q(m[2])}, ${q(m[3])}, ${m[4]})`);
if (aliasRows.length !== Object.keys(S.JUDGE_ALIASES).length) {
  console.error(`alias seed parse mismatch: ${aliasRows.length} in SQL, ${Object.keys(S.JUDGE_ALIASES).length} in judgeScoring.ts`);
  process.exit(1);
}
function q(s) { return `'${s.replace(/''/g, "'").replace(/'/g, "''")}'`; }

/* Lift the view body: everything between the view's `as` and its terminating
   semicolon, so the SQL under test is the file's own text, not a copy. The
   header is matched loosely because it also carries the security_invoker
   declaration; that flag is asserted separately by web/lib/judgeSchema.test.mjs
   and cannot be probed here, since a CTE has no view options. */
function viewHeader(name) {
  const m = new RegExp(`create\\s+or\\s+replace\\s+view\\s+public\\.${name}\\b[^]*?\\bas\\b`, 'i').exec(sql);
  if (!m) { console.error(`${name} not found in the migration`); process.exit(1); }
  return { start: m.index, end: m.index + m[0].length };
}
const head = viewHeader('ufc_bout_scorecards');
const start = head.start;
const bodyStart = head.end;
const bodyEnd = sql.indexOf('\n;', bodyStart) >= 0 ? sql.indexOf('\n;', bodyStart) : sql.indexOf(';\n\ncomment on view public.ufc_bout_scorecards', bodyStart);
const body = sql.slice(bodyStart, bodyEnd).trim().replace(/;$/, '');

const rewritten = body
  .replace(/public\.ufc_judge_aliases/g, '_alias')
  .replace(/^with\s+raw\s+as\s*\(/i, `with _alias(raw_name, canonical_name, kind, card_note) as (values\n${aliasRows.join(',\n')}\n), raw as (`);

const probe = `with card as (\n${rewritten}\n)
select
  count(*)::int as card_rows,
  count(distinct bout_id)::int as bouts,
  count(*) filter (where orientation_basis = 'derived_from_result')::int as attributed_cards,
  count(*) filter (where orientation_basis = 'unresolved_no_winner')::int as unresolved_no_winner,
  count(*) filter (where orientation_basis = 'unresolved_conflicting_cards')::int as unresolved_conflicting_cards,
  count(*) filter (where is_dissent)::int as dissent_cards,
  count(*) filter (where is_even_card)::int as even_cards,
  count(distinct judge_name)::int as canonical_judges,
  count(distinct raw_judge_name)::int as raw_judge_strings,
  count(*) filter (where fighter_a_score is null)::int as unattributed_cards
from card;`;

const probePath = path.join(ROOT, 'docs', 'qa', 'judges-migration-probe.sql');
fs.mkdirSync(path.dirname(probePath), { recursive: true });
fs.writeFileSync(probePath, `${probe}\n`);

const raw = execFileSync('pwsh', [path.join(ROOT, 'scripts', 'db', 'run_sql.ps1'), '-Query', probe], { encoding: 'utf8', maxBuffer: 1 << 24 });
if (/FAILED ->/.test(raw)) { console.error(raw); process.exit(1); }
const got = JSON.parse(raw);
const sqlResult = Array.isArray(got) ? got[0] : got;

/* The gap register is the migration's other load-bearing derivation, and it
   reads only base tables, so it runs exactly as written with no rewriting. */
const gapHead = viewHeader('ufc_scorecard_gaps');
const gapEnd = sql.indexOf(';\n\ncomment on view public.ufc_scorecard_gaps', gapHead.end);
if (gapEnd < 0) { console.error('ufc_scorecard_gaps comment terminator not found'); process.exit(1); }
const gapBody = sql.slice(gapHead.end, gapEnd).trim();
const gapProbe = `select classification, reason, count(*)::int as n from (\n${gapBody}\n) g group by 1, 2 order by 3 desc;`;
const gapPath = path.join(ROOT, 'docs', 'qa', 'judges-gaps-probe.sql');
fs.writeFileSync(gapPath, `${gapProbe}\n`);
const gapRaw = execFileSync('pwsh', [path.join(ROOT, 'scripts', 'db', 'run_sql.ps1'), '-Query', gapProbe], { encoding: 'utf8', maxBuffer: 1 << 24 });
if (/FAILED ->/.test(gapRaw)) { console.error(gapRaw); process.exit(1); }
const gapRows = JSON.parse(gapRaw);

const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const js = {
  card_rows: report.coverage.card_rows,
  attributed_cards: report.attribution.attributed_cards,
  unresolved_no_winner: report.attribution.unresolved_no_winner,
  unresolved_conflicting_cards: report.attribution.unresolved_conflicting_cards,
  dissent_cards: report.attribution.dissent_cards,
  even_cards: report.attribution.even_cards,
  canonical_judges: report.identity.canonical_judges,
  raw_judge_strings: report.identity.raw_judge_strings,
  unattributed_cards: report.attribution.unattributed_cards,
};

let bad = 0;
console.log('\nmigration SQL vs runtime derivation\n');
console.log(`  ${'metric'.padEnd(30)}${'SQL'.padStart(8)}${'JS'.padStart(8)}`);
for (const k of Object.keys(js)) {
  const ok = Number(sqlResult[k]) === Number(js[k]);
  if (!ok) bad += 1;
  console.log(`  ${k.padEnd(30)}${String(sqlResult[k]).padStart(8)}${String(js[k]).padStart(8)}  ${ok ? 'ok' : 'MISMATCH'}`);
}
console.log(`\n  bouts with cards (SQL)        ${sqlResult.bouts}`);

console.log('\ngap classification: migration SQL vs runtime derivation\n');
console.log(`  ${'classification / reason'.padEnd(54)}${'SQL'.padStart(6)}${'JS'.padStart(6)}`);
const jsBuckets = report.gaps.by_classification;
const seen = new Set();
for (const row of gapRows) {
  const key = `${row.classification} / ${row.reason}`;
  seen.add(key);
  const n = jsBuckets[row.classification]?.reasons?.[row.reason] ?? 0;
  const ok = Number(row.n) === Number(n);
  if (!ok) bad += 1;
  console.log(`  ${key.padEnd(54)}${String(row.n).padStart(6)}${String(n).padStart(6)}  ${ok ? 'ok' : 'MISMATCH'}`);
}
/* A bucket the runtime produces and the SQL does not is just as wrong as a
   count that differs, and it would otherwise pass unnoticed. */
for (const [cls, v] of Object.entries(jsBuckets)) {
  for (const [reason, n] of Object.entries(v.reasons)) {
    const key = `${cls} / ${reason}`;
    if (seen.has(key)) continue;
    bad += 1;
    console.log(`  ${key.padEnd(54)}${'-'.padStart(6)}${String(n).padStart(6)}  MISSING IN SQL`);
  }
}

console.log(`\nprobes written to ${path.relative(ROOT, probePath)} and ${path.relative(ROOT, gapPath)}`);
if (bad) { console.error(`\n${bad} metric(s) disagree between the migration and web/lib/judgeScoring.ts\n`); process.exit(1); }
console.log('\nthe migration views and the runtime derivation agree.\n');
