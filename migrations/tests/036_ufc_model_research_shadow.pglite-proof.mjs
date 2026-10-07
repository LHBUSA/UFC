// Migration 036 proof on PGlite: stub the referenced tables, apply 027 then 036, then exercise the constraints.
import { PGlite } from 'file:///D:/Workers/_social/tennis/node_modules/@electric-sql/pglite/dist/index.js';
import fs from 'node:fs';
const db = new PGlite();
const M = (f) => fs.readFileSync(`D:/Workers/wt/ufc-algo-v2/migrations/${f}`, 'utf8');
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.ufc_model_versions (model_version text primary key, model_family text, status text, retired_at timestamptz, coefficients jsonb, feature_scale jsonb, spec_sha256 text, hyperparameters jsonb, feature_version text, training_window_end date, training_bouts int, promoted_at timestamptz, description text);
  create table public.ufc_events (id uuid primary key, card_status text, event_date date);
  create table public.ufc_fighters (id uuid primary key);
  create table public.ufc_bouts (id uuid primary key, event_id uuid, status text);
  create table public.ufc_model_predictions (id uuid primary key);
  insert into public.ufc_model_versions values ('pbe-fight-model-v1');
`);
const res = [];
const step = async (name, sql, expectError = null) => {
  try { await db.exec(sql); res.push([expectError ? 'FAIL (no error)' : 'ok', name]); console.log(res.at(-1).join('  ')); }
  catch (e) { try { await db.exec('rollback'); } catch {} res.push([expectError && new RegExp(expectError).test(e.message) ? 'ok (rejected)' : `FAIL ${e.message.slice(0, 160)}`, name]); console.log(res.at(-1).join('  ')); }
};
await step('027 applies', M('027_ufc_algo_learning.sql'));
await step('036 applies', M('036_ufc_model_research_shadow.sql'));
await step('036 is NOT re-runnable blindly (constraint drop finds nothing) -> explicit error', M('036_ufc_model_research_shadow.sql'), 'status constraint not found|already exists');
const base = `run_date, trigger, parent_model_version, training_cutoff_at, feature_version, eligibility_version, code_sha`;
const vals = `'2026-10-07', 'admin', 'pbe-fight-model-v1', '2026-10-07T00:00:00Z', 'pbe-fight-features-v2-elo', 'pbe-algo-eligibility-v1.1', 'abc'`;
await step('RESEARCH_SHADOW without provenance is rejected', `insert into ufc_model_training_runs (${base}, status) values (${vals}, 'RESEARCH_SHADOW')`, 'research_shadow_provenance');
await step('RESEARCH_SHADOW with full provenance is accepted', `insert into ufc_model_training_runs (${base}, status, dataset_sha256, dataset_uri, spec_sha256, coefficients, feature_scale, hyperparameters, training_bouts) values (${vals}, 'RESEARCH_SHADOW', 'c174', 'r2://x', 'cc84', '{}', '{}', '{}', 9249)`);
await step('an unknown status is still rejected', `insert into ufc_model_training_runs (${base}, status) values (${vals}, 'PROMOTED')`, 'status_check');
await step('existing statuses still accepted (WAITING_FOR_DATA)', `insert into ufc_model_training_runs (${base}, status) values ('2026-10-08', 'cron', 'pbe-fight-model-v1', '2026-10-08T00:00:00Z', 'f', 'e', 'abc', 'WAITING_FOR_DATA')`);
await step('CHALLENGER provenance rule still enforced', `insert into ufc_model_training_runs (${base}, status) values (${vals}, 'CHALLENGER')`, 'check');
await step('research shadow run is immutable', `update ufc_model_training_runs set code_sha = 'x' where status = 'RESEARCH_SHADOW'`, 'immutable');
const { rows: [run] } = await db.query(`select id from ufc_model_training_runs where status = 'RESEARCH_SHADOW'`);
await db.exec(`insert into ufc_events values ('00000000-0000-0000-0000-0000000000e1'); insert into ufc_fighters values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000b2'); insert into ufc_bouts values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1');`);
await step('shadow row with policy inserts', `insert into ufc_model_shadow_predictions (training_run_id, challenger_spec_sha256, champion_model_version, bout_id, event_id, fighter_a_id, fighter_b_id, eligibility_version, decision, prob_a, pick_fighter_id, pick_probability, generated_at, policy)
  values ('${run.id}', 'cc84', 'pbe-fight-model-v1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'v', 'ELIGIBLE', 0.4, '00000000-0000-0000-0000-0000000000b2', 0.6, now() - interval '1 second', '{"track":"v2-research-shadow"}')`);
const { rows: [sp] } = await db.query(`select id from ufc_model_shadow_predictions`);
await step('policy cannot change after lock', `select set_config('pbe.shadow_locking','on',false); update ufc_model_shadow_predictions set locked_at = now() where id = '${sp.id}'; select set_config('pbe.shadow_locking','off',false); update ufc_model_shadow_predictions set policy = '{"x":1}' where id = '${sp.id}'`, 'locked');
const { rows: grants } = await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_name = 'ufc_model_shadow_predictions' and grantee in ('anon','authenticated')`);
res.push([grants.length === 0 ? 'ok' : 'FAIL', `anon/authenticated grants on shadow table: ${grants.length}`]);
for (const [s, n] of res) console.log(s.padEnd(16), n);
process.exit(res.some(([s]) => s.startsWith('FAIL')) ? 1 : 0);
