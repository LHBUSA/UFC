/* The status migration's security surface. Run: node --test scripts/status/lib/schema.test.mjs
 *
 * These read the migration FILE rather than a database, because the migration
 * has deliberately not been applied anywhere. That is a real limitation and
 * worth naming: this proves the SQL says the right thing, not that a live
 * cluster behaves that way. The behavioural half belongs in a post-apply
 * check, and the last test below writes down exactly what that check must run.
 *
 * What these can prove, and what actually goes wrong in review:
 *
 *   A view over an RLS-protected table runs as the view's OWNER by default.
 *   Postgres then evaluates the base table's policies as the owner, who is
 *   exempt, and hands every row to anybody holding SELECT on the view. RLS is
 *   on, the dashboard says "protected", and three views are wide open. It is
 *   silent, it is the default, and it is the exact shape of this table's risk:
 *   sourced medical and disciplinary claims about named people.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SQL = readFileSync(new URL('../../../supabase/migrations/20260908000011_ufc_fighter_status.sql', import.meta.url), 'utf8');

const TABLE = 'public.ufc_fighter_status_events';
const VIEWS = [
  'public.ufc_fighter_status_feed',
  'public.ufc_fighter_current_status',
  'public.ufc_event_card_changes',
];

/** Every `create ... view <name>` in the file, with the text up to its `as`. */
function viewHeaders(sql) {
  const out = new Map();
  const re = /create\s+(?:or\s+replace\s+)?view\s+([a-z_.]+)([\s\S]*?)\bas\b/gi;
  for (const m of sql.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/* ================= version ================= */

test('the migration version does not collide with the fight-model candidate', () => {
  /* ufc-fight-model-v1 holds 20260908000010_ufc_model_predictions.sql. Two
   * files with one version number is a coin toss over which one a fresh
   * environment applies. */
  const files = readdirSync(new URL('../../../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql'));
  const versions = files.map((f) => f.split('_')[0]);
  assert.equal(new Set(versions).size, versions.length, 'two migrations share a version');
  assert.ok(files.includes('20260908000011_ufc_fighter_status.sql'), 'status is 000011');
  assert.ok(!files.includes('20260908000010_ufc_fighter_status.sql'), '000010 is reserved for the model migration');
});

/* ================= view security ================= */

test('EVERY public view in this migration is security_invoker', () => {
  const headers = viewHeaders(SQL);
  assert.equal(headers.size, VIEWS.length, `expected ${VIEWS.length} views, found ${[...headers.keys()].join(', ')}`);
  for (const [name, header] of headers) {
    assert.ok(VIEWS.includes(name), `unexpected view ${name} — add it to this test or do not create it`);
    assert.match(header, /security_invoker\s*=\s*true/i,
      `${name} runs as its owner, which evaluates the base table's RLS as a role that is exempt from it`);
  }
});

test('RLS is enabled on the base table', () => {
  assert.match(SQL, new RegExp(`alter\\s+table\\s+${TABLE.replace('.', '\\.')}\\s+enable\\s+row\\s+level\\s+security`, 'i'));
});

test('no policy grants anon or authenticated any read', () => {
  /* Default deny is the design: this data reaches the public only through the
   * server, which decides what to show and how to caveat it. A policy added
   * later for some other purpose would silently open all three views, which is
   * why the explicit revokes below exist as well. */
  const policies = [...SQL.matchAll(/create\s+policy[\s\S]*?;/gi)].map((m) => m[0]);
  for (const p of policies) {
    assert.ok(!/\b(anon|authenticated|public)\b/.test(p), `a policy exposes rows to a browser role:\n${p}`);
  }
});

test('anon and authenticated are explicitly revoked on the table AND on all three views', () => {
  for (const rel of [TABLE, ...VIEWS]) {
    const re = new RegExp(`revoke\\s+all\\s+on\\s+${rel.replace(/\./g, '\\.')}\\s+from\\s+[^;]*\\banon\\b[^;]*;`, 'i');
    assert.match(SQL, re, `${rel} does not revoke from anon`);
    const re2 = new RegExp(`revoke\\s+all\\s+on\\s+${rel.replace(/\./g, '\\.')}\\s+from\\s+[^;]*\\bauthenticated\\b[^;]*;`, 'i');
    assert.match(SQL, re2, `${rel} does not revoke from authenticated`);
  }
});

test('service_role keeps the access every server read in this repo depends on', () => {
  /* web/lib/status.ts and workers/ufc-api both read with the service-role key.
   * Locking the views down must not lock out the only caller that legitimately
   * uses them. */
  for (const rel of VIEWS) {
    const re = new RegExp(`grant\\s+select[^;]*\\son\\s+${rel.replace(/\./g, '\\.')}\\s+to\\s+[^;]*service_role`, 'i');
    assert.match(SQL, re, `${rel} is not readable by service_role`);
  }
  assert.match(SQL, new RegExp(`grant[^;]*insert[^;]*on\\s+${TABLE.replace('.', '\\.')}\\s+to\\s+[^;]*service_role`, 'i'),
    'the collector must be able to insert');
  assert.match(SQL, new RegExp(`grant[^;]*update[^;]*on\\s+${TABLE.replace('.', '\\.')}\\s+to\\s+[^;]*service_role`, 'i'),
    'the lifecycle pass must be able to transition state');
});

test('nothing is granted delete — history is superseded, never removed', () => {
  assert.ok(!/grant[^;]*\bdelete\b[^;]*ufc_fighter_status_events/i.test(SQL),
    'expiring a claim must not be implementable as deleting it');
});

/* ================= lifecycle, in the schema ================= */

test('the current-status view excludes card-specific rows whose card has passed', () => {
  /* Independent of the lifecycle job. A scheduled pass can be late, fail, or be
   * switched off, and if it is the only thing between a withdrawal from a card
   * fought in March and today's availability page, one missed run publishes a
   * false present-tense claim about a named athlete. */
  const view = SQL.slice(SQL.indexOf('create or replace view public.ufc_fighter_current_status'));
  const body = view.slice(0, view.indexOf(';'));
  assert.match(body, /left\s+join\s+public\.ufc_events/i, 'it has to know the card date to exclude a past card');
  assert.match(body, /event_date\s*>=\s*current_date/i, 'a past card must not surface as current');
  assert.match(body, /s\.event_id\s+is\s+null/i, 'a status with no card is kept — time is not evidence of recovery');
  assert.match(body, /e\.event_date\s+is\s+null/i, 'an unknown date is not evidence the event happened');
  assert.match(body, /s\.state\s*=\s*'active'/i);
});

test('the state vocabulary is exactly what the code transitions between', async () => {
  const { RESOLVING_TYPES, UNAVAILABLE_TYPES } = await import('./lifecycle.mjs');
  for (const s of ['active', 'resolved', 'expired']) {
    assert.ok(SQL.includes(`'${s}'`), `state ${s} missing from the CHECK constraint`);
  }
  for (const t of [...RESOLVING_TYPES, ...UNAVAILABLE_TYPES]) {
    assert.ok(SQL.includes(`'${t}'`), `status_type ${t} missing from the CHECK constraint`);
  }
});

test('resolution has to point at what resolved it', () => {
  assert.match(SQL, /state\s*<>\s*'resolved'\s+or\s+resolved_by_event_id\s+is\s+not\s+null/i,
    'a resolved row with no resolver is an unexplained state change');
});

/* ================= what a live cluster still has to be asked ================= */

test('the post-apply behavioural check is written down and runnable', () => {
  /* Naming the gap rather than implying the static test closed it. These are
   * the exact statements to run against a real cluster once the migration is
   * applied; each one fails loudly if the view security regressed. */
  const checks = [
    // every view reports security_invoker in its reloptions
    `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'
         and c.relname in ('ufc_fighter_status_feed','ufc_fighter_current_status','ufc_event_card_changes')
         and (c.reloptions is null or not ('security_invoker=true' = any(c.reloptions)));`,
    // no browser role holds any privilege on the table or the views
    `select grantee, table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon','authenticated')
         and table_name in ('ufc_fighter_status_events','ufc_fighter_status_feed','ufc_fighter_current_status','ufc_event_card_changes');`,
    // and the empirical one: as anon, every view is empty or refused
    `set local role anon; select count(*) from public.ufc_fighter_status_feed;`,
  ];
  for (const c of checks) assert.ok(c.length > 40);
  assert.equal(checks.length, 3, 'three questions a live cluster must answer before this is called safe');
});
