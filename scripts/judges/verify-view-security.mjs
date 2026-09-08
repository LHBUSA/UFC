#!/usr/bin/env node
/**
 * Prove the judge layer cannot leak RLS-protected rows, WITHOUT applying the
 * migration and WITHOUT writing anything.
 *
 *   node scripts/judges/verify-view-security.mjs [--json path]
 *
 * A view over an RLS-protected table is only as safe as the role it runs as.
 * Postgres runs a view as its OWNER unless it is declared
 * `with (security_invoker = true)`; on this project every view is owned by
 * `postgres`, which holds BYPASSRLS. So an undeclared view is a hole straight
 * through RLS, and the defaults give you the hole.
 *
 * This script establishes four things:
 *
 *   1. The roles behave as assumed - anon and authenticated have no BYPASSRLS,
 *      service_role does, and the view owner does.
 *   2. The base tables actually deny anon today. Probed live with the anon key
 *      through PostgREST, not asserted from the schema.
 *   3. An undeclared view really does bypass that denial. Demonstrated against
 *      the referee views from migration 008, which are live and lack the flag.
 *      This is the control: without it, step 4 proves nothing.
 *   4. Every view in the judge migration declares security_invoker, neither
 *      table grants a write path to anon or authenticated, and nothing in the
 *      file introduces a SECURITY DEFINER routine.
 *
 * Steps 1-3 are live reads. Step 4 is a static read of the migration file,
 * because the migration is deliberately not applied. Once it IS applied, the
 * same script re-run will additionally find the views present and probe them
 * directly - see checkAppliedViews().
 *
 * Read-only throughout. It issues SELECTs and HTTP GETs. It never attempts an
 * INSERT, UPDATE or DELETE, not even one it expects to be rejected: an
 * "expected to fail" write against production is still a write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260908000012_ufc_judge_intelligence.sql');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const JSON_OUT = opt('--json', path.join(ROOT, 'docs', 'judge_view_security.json'));

export const JUDGE_VIEWS = [
  'ufc_bout_scorecards', 'ufc_bout_scorecard_summary', 'ufc_judge_bouts',
  'ufc_judge_stats', 'ufc_judge_directory', 'ufc_scorecard_gaps', 'ufc_scorecard_coverage',
];
const JUDGE_TABLES = ['ufc_judge_profiles', 'ufc_judge_aliases'];
const RLS_BASE_TABLES = ['ufc_bout_results', 'ufc_bouts', 'ufc_events', 'ufc_fighters'];
/* Live views from migration 008 that predate this rule. They are the control
   for step 3 and, separately, a finding in their own right. */
const CONTROL_VIEWS = ['ufc_referee_bouts', 'ufc_referee_stats', 'ufc_referee_directory'];

function loadEnv() {
  const out = {};
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  }
  return out;
}
const env = loadEnv();
const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = env.SUPABASE_ANON_KEY || '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || '';
/* Checked inside main(), not at module scope: auditMigrationSql() is imported
   by the schema tests, which are static and must run without credentials. */
function requireEnv() {
  if (URL_ && ANON && SERVICE) return;
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are all required locally');
  process.exit(2);
}

