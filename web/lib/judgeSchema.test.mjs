/* Schema and access-control tests for the judge layer.
 *
 * Run: npm run test:judges
 *
 * These are static tests over the checked-in migration, deliberately. The
 * migration is not applied, so a test that needed a live database would be a
 * test that could not run — and the properties being asserted here are exactly
 * the ones that must hold BEFORE anyone applies it.
 *
 * The live half of the same proof lives in
 * scripts/judges/verify-view-security.mjs: it probes the running database with
 * the anon key, shows the base tables deny it, and shows that a view WITHOUT
 * security_invoker hands anon those same rows anyway. That script needs
 * credentials; this file does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const MIGRATION_PATH = join(ROOT, "supabase", "migrations", "20260908000012_ufc_judge_intelligence.sql");
const SQL = readFileSync(MIGRATION_PATH, "utf8");

const { auditMigrationSql, JUDGE_VIEWS } = await import(
  new URL("../../scripts/judges/verify-view-security.mjs", import.meta.url).href
);

const JUDGE_TABLES = ["ufc_judge_profiles", "ufc_judge_aliases"];
/* Comments describe intent; they must never satisfy a security assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, "");

/* ---- view security ----------------------------------------------------- */

test("the migration audit finds no security problems", () => {
  const { problems } = auditMigrationSql(SQL);
  assert.deepEqual(problems, [], `security audit problems:\n  ${problems.join("\n  ")}`);
});

test("every judge view declares security_invoker explicitly", () => {
  const { views } = auditMigrationSql(SQL);
  assert.equal(views.length, JUDGE_VIEWS.length, "unexpected number of views in the migration");
  for (const name of JUDGE_VIEWS) {
    const v = views.find((x) => x.name === name);
    assert.ok(v, `view ${name} missing`);
    assert.equal(v.security_invoker, true, `${name} must not rely on the default view security`);
  }
});

test("security_invoker is written on the CREATE, not left to a later ALTER", () => {
  /* An ALTER VIEW ... SET (security_invoker) later in the file would leave a
     window where the view exists unprotected, and would be lost the next time
     someone re-ran only the CREATE. */
  for (const name of JUDGE_VIEWS) {
    const re = new RegExp(`create\\s+or\\s+replace\\s+view\\s+public\\.${name}\\s+with\\s*\\(\\s*security_invoker\\s*=\\s*true\\s*\\)\\s+as`, "i");
    assert.match(CODE, re, `${name} does not carry the flag on its CREATE statement`);
  }
});

test("no SECURITY DEFINER routine is introduced", () => {
  assert.doesNotMatch(CODE, /security\s+definer/i);
});

test("the views read only tables this layer is allowed to expose", () => {
  /* A view is a read path. If one ever selects from an auth or storage table,
     security_invoker alone would not make that appropriate. */
  const forbidden = /\b(auth|storage|vault|extensions)\.\w+/i;
  assert.doesNotMatch(CODE, forbidden, "a view references a schema outside public");
});

/* ---- row level security ------------------------------------------------ */

test("row level security is enabled on both judge tables", () => {
  for (const t of JUDGE_TABLES) {
    assert.match(CODE, new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, "i"), `${t} does not enable RLS`);
  }
});

test("no RLS policy is created, so there is no public read path", () => {
  const { policies } = auditMigrationSql(SQL);
  assert.deepEqual(policies, [], "a policy would open these tables to anon/authenticated");
});

/* ---- mutation paths ---------------------------------------------------- */

test("anon and authenticated have every write privilege revoked on the judge tables", () => {
  const revokes = [...CODE.matchAll(/revoke\s+([^;]*?)\s+on\s+([^;]*?)\s+from\s+([^;]*?);/gis)];
  for (const t of JUDGE_TABLES) {
    const hit = revokes.find((m) => m[2].includes(t) && /anon/i.test(m[3]) && /authenticated/i.test(m[3]));
    assert.ok(hit, `no revoke covers ${t} for anon and authenticated`);
    for (const priv of ["insert", "update", "delete", "truncate"]) {
      assert.match(hit[1], new RegExp(priv, "i"), `${priv} is not revoked on ${t}`);
    }
  }
});

test("the judge views are not writable by anon or authenticated either", () => {
  /* A simple view is auto-updatable in Postgres. security_invoker stops a read
     bypass; it does not stop a write arriving through the view. */
  const revokes = [...CODE.matchAll(/revoke\s+([^;]*?)\s+on\s+([^;]*?)\s+from\s+([^;]*?);/gis)];
  for (const v of JUDGE_VIEWS) {
    const hit = revokes.find((m) => m[2].includes(v) && /anon/i.test(m[3]) && /authenticated/i.test(m[3]));
    assert.ok(hit, `no revoke covers view ${v}`);
    for (const priv of ["insert", "update", "delete"]) {
      assert.match(hit[1], new RegExp(priv, "i"), `${priv} is not revoked on ${v}`);
    }
  }
});

test("nothing is granted to anon, authenticated or PUBLIC", () => {
  const grants = [...CODE.matchAll(/grant\s+([^;]*?)\s+on\s+([^;]*?)\s+to\s+([^;]*?);/gis)];
  const offenders = grants.filter((m) => /\b(anon|authenticated|public)\b/i.test(m[3]));
  assert.deepEqual(
    offenders.map((m) => `grant ${m[1].trim()} on ${m[2].trim()} to ${m[3].trim()}`),
    [],
    "the judge layer must not grant anything to a browser-reachable role",
  );
});

test("service_role keeps the read it needs", () => {
  const grants = [...CODE.matchAll(/grant\s+([^;]*?)\s+on\s+([^;]*?)\s+to\s+([^;]*?);/gis)];
  const svc = grants.find((m) => /service_role/i.test(m[3]) && /select/i.test(m[1]));
  assert.ok(svc, "server reads depend on service_role holding SELECT");
  for (const t of JUDGE_TABLES) assert.ok(svc[2].includes(t), `${t} is not covered by the service_role grant`);
});

/* ---- identity evidence, enforced in the schema ------------------------- */

test("the alias table refuses a spelling_variant with no source", () => {
  assert.match(CODE, /constraint\s+ufc_judge_aliases_variant_needs_source/i);
  assert.match(CODE, /check\s*\(\s*kind\s*<>\s*'spelling_variant'\s*or\s*\(\s*source_url\s+is\s+not\s+null/i);
});

test("every spelling_variant seeded by the migration is written with a source_url", () => {
  /* The insert selects source_url only for spelling_variant rows; if that
     expression were dropped the CHECK would reject the migration at apply
     time, but failing here is cheaper than failing in a deploy. */
  const insert = CODE.slice(CODE.indexOf("insert into public.ufc_judge_aliases"));
  assert.match(insert, /source_url/, "the alias insert does not populate source_url");
  assert.match(insert, /https?:\/\/\S+/, "no external source URL appears in the alias insert");
});

test("a withdrawn spelling_variant is cleaned up rather than left behind", () => {
  /* Removing a row from the seed list must actually un-merge it on re-apply,
     otherwise a retracted merge survives in production. */
  assert.match(
    CODE,
    /delete\s+from\s+public\.ufc_judge_aliases[^;]*kind\s*=\s*'spelling_variant'[^;]*not\s+exists[^;]*_judge_alias_seed/is,
    "the migration does not remove spelling variants that have left the seed",
  );
});
