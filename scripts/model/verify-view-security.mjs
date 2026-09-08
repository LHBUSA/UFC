#!/usr/bin/env node
/**
 * Prove the model and store layer's RLS bypass is real, and that migration
 * 20260908000017 closes it without changing a single number.
 *
 *   node scripts/model/verify-view-security.mjs
 *   node scripts/model/verify-view-security.mjs --require-closed   # post-apply gate
 *   node scripts/model/verify-view-security.mjs --json path
 *
 * The companion to scripts/referees/verify-view-security.mjs. That script fixed
 * this bug on the referee views and its migration ended with a warning about
 * what it was not fixing: the schema default reproduces the same hole in every
 * view created afterwards that does not opt out. Three migrations then did
 * exactly that, and this is the verifier for the second occurrence.
 *
 * READ-ONLY THROUGHOUT. Catalog SELECTs and HTTP GETs. It never attempts a
 * write, not even one it expects to be rejected - an "expected to fail" INSERT
 * against production is still an INSERT, and a mistake in the predicate that
 * makes it succeed is discovered by finding the row afterwards. That applies
 * with particular force here, because the tables in question are the immutable
 * prediction ledger and the record of real customer orders.
 *
 * Six things are established:
 *
 *   1  ROLES         anon and authenticated lack BYPASSRLS; the view owner has
 *                    it. Without this the whole argument is different.
 *   2  BASE TABLES   the model tables remain inaccessible to anon, live, and
 *                    readable by service_role. Probed, not inferred.
 *   3  BYPASS        the five reporting views are measured against those same
 *                    base tables. Before the migration this is expected to LEAK
 *                    and the script says so loudly; after it, anon gets nothing.
 *   4  GRANTS        no mutation privilege remains for a public role. TRUNCATE
 *                    is called out separately because row security does not
 *                    cover it, which is the whole reason this matters: anon
 *                    holding TRUNCATE on ufc_model_predictions can empty the
 *                    prediction ledger with RLS fully enabled.
 *   5  SHAPE         view definition hashes are compared against the values
 *                    recorded before the repair. A privilege change cannot move
 *                    any of them, and ALTER VIEW ... SET guarantees it by
 *                    construction - this is the check that the guarantee held.
 *   6  NO ESCALATION no new SECURITY DEFINER routine in the model layer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260908000017_model_store_view_security.sql');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const JSON_OUT = opt('--json', path.join(ROOT, 'docs', 'model_view_security.json'));
const REQUIRE_CLOSED = flag('--require-closed');

export const MODEL_VIEWS = [
  'ufc_model_prediction_current_grade',
  'ufc_model_live_record',
  'ufc_model_live_recent',
  'ufc_model_live_calibration',
  'ufc_model_backtest_record',
];
export const MODEL_TABLES = [
  'ufc_model_predictions',
  'ufc_model_prediction_grades',
  'ufc_model_versions',
  'ufc_model_backtest_runs',
  'ufc_model_backtest_predictions',
];
export const STORE_TABLES = ['store_provisioning', 'store_orders', 'store_order_lines'];

/**
 * View definition hashes captured from production immediately before the repair
 * was written. The repair uses ALTER VIEW ... SET, which changes a storage
 * option and cannot touch the definition; these are here so that "cannot" is
 * measured rather than asserted.
 */
export const VIEWDEF_BASELINE = {
  ufc_model_live_record: '9a2ae9aeff0393a0c218105e2c5d36dc',
  ufc_model_backtest_record: '97288dd8dacf634f6b9b8f4a0c55d422',
  ufc_model_live_recent: '428b08ca4bacc21e91dee5831b7d6d6a',
  ufc_model_live_calibration: 'd15155b8ff242a036f8d73728452a188',
  ufc_model_prediction_current_grade: '943bda94fb1ce93b7f891631b9113e4b',
};

const MUTATION_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const PUBLIC_ROLES = ['anon', 'authenticated'];

function loadEnv() {
  const out = {};
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) {
        out[line.slice(0, i).trim().replace(/^﻿/, '')] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return { ...out, ...process.env };
}

