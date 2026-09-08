#!/usr/bin/env node
/**
 * Prove the referee layer's RLS bypass is real, and that migration
 * 20260908000014 closes it without changing a single referee number.
 *
 *   node scripts/referees/verify-view-security.mjs
 *   node scripts/referees/verify-view-security.mjs --require-closed   # post-apply gate
 *   node scripts/referees/verify-view-security.mjs --json path
 *
 * The companion to scripts/judges/verify-view-security.mjs, which found this
 * hole while using it as a control. Same shape, opposite starting position: the
 * judge views were unapplied and correct by construction, these are applied and
 * currently open.
 *
 * READ-ONLY THROUGHOUT. Catalog SELECTs and HTTP GETs. It never attempts a
 * write, not even one it expects to be rejected - an "expected to fail" INSERT
 * against production is still an INSERT, and a mistake in the predicate that
 * makes it succeed is discovered by finding the row afterwards.
 *
 * Six things are established:
 *
 *   1  ROLES         anon and authenticated lack BYPASSRLS; the view owner has
 *                    it. Without this the whole argument is different.
 *   2  BASE TABLES   remain inaccessible to anon, live, and readable by
 *                    service_role. Probed, not inferred from the schema.
 *   3  BYPASS        the three views are measured against those same base
 *                    tables. Before the migration this is expected to LEAK and
 *                    the script says so loudly; after it, anon must get nothing.
 *   4  GRANTS        no mutation privilege remains for a public role. Read from
 *                    information_schema, not from the migration text.
 *   5  SHAPE         column signatures, view definition hashes and the derived
 *                    statistics are compared against the recorded baseline.
 *                    A privilege change cannot move any of them.
 *   6  NO ESCALATION no new SECURITY DEFINER routine, in the migration or in
 *                    the database, beyond the pre-existing NFL auth set.
 *
 * Checks 1-6 read live state. The migration is additionally audited statically,
 * because it is deliberately not applied yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260908000014_referee_view_security.sql');
const BASELINE = path.join(ROOT, 'docs', 'referee_metrics_baseline.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const JSON_OUT = opt('--json', path.join(ROOT, 'docs', 'referee_view_security.json'));
const REQUIRE_CLOSED = flag('--require-closed');

export const REFEREE_VIEWS = ['ufc_referee_stats', 'ufc_referee_directory', 'ufc_referee_bouts'];
export const REFEREE_TABLES = ['ufc_referee_profiles', 'ufc_referee_aliases'];
/** The tables the views read. If anon can reach these, nothing else matters. */
const RLS_BASE_TABLES = ['ufc_bout_results', 'ufc_bouts', 'ufc_events', 'ufc_fighters'];
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
  return out;
}
const env = loadEnv();
const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = env.SUPABASE_ANON_KEY || '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || '';

/* Checked inside main(), not at module scope: auditMigrationSql() is imported
   by the offline tests, which must run without credentials. */
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
    /* Did this role actually get data back? A 200 with an empty array and a 401
       are both acceptable denials; a row is not. */
    leaked: res.ok && Array.isArray(rows) && rows.length > 0,
    present: res.status !== 404,
    body: text.slice(0, 140),
  };
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

/* ---- static analysis of the (unapplied) migration ---------------------- */