/** One GET through PostgREST as a given key. Never anything but GET. */
async function get(relation, key) {
  const res = await fetch(`${URL_}/rest/v1/${relation}?select=*&limit=1`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let rows = null;
  try { rows = JSON.parse(text); } catch { /* an error body, not rows */ }
  return {
    status: res.status,
    /** Did this role actually get data back? That is the only thing that matters. */
    leaked: res.ok && Array.isArray(rows) && rows.length > 0,
    present: res.status !== 404,
    body: text.slice(0, 120),
  };
}

function sql(query) {
  const raw = execFileSync('pwsh', [path.join(ROOT, 'scripts', 'db', 'run_sql.ps1'), '-Query', query], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (/FAILED ->/.test(raw)) throw new Error(raw);
  /* A query that matches no rows prints nothing (or "(empty result)"), which
     is a legitimate answer here — the judge views are not applied yet. */
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '(empty result)') return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/* ---- static analysis of the unapplied migration ------------------------ */

export function auditMigrationSql(text) {
  const problems = [];
  const views = [];
  for (const m of text.matchAll(/create\s+or\s+replace\s+view\s+public\.(\w+)([^]*?)\bas\b/gi)) {
    const [, name, between] = m;
    const invoker = /with\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(between);
    views.push({ name, security_invoker: invoker });
    if (!invoker) problems.push(`view public.${name} does not declare with (security_invoker = true)`);
  }
  for (const name of JUDGE_VIEWS) {
    if (!views.some((v) => v.name === name)) problems.push(`expected view public.${name} is not created by the migration`);
  }
  /* A SECURITY DEFINER function would reintroduce the same escalation the
     views just closed, so the migration may not contain one. */
  if (/security\s+definer/i.test(text.replace(/^\s*--.*$/gm, ''))) problems.push('migration contains a SECURITY DEFINER routine');

  const rls = JUDGE_TABLES.filter((t) => new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, 'i').test(text));
  for (const t of JUDGE_TABLES) if (!rls.includes(t)) problems.push(`table public.${t} does not enable row level security`);

  /* No policy at all is the intended state: these tables have no public read
     path. A policy would be a deliberate decision and must not arrive by
     accident, so flag any that appears. */
  const policies = [...text.matchAll(/create\s+policy\s+[^;]*?\bon\s+public\.(\w+)/gi)].map((m) => m[1]);
  for (const p of policies) if (JUDGE_TABLES.includes(p)) problems.push(`unexpected RLS policy on public.${p} - these tables are server-read only`);

  const revokesWrites = JUDGE_TABLES.every((t) =>
    [...text.matchAll(/revoke\s+([^;]*?)\s+on\s+([^;]*?)\s+from\s+([^;]*?);/gis)].some(
      (m) => /insert/i.test(m[1]) && /update/i.test(m[1]) && /delete/i.test(m[1])
        && m[2].includes(t) && /anon/i.test(m[3]) && /authenticated/i.test(m[3]),
    ));
  if (!revokesWrites) problems.push('migration does not revoke insert/update/delete on the judge tables from anon and authenticated');

  const grantsToPublicRoles = [...text.matchAll(/grant\s+([^;]*?)\s+on\s+([^;]*?)\s+to\s+([^;]*?);/gis)]
    .filter((m) => /\b(anon|authenticated|public)\b/i.test(m[3]))
    .map((m) => `grant ${m[1].trim()} on ${m[2].trim()} to ${m[3].trim()}`);
  for (const g of grantsToPublicRoles) problems.push(`migration grants to a public role: ${g}`);

  /* The evidence standard from blocker 1, checked structurally. */
  if (!/constraint\s+ufc_judge_aliases_variant_needs_source/i.test(text)) {
    problems.push('alias table does not constrain spelling_variant rows to carry a source_url');
  }
  return { views, rlsEnabled: rls, policies, problems };
}

/* ---- live checks ------------------------------------------------------- */

async function checkAppliedViews() {
  /* Once the migration is applied this turns from a skip into a real probe. */
  const rows = sql(`select c.relname as name, coalesce(c.reloptions::text, '') as reloptions
                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind = 'v'
                      and c.relname in (${JUDGE_VIEWS.map((v) => `'${v}'`).join(',')});`);
  const present = rows.filter((r) => r.name);
  const out = { applied: present.length > 0, views: [] };
  for (const r of present) {
    const invoker = /security_invoker\s*=\s*true/i.test(r.reloptions || '');
    const anon = await get(r.name, ANON);
    out.views.push({ name: r.name, security_invoker: invoker, anon_leaked: anon.leaked, anon_status: anon.status });
  }
  return out;
}

const main = async () => {
  requireEnv();
  const report = { generated_at: new Date().toISOString(), checks: {}, problems: [] };
  const fail = (m) => report.problems.push(m);

  /* 1. Role assumptions. */
  const roles = sql(`select rolname, rolbypassrls, rolsuper from pg_roles
                     where rolname in ('anon','authenticated','service_role','postgres') order by rolname;`);
  report.checks.roles = roles;
  const byName = Object.fromEntries(roles.map((r) => [r.rolname, r]));
  if (byName.anon?.rolbypassrls) fail('anon has BYPASSRLS - RLS cannot protect anything');
  if (byName.authenticated?.rolbypassrls) fail('authenticated has BYPASSRLS');
  if (!byName.service_role?.rolbypassrls) fail('service_role lacks BYPASSRLS - server reads would break');

  /* 2. Base tables deny anon, live. */
  report.checks.base_tables = [];
  for (const t of RLS_BASE_TABLES) {
    const anon = await get(t, ANON);
    const svc = await get(t, SERVICE);
    report.checks.base_tables.push({ table: t, anon_leaked: anon.leaked, anon_status: anon.status, service_reads: svc.leaked });
    if (anon.leaked) fail(`base table ${t} returns rows to anon - RLS is not protecting it`);
    if (!svc.leaked) fail(`base table ${t} returns nothing to service_role - server reads are broken`);
  }
  for (const t of JUDGE_TABLES) {
    const anon = await get(t, ANON);
    report.checks.base_tables.push({ table: t, anon_leaked: anon.leaked, anon_status: anon.status, service_reads: null, note: anon.present ? 'present' : 'not applied yet' });
    if (anon.leaked) fail(`judge table ${t} returns rows to anon`);
  }

  /* 3. The control: an undeclared view bypasses that denial. */
  report.checks.control_views = [];
  for (const v of CONTROL_VIEWS) {
    const anon = await get(v, ANON);
    report.checks.control_views.push({ view: v, anon_leaked: anon.leaked, anon_status: anon.status });
  }
  const controlLeaks = report.checks.control_views.filter((c) => c.anon_leaked).map((c) => c.view);
  report.checks.control_demonstrates_bypass = controlLeaks.length > 0;
  if (controlLeaks.length === 0) {
    /* Not a failure of this branch, but the proof is now circumstantial and
       the reader should know the control stopped demonstrating anything. */
    report.checks.control_note = 'No control view leaked. Either migration 008 has since been hardened, or PostgREST no longer exposes them. The security_invoker requirement stands on the role facts in check 1.';
  }

  /* 4. Static audit of the unapplied migration. */
  const migration = fs.readFileSync(MIGRATION, 'utf8');
  const stat = auditMigrationSql(migration);
  report.checks.migration = { views: stat.views, rls_enabled: stat.rlsEnabled, policies: stat.policies };
  for (const p of stat.problems) fail(p);

  /* 5. If applied, probe the real views too. */
  report.checks.applied = await checkAppliedViews();
  for (const v of report.checks.applied.views) {
    if (!v.security_invoker) fail(`applied view ${v.name} is missing security_invoker`);
    if (v.anon_leaked) fail(`applied view ${v.name} returns rows to anon`);
  }

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

  const mark = (ok) => (ok ? 'ok  ' : 'FAIL');
  console.log('\nROLES');
  for (const r of roles) console.log(`  ${r.rolname.padEnd(16)} bypassrls=${String(r.rolbypassrls).padEnd(5)} superuser=${r.rolsuper}`);
  console.log('\nBASE TABLES — anon must get nothing, service_role must get rows');
  for (const t of report.checks.base_tables) {
    const expected = t.service_reads === null ? !t.anon_leaked : (!t.anon_leaked && t.service_reads);
    console.log(`  ${mark(expected)} ${t.table.padEnd(24)} anon rows=${t.anon_leaked}${t.service_reads === null ? `  (${t.note})` : `  service rows=${t.service_reads}`}`);
  }
  console.log('\nCONTROL — views WITHOUT security_invoker (migration 008, already live)');
  for (const c of report.checks.control_views) {
    console.log(`  ${c.anon_leaked ? 'LEAK' : 'ok  '} ${c.view.padEnd(24)} anon rows=${c.anon_leaked}`);
  }
  if (controlLeaks.length) {
    console.log(`\n  ^ ${controlLeaks.length} live view(s) hand anon rows their base tables refuse it.`);
    console.log('    That is the bypass the judge views close, demonstrated rather than argued.');
    console.log('    Those views belong to the referee layer and are reported, not changed here.');
  }
  console.log('\nJUDGE MIGRATION (static — not applied)');
  for (const v of stat.views) console.log(`  ${mark(v.security_invoker)} ${v.name.padEnd(30)} security_invoker=${v.security_invoker}`);
  console.log(`  ${mark(stat.rlsEnabled.length === JUDGE_TABLES.length)} row level security enabled on ${stat.rlsEnabled.length}/${JUDGE_TABLES.length} judge tables`);
  console.log(`  ${mark(stat.policies.length === 0)} RLS policies created: ${stat.policies.length} (0 expected — server-read only)`);
  console.log(`\nviews applied to the database yet: ${report.checks.applied.applied ? 'yes' : 'no'}`);
  console.log(`\nwritten ${path.relative(ROOT, JSON_OUT)}`);

  if (report.problems.length) {
    console.error('\nPROBLEMS');
    for (const p of report.problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log('\nno view in the judge layer can bypass base-table RLS.\n');
};

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-view-security.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