/** Read-only catalog query through the Supabase management API. */
function sql(query) {
  const raw = execFileSync('pwsh', [path.join(ROOT, 'scripts', 'db', 'run_sql.ps1'), '-Query', query], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (/FAILED ->/.test(raw)) throw new Error(raw);
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '(empty result)') return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** A GET as one of the public roles. A row returned is a leak; 401/403/404 are not. */
async function probe(base, key, rel) {
  const res = await fetch(`${base}/rest/v1/${rel}?select=*&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let rows = null;
  try { rows = JSON.parse(text); } catch { /* not JSON: a denial body */ }
  return {
    relation: rel,
    status: res.status,
    leaked: res.ok && Array.isArray(rows) && rows.length > 0,
    present: res.status !== 404,
    body: text.slice(0, 140),
  };
}

/* ---- static analysis of the migration ---------------------------------- */

export function auditMigrationSql(text) {
  const problems = [];
  const body = text.replace(/^\s*--.*$/gm, '');

  const altered = [...body.matchAll(/alter\s+view\s+public\.(\w+)\s+set\s*\(\s*security_invoker\s*=\s*true\s*\)/gi)].map((m) => m[1]);
  const created = [...body.matchAll(/create\s+or\s+replace\s+view\s+public\.(\w+)([^]*?)\bas\b/gi)]
    .filter((m) => /with\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(m[2])).map((m) => m[1]);
  const secured = [...new Set([...altered, ...created])];
  for (const v of MODEL_VIEWS) {
    if (!secured.includes(v)) problems.push(`${v}: migration does not set security_invoker`);
  }

  /* A CREATE OR REPLACE on any of these would mean a view body was retyped, and
     a retyped body is a definition change however carefully it was copied. */
  for (const v of MODEL_VIEWS) {
    if (created.includes(v)) problems.push(`${v}: replaced rather than altered; the definition is no longer identical by construction`);
  }

  for (const rel of [...MODEL_VIEWS, ...MODEL_TABLES, ...STORE_TABLES]) {
    const re = new RegExp(`revoke[^;]*truncate[^;]*on\\s+public\\.${rel}\\s+from[^;]*anon`, 'is');
    if (!re.test(body)) problems.push(`${rel}: TRUNCATE not revoked from anon`);
  }

  if (/security\s+definer/i.test(body)) problems.push('migration introduces a SECURITY DEFINER routine');
  if (/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(body)) problems.push('migration contains a data write');
  if (/alter\s+default\s+privileges/i.test(body)) problems.push('migration alters default privileges, which would affect migrations still in flight');

  return { ok: problems.length === 0, secured, problems };
}

/* ---- live checks -------------------------------------------------------- */

async function main() {
  const env = loadEnv();
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const svcKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const report = { checked_at: new Date().toISOString(), checks: [], leaks: [], failures: [] };
  const record = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.failures.push(`${name}: ${detail}`);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. ROLES
  const roles = sql(`select rolname, rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role','postgres') order by rolname`);
  const byName = Object.fromEntries(roles.map((r) => [r.rolname, r.rolbypassrls === true || r.rolbypassrls === 't']));
  record('roles: anon and authenticated do not bypass RLS', byName.anon === false && byName.authenticated === false,
    `anon=${byName.anon} authenticated=${byName.authenticated} postgres=${byName.postgres}`);
  record('roles: the view owner bypasses RLS (the precondition for the finding)', byName.postgres === true, `postgres bypassrls=${byName.postgres}`);

  // 2/3. BASE TABLES and BYPASS, measured through the public API rather than inferred.
  if (base && anonKey) {
    for (const rel of [...MODEL_TABLES, ...STORE_TABLES]) {
      const p = await probe(base, anonKey, rel);
      if (p.leaked) report.leaks.push(rel);
      record(`base table ${rel} denies anon`, !p.leaked, `HTTP ${p.status}`);
    }
    for (const rel of MODEL_VIEWS) {
      const p = await probe(base, anonKey, rel);
      if (p.leaked) report.leaks.push(rel);
      const ok = !p.leaked;
      record(`view ${rel} denies anon`, ok, ok ? `HTTP ${p.status}` : `LEAK — HTTP ${p.status} returned rows`);
    }
  } else {
    record('anon probes', false, 'SUPABASE_URL or the anon key is unavailable; live probes skipped');
  }

  if (base && svcKey) {
    // The half that would take the /model page down if the repair were wrong.
    // security_invoker makes the CALLER resolve the base tables, so this stops
    // being free the moment the flag goes on.
    for (const rel of MODEL_VIEWS) {
      const p = await probe(base, svcKey, rel);
      record(`view ${rel} still readable by service_role`, p.present && p.status < 400, `HTTP ${p.status}`);
    }
  }

  // 4. GRANTS, read from the catalog rather than from the migration text.
  const rels = [...MODEL_VIEWS, ...MODEL_TABLES, ...STORE_TABLES].map((r) => `'${r}'`).join(',');
  const grants = sql(`select table_name, grantee, privilege_type from information_schema.role_table_grants
                      where table_schema='public' and grantee in ('anon','authenticated') and table_name in (${rels})`);
  const offending = grants.filter((g) => MUTATION_PRIVS.includes(g.privilege_type) || g.privilege_type === 'SELECT');
  record('grants: no privilege remains for anon or authenticated', offending.length === 0,
    offending.length ? offending.map((g) => `${g.grantee}:${g.privilege_type} on ${g.table_name}`).join(', ') : `${PUBLIC_ROLES.join('/')} hold nothing on ${MODEL_VIEWS.length + MODEL_TABLES.length + STORE_TABLES.length} relations`);

  // Stated separately because it is the privilege row security never covered,
  // and the one that could destroy the ledger the LIVE RECORD depends on.
  const truncates = grants.filter((g) => g.privilege_type === 'TRUNCATE');
  record('grants: TRUNCATE removed from the prediction ledger and order tables', truncates.length === 0,
    truncates.length ? truncates.map((g) => `${g.grantee} on ${g.table_name}`).join(', ') : 'none held');

  // 5. SHAPE: reloptions and definition hashes.
  const views = sql(`select c.relname, coalesce(array_to_string(c.reloptions,','),'') as reloptions,
                            md5(pg_get_viewdef(c.oid, true)) as viewdef_md5
                     from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relkind='v' and c.relname in (${MODEL_VIEWS.map((v) => `'${v}'`).join(',')})`);
  for (const v of MODEL_VIEWS) {
    const row = views.find((r) => r.relname === v);
    const hasFlag = !!row && /security_invoker=true/.test(row.reloptions);
    record(`view ${v} declares security_invoker`, hasFlag, row ? `reloptions=${row.reloptions || '(none)'}` : 'view not found');
    const expected = VIEWDEF_BASELINE[v];
    if (row && expected) {
      record(`view ${v} definition unchanged`, row.viewdef_md5 === expected, `md5=${row.viewdef_md5}`);
    }
  }

  // 6. NO ESCALATION
  const secdef = sql(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                      where n.nspname='public' and p.prosecdef and (p.proname like 'ufc_model%' or p.proname like 'store_%')`);
  record('no SECURITY DEFINER routine in the model or store layer', secdef.length === 0,
    secdef.length ? secdef.map((r) => r.proname).join(', ') : 'none');

  // Static audit of the migration file itself.
  if (fs.existsSync(MIGRATION)) {
    const audit = auditMigrationSql(fs.readFileSync(MIGRATION, 'utf8'));
    record('migration audit', audit.ok, audit.ok ? `${audit.secured.length} views secured` : audit.problems.join('; '));
  } else {
    record('migration audit', false, `not found: ${MIGRATION}`);
  }

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\nreport -> ${path.relative(ROOT, JSON_OUT)}`);

  if (report.leaks.length) {
    console.log(`\nOPEN BYPASS on: ${[...new Set(report.leaks)].join(', ')}`);
  }
  // Without --require-closed the script reports; with it, an open hole is an
  // exit code, so it can gate a deployment.
  if (REQUIRE_CLOSED && report.failures.length) {
    console.error(`\n${report.failures.length} check(s) failed with --require-closed`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