export function auditMigrationSql(text) {
  const problems = [];
  const body = text.replace(/^\s*--.*$/gm, '');

  /* Either shape satisfies the requirement. ALTER is what this migration uses,
     and is preferred here because it cannot restate a definition wrongly. */
  const altered = [...body.matchAll(/alter\s+view\s+public\.(\w+)\s+set\s*\(\s*security_invoker\s*=\s*true\s*\)/gi)].map((m) => m[1]);
  const created = [...body.matchAll(/create\s+or\s+replace\s+view\s+public\.(\w+)([^]*?)\bas\b/gi)]
    .filter((m) => /with\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(m[2])).map((m) => m[1]);
  const secured = [...new Set([...altered, ...created])];
  for (const v of REFEREE_VIEWS) {
    if (!secured.includes(v)) problems.push(`view public.${v} is not given security_invoker = true`);
  }

  /* A view rewritten by hand is a chance to change a definition by accident.
     Flag it so the reviewer checks the hashes rather than trusting the diff. */
  const rewritten = created.filter((v) => REFEREE_VIEWS.includes(v));

  /* Every mutation privilege, off both public roles, on all five relations. */
  const revokes = [...body.matchAll(/revoke\s+([^;]*?)\s+on\s+([^;]*?)\s+from\s+([^;]*?);/gis)]
    .map((m) => ({ privs: m[1].toUpperCase(), on: m[2], from: m[3].toLowerCase() }));
  for (const rel of [...REFEREE_VIEWS, ...REFEREE_TABLES]) {
    for (const priv of MUTATION_PRIVS) {
      const covered = revokes.some((r) => r.on.includes(rel) && r.privs.includes(priv) && PUBLIC_ROLES.every((role) => r.from.includes(role)));
      if (!covered) problems.push(`migration does not revoke ${priv} on public.${rel} from anon and authenticated`);
    }
  }

  /* The SELECT decision, made explicitly in one direction or the other. */
  const selectRevoked = REFEREE_VIEWS.filter((rel) =>
    revokes.some((r) => r.on.includes(rel) && /\bSELECT\b/.test(r.privs) && PUBLIC_ROLES.every((role) => r.from.includes(role))));
  const grants = [...body.matchAll(/grant\s+([^;]*?)\s+on\s+([^;]*?)\s+to\s+([^;]*?);/gis)]
    .map((m) => ({ privs: m[1].toUpperCase(), on: m[2], to: m[3].toLowerCase() }));
  for (const g of grants) {
    if (/\b(anon|authenticated|public)\b/.test(g.to)) problems.push(`migration grants to a public role: grant ${g.privs} on ${g.on.trim()} to ${g.to.trim()}`);
  }
  const serviceSelect = REFEREE_VIEWS.filter((rel) =>
    grants.some((g) => g.on.includes(rel) && /\bSELECT\b/.test(g.privs) && g.to.includes('service_role')));
  if (selectRevoked.length !== REFEREE_VIEWS.length) {
    problems.push(`migration revokes SELECT from the public roles on only ${selectRevoked.length}/${REFEREE_VIEWS.length} views; the read path is server-side, so all three should be revoked`);
  }
  if (serviceSelect.length !== REFEREE_VIEWS.length) {
    problems.push(`migration does not grant SELECT to service_role on all three views; the server read path must be stated, not assumed`);
  }

  /* The escalation this whole exercise exists to remove must not come back in
     a different costume. */
  if (/security\s+definer/i.test(body)) problems.push('migration contains a SECURITY DEFINER routine');

  /* Migration 008 is applied. Editing it would change history without changing
     the database, and would silently diverge a fresh environment from this one. */
  if (/20260907000008/.test(body) && /(drop|alter)\s+.*20260907000008/i.test(body)) {
    problems.push('migration appears to modify the already-applied migration 008');
  }

  /* A privilege repair has no business touching rows. */
  for (const dml of ['insert into', 'update ', 'delete from', 'truncate ']) {
    const re = new RegExp(`\\b${dml.trim().replace(/\s+/g, '\\s+')}\\b`, 'i');
    /* `revoke ... truncate ...` and `revoke ... update ...` are privilege
       names, not statements, so only look outside revoke/grant statements. */
    const outside = body.replace(/\b(revoke|grant)\b[^;]*;/gis, '');
    if (re.test(outside)) problems.push(`migration contains a data-modifying statement (${dml.trim()}); this repair must not touch referee rows`);
  }

  return { secured, rewritten, selectRevoked, serviceSelect, revokes: revokes.length, problems };
}

/* ---- live checks ------------------------------------------------------- */

function catalogViews() {
  const rows = sql(`select c.relname as name,
                           pg_get_userbyid(c.relowner) as owner,
                           coalesce(c.reloptions::text, '') as reloptions,
                           md5(pg_get_viewdef(c.oid, true)) as viewdef_md5,
                           length(pg_get_viewdef(c.oid, true)) as viewdef_len
                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind = 'v'
                      and c.relname in (${REFEREE_VIEWS.map((v) => `'${v}'`).join(',')});`);
  return rows.map((r) => ({ ...r, security_invoker: /security_invoker\s*=\s*true/i.test(r.reloptions || '') }));
}

function catalogGrants() {
  const rels = [...REFEREE_VIEWS, ...REFEREE_TABLES].map((r) => `'${r}'`).join(',');
  return sql(`select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
              from information_schema.role_table_grants
              where table_schema = 'public' and table_name in (${rels})
                and grantee in ('anon','authenticated','service_role')
              group by table_name, grantee order by table_name, grantee;`);
}

function catalogShape() {
  const rels = REFEREE_VIEWS.map((v) => `'${v}'`).join(',');
  return sql(`select table_name, count(*)::int as columns,
                     string_agg(column_name || ':' || data_type, '|' order by ordinal_position) as signature
              from information_schema.columns
              where table_schema = 'public' and table_name in (${rels})
              group by table_name order by table_name;`);
}

