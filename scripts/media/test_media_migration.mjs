#!/usr/bin/env node
// Applies the fighter media pipeline migration to a THROWAWAY local Postgres
// cluster and runs its behavioural test. Never touches Supabase.
//
//   node scripts/media/test_media_migration.mjs [--keep]
//
// Needs initdb / pg_ctl / psql on PATH (or PG_BIN=<dir>). Creates the cluster
// in the OS temp dir on a free port, stubs the Supabase roles and the three
// base tables the migration references, applies the migration, runs
// supabase/migrations/tests/20260910210000_ufc_fighter_media_pipeline.test.sql,
// then the rollback, then re-applies (idempotency), and deletes the cluster.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase/migrations/20260910210000_ufc_fighter_media_pipeline.sql');
const TEST = path.join(ROOT, 'supabase/migrations/tests/20260910210000_ufc_fighter_media_pipeline.test.sql');
const ROLLBACK = path.join(ROOT, 'supabase/migrations/rollback/20260910210000_ufc_fighter_media_pipeline.down.sql');
const bin = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);

const STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;
create table public.ufc_fighters (id uuid primary key default gen_random_uuid(), name text not null, espn_athlete_id text);
create table public.ufc_images (id uuid primary key default gen_random_uuid(), fighter_id uuid);
create table public.ufc_image_candidates (id uuid primary key default gen_random_uuid(), fighter_id uuid);
insert into public.ufc_fighters (name, espn_athlete_id) values ('Quentin Pasley', '5307124');
`;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-media-pg-'));
const data = path.join(dir, 'data');
const port = await freePort();
let started = false;
const psql = (args, input) => {
  const r = spawnSync(bin('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', ...args], { input, encoding: 'utf8' });
  if (r.status !== 0) { process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); throw new Error(`psql failed (${args.join(' ')})`); }
  return r.stdout;
};
try {
  execFileSync(bin('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', data, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-l', path.join(dir, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
  started = true;
  psql([], STUBS);
  psql(['-f', MIGRATION]);
  console.log('migration applied');
  process.stdout.write(psql(['-t', '-f', TEST]).trim().split('\n').filter(Boolean).pop() + '\n');
  psql(['-f', ROLLBACK]);
  console.log('rollback applied');
  psql(['-f', MIGRATION]);
  psql(['-f', MIGRATION]);
  console.log('migration re-applied twice (idempotent)');
  process.stdout.write(psql(['-t', '-f', TEST]).trim().split('\n').filter(Boolean).pop() + '\n');
} finally {
  if (started) spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
  if (!process.argv.includes('--keep')) fs.rmSync(dir, { recursive: true, force: true });
}