function catalogMetrics() {
  return sql(`select (select count(*) from public.ufc_referee_stats)::int as stats_rows,
                     (select count(*) from public.ufc_referee_directory)::int as directory_rows,
                     (select count(*) from public.ufc_referee_bouts)::int as bouts_rows,
                     (select sum(bouts) from public.ufc_referee_stats)::int as sum_bouts,
                     (select sum(stoppages) from public.ufc_referee_stats)::int as sum_stoppages,
                     (select sum(decisions) from public.ufc_referee_stats)::int as sum_decisions,
                     (select sum(title_bouts) from public.ufc_referee_stats)::int as sum_title_bouts,
                     (select max(archive_stoppage_rate)::text from public.ufc_referee_stats) as archive_stoppage_rate,
                     (select max(archive_decision_rate)::text from public.ufc_referee_stats) as archive_decision_rate,
                     (select count(*) from public.ufc_referee_directory where slug is not null)::int as directory_with_slug,
                     (select md5(string_agg(name || ':' || bouts::text || ':' || stoppages::text || ':' || coalesce(stoppage_rate::text,'-'), '|' order by name))
                        from public.ufc_referee_stats) as stats_fingerprint;`)[0];
}

const main = async () => {
  requireEnv();
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const report = { generated_at: new Date().toISOString(), migration: path.basename(MIGRATION), checks: {}, problems: [], notes: [] };
  const fail = (m) => report.problems.push(m);
  const note = (m) => report.notes.push(m);

  /* 1. ROLES */
  const roles = sql(`select rolname, rolbypassrls, rolsuper from pg_roles
                     where rolname in ('anon','authenticated','service_role','postgres') order by rolname;`);
  report.checks.roles = roles;
  const byName = Object.fromEntries(roles.map((r) => [r.rolname, r]));
  if (byName.anon?.rolbypassrls) fail('anon has BYPASSRLS - RLS cannot protect anything');
  if (byName.authenticated?.rolbypassrls) fail('authenticated has BYPASSRLS');
  if (!byName.service_role?.rolbypassrls) fail('service_role lacks BYPASSRLS - server reads would break');

  /* 2. BASE TABLES */
  report.checks.base_tables = [];
  for (const t of [...RLS_BASE_TABLES, ...REFEREE_TABLES]) {
    const anon = await get(t, ANON);
    const svc = await get(t, SERVICE);
    report.checks.base_tables.push({ table: t, anon_leaked: anon.leaked, anon_status: anon.status, service_reads: svc.leaked });
    if (anon.leaked) fail(`base table ${t} returns rows to anon - RLS is not protecting it`);
    if (!svc.leaked) fail(`base table ${t} returns nothing to service_role - server reads are broken`);
  }

  /* 3. THE BYPASS */
  const views = catalogViews();
  report.checks.views = [];
  for (const v of REFEREE_VIEWS) {
    const cat = views.find((x) => x.name === v);
    const anon = await get(v, ANON);
    const svc = await get(v, SERVICE);
    report.checks.views.push({
      view: v,
      owner: cat?.owner ?? null,
      reloptions: cat?.reloptions === '' ? null : cat?.reloptions,
      security_invoker: Boolean(cat?.security_invoker),
      anon_leaked: anon.leaked,
      anon_status: anon.status,
      service_reads: svc.leaked,
    });
    if (!svc.leaked) fail(`view ${v} returns nothing to service_role - the public referee pages would break`);
  }
  const open = report.checks.views.filter((v) => v.anon_leaked);
  report.checks.bypass_open = open.length > 0;
  report.checks.migration_applied = report.checks.views.every((v) => v.security_invoker);

  if (report.checks.bypass_open && report.checks.migration_applied) {
    fail(`views ${open.map((v) => v.view).join(', ')} declare security_invoker yet still return rows to anon`);
  }
  if (report.checks.bypass_open && !report.checks.migration_applied) {
    note(`BYPASS OPEN on ${open.map((v) => v.view).join(', ')} - expected until 20260908000014 is applied.`);
    if (REQUIRE_CLOSED) fail(`--require-closed: ${open.length} referee view(s) still return rows to anon`);
  }
  if (!report.checks.bypass_open && !report.checks.migration_applied) {
    note('No view leaked, but none declares security_invoker either. Something else is denying anon - do not read this as the bypass being fixed.');
  }

  /* 4. GRANTS */
  const grants = catalogGrants();
  report.checks.grants = grants;
  for (const g of grants) {
    if (!PUBLIC_ROLES.includes(g.grantee)) continue;
    const held = (g.privs || '').split(',').filter(Boolean);
    const mutations = held.filter((p) => MUTATION_PRIVS.includes(p));
    if (mutations.length) {
      const msg = `${g.grantee} holds ${mutations.join(',')} on public.${g.table_name}`;
      if (report.checks.migration_applied) fail(`${msg} - the migration was applied but the grant survives`);
      else note(`${msg} - removed by 20260908000014.`);
    }
    if (held.includes('SELECT')) {
      const msg = `${g.grantee} holds SELECT on public.${g.table_name}`;
      if (report.checks.migration_applied) fail(`${msg} - reads are server-side only`);
      else note(`${msg} - removed by 20260908000014.`);
    }
  }
  for (const rel of REFEREE_VIEWS) {
    const svc = grants.find((g) => g.table_name === rel && g.grantee === 'service_role');
    if (!svc || !(svc.privs || '').includes('SELECT')) fail(`service_role lacks SELECT on public.${rel} - the server read path is broken`);
  }

  /* 4b. THE PREREQUISITE security_invoker CREATES.
     Turning the flag on changes who resolves the BASE tables, not just the
     view: the reading role stops inheriting the owner's access. If service_role
     ever lacks SELECT on one of these, applying the migration takes the public
     referee pages down, and the symptom is an empty page rather than an error -
     which is the worst way to find out. Checked before applying, not after. */
  const prereqRels = [...RLS_BASE_TABLES, ...REFEREE_TABLES];
  const prereq = sql(`select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
                      from information_schema.role_table_grants
                      where table_schema='public' and grantee='service_role'
                        and table_name in (${prereqRels.map((t) => `'${t}'`).join(',')})
                      group by table_name order by table_name;`);
  report.checks.invoker_prerequisite = prereqRels.map((t) => {
    const row = prereq.find((p) => p.table_name === t);
    const ok = Boolean(row && (row.privs || '').includes('SELECT'));
    if (!ok) fail(`service_role lacks SELECT on base table public.${t}; with security_invoker on, the referee views would return nothing to the server`);
    return { table: t, service_role_select: ok };
  });

  /* 5. SHAPE AND NUMBERS */
  const shape = catalogShape();
  report.checks.shape = shape.map((s) => {
    const base = baseline.views[s.table_name] || {};
    const cat = views.find((v) => v.name === s.table_name);
    const row = {
      view: s.table_name,
      columns: s.columns,
      columns_expected: base.columns ?? null,
      signature_matches: s.signature === base.signature,
      viewdef_md5: cat?.viewdef_md5 ?? null,
      viewdef_md5_expected: base.viewdef_md5 ?? null,
      viewdef_matches: cat?.viewdef_md5 === base.viewdef_md5,
    };
    if (!row.signature_matches) fail(`view ${s.table_name} column signature changed since the baseline`);
    /* The definition hash is the one thing a privilege change can never move. */
    if (!row.viewdef_matches) fail(`view ${s.table_name} definition changed since the baseline (${row.viewdef_md5_expected} -> ${row.viewdef_md5})`);
    return row;
  });

  const metrics = catalogMetrics();
  report.checks.metrics = { live: metrics, baseline: baseline.metrics, measured_at: baseline.measured_at };
  const drift = [];
  for (const [k, expected] of Object.entries(baseline.metrics)) {
    const live = metrics[k];
    if (String(live) !== String(expected)) drift.push({ field: k, baseline: expected, live });
  }
  report.checks.metrics.drift = drift;
  if (drift.length) {
    /* The archive grows: new events arrive and every count here moves with
       them. That is not a regression, and treating it as one would train
       whoever runs this to ignore it. The definitions above are the invariant;
       these are reported with their measurement date so a reader can judge. */
    note(`${drift.length} statistic(s) differ from the baseline measured ${baseline.measured_at}: ${drift.map((d) => `${d.field} ${d.baseline}->${d.live}`).join(', ')}. Expected if events have been ingested since; a privilege change cannot cause it.`);
  }

  /* 6. NO NEW ESCALATION */
  const secdef = sql(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.prosecdef order by 1;`).map((r) => r.proname);
  const known = new Set(baseline.security_definer_routines_before);
  const added = secdef.filter((p) => !known.has(p));
  report.checks.security_definer = { live: secdef, baseline: [...known], added };
  for (const p of added) fail(`new SECURITY DEFINER routine in public: ${p}`);
  if (secdef.some((p) => /referee/i.test(p))) fail('a referee-named SECURITY DEFINER routine exists - this layer must not have one');

  /* STATIC AUDIT of the unapplied migration. */
  const stat = auditMigrationSql(fs.readFileSync(MIGRATION, 'utf8'));
  report.checks.migration_audit = { secured: stat.secured, rewritten: stat.rewritten, select_revoked: stat.selectRevoked, service_select: stat.serviceSelect };
  for (const p of stat.problems) fail(p);
  if (stat.rewritten.length) note(`migration recreates ${stat.rewritten.join(', ')} rather than altering; compare viewdef hashes carefully after applying.`);

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

  /* ---- output --------------------------------------------------------- */
  const mark = (ok) => (ok ? 'ok  ' : 'FAIL');
  console.log('\nROLES');
  for (const r of roles) console.log(`  ${r.rolname.padEnd(16)} bypassrls=${String(r.rolbypassrls).padEnd(5)} superuser=${r.rolsuper}`);

  console.log('\nBASE TABLES — anon must get nothing, service_role must get rows');
  for (const t of report.checks.base_tables) {
    console.log(`  ${mark(!t.anon_leaked && t.service_reads)} ${t.table.padEnd(24)} anon rows=${t.anon_leaked}  service rows=${t.service_reads}`);
  }

  console.log('\nREFEREE VIEWS — the finding');
  for (const v of report.checks.views) {
    console.log(`  ${v.anon_leaked ? 'LEAK' : 'ok  '} ${v.view.padEnd(24)} owner=${v.owner} security_invoker=${String(v.security_invoker).padEnd(5)} anon rows=${String(v.anon_leaked).padEnd(5)} service rows=${v.service_reads}`);
  }
  if (report.checks.bypass_open) {
    console.log(`\n  ^ ${open.length} view(s) hand anon rows their base tables refuse it.`);
    console.log('    Migration 20260908000014 closes this. It is NOT applied.');
  }

  console.log('\nGRANTS — public roles must hold nothing');
  for (const g of grants.filter((x) => PUBLIC_ROLES.includes(x.grantee))) {
    console.log(`  ${g.privs ? 'HELD' : 'ok  '} ${(`${g.grantee}@${g.table_name}`).padEnd(46)} ${g.privs}`);
  }

  console.log('\nPREREQUISITE - security_invoker makes the caller resolve base tables');
  for (const p of report.checks.invoker_prerequisite) {
    console.log(`  ${mark(p.service_role_select)} ${p.table.padEnd(24)} service_role SELECT=${p.service_role_select}`);
  }

  console.log('\nSHAPE — definitions and columns must be identical');
  for (const s of report.checks.shape) {
    console.log(`  ${mark(s.signature_matches && s.viewdef_matches)} ${s.view.padEnd(24)} cols=${s.columns}/${s.columns_expected} viewdef=${s.viewdef_matches ? 'unchanged' : 'CHANGED'}`);
  }

  console.log('\nMETRICS — a privilege change cannot move these');
  for (const [k, v] of Object.entries(baseline.metrics)) {
    const live = metrics[k];
    console.log(`  ${String(live) === String(v) ? 'same' : 'diff'} ${k.padEnd(24)} baseline=${String(v).padEnd(12)} live=${live}`);
  }

  console.log('\nMIGRATION (static — not applied)');
  for (const v of REFEREE_VIEWS) console.log(`  ${mark(stat.secured.includes(v))} ${v.padEnd(24)} security_invoker granted by migration`);
  console.log(`  ${mark(stat.selectRevoked.length === 3)} SELECT revoked from anon/authenticated on ${stat.selectRevoked.length}/3 views`);
  console.log(`  ${mark(stat.serviceSelect.length === 3)} SELECT granted to service_role on ${stat.serviceSelect.length}/3 views`);
  console.log(`  ${mark(stat.problems.length === 0)} static audit: ${stat.problems.length} problem(s)`);

  console.log(`\napplied: ${report.checks.migration_applied ? 'yes' : 'no'}   bypass open: ${report.checks.bypass_open ? 'YES' : 'no'}`);
  if (report.notes.length) {
    console.log('\nNOTES');
    for (const n of report.notes) console.log(`  - ${n}`);
  }
  console.log(`\nwritten ${path.relative(ROOT, JSON_OUT)}`);

  if (report.problems.length) {
    console.error('\nPROBLEMS');
    for (const p of report.problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log(report.checks.migration_applied
    ? '\nreferee views execute as the caller; anon reaches nothing.\n'
    : '\nmigration is correct and complete; the bypass stays open until it is applied.\n');
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].split(path.sep).join('/')}`).href.replace(/^file:\/\/([A-Za-z]:)/, 'file:///$1')) {
  main().catch((e) => { console.error(e); process.exit(1); });
} else if (process.argv[1]?.endsWith('verify-view-security.mjs') && process.argv[1].includes('referees')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
