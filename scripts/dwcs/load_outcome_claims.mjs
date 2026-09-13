#!/usr/bin/env node
/* Load reviewed Contender Series outcome claims into ufc_dwcs_outcome_claims.
 *
 *   node scripts/dwcs/load_outcome_claims.mjs <claims.json>            # dry run: validate + report
 *   node scripts/dwcs/load_outcome_claims.mjs <claims.json> --apply    # write
 *
 * Input is the committed output of extract_outcome_claims.mjs. Rows upsert on
 * their deterministic id (sha of fighter|event|type|source_url), so a re-run
 * rewrites the same rows instead of adding copies. Every row is re-validated
 * against the canonical database before anything is written: the fighter must
 * be on the bout, the bout on the event, and an eligible row must be ufc.com.
 * It writes evidence only; it never creates a display resolution.
 * One failed check and nothing is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [file, ...rest] = process.argv.slice(2);
const apply = rest.includes('--apply');
if (!file) { console.error('usage: load_outcome_claims.mjs <claims.json> [--apply]'); process.exit(2); }
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
const env = Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').replace(/^﻿/, '')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const BASE = (process.env.SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, 'content-type': 'application/json', ...(KEY.startsWith('eyJ') ? { authorization: `Bearer ${KEY}` } : {}) };

const COLS = ['id', 'fighter_id', 'event_id', 'bout_id', 'claim_type', 'claim_status', 'review_reason', 'source_url', 'source_title', 'source_date', 'source_family', 'source_excerpt_short', 'evidence'];
const { claims } = JSON.parse(fs.readFileSync(file, 'utf8'));

const boutIds = [...new Set(claims.map((c) => c.bout_id).filter(Boolean))];
const bouts = new Map();
for (let i = 0; i < boutIds.length; i += 100) {
  const r = await fetch(`${BASE}/rest/v1/ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id&id=in.(${boutIds.slice(i, i + 100).join(',')})`, { headers: H });
  if (!r.ok) throw new Error(`bouts ${r.status}`);
  for (const b of await r.json()) bouts.set(b.id, b);
}
const problems = [];
for (const c of claims) {
  const b = bouts.get(c.bout_id);
  if (!b) problems.push(`${c.id}: bout ${c.bout_id} not found`);
  else {
    if (b.event_id !== c.event_id) problems.push(`${c.id}: bout is not on event ${c.event_id}`);
    if (![b.fighter_a_id, b.fighter_b_id].includes(c.fighter_id)) problems.push(`${c.id}: fighter ${c.fighter_id} is not on bout ${b.id}`);
  }
  if (c.claim_status === 'eligible' && c.source_family !== 'ufc.com') problems.push(`${c.id}: eligible from ${c.source_family}`);
  if (c.claim_status === 'published') problems.push(`${c.id}: legacy triage 'published' (renamed 'eligible' in 20260913000006)`);
  if ((c.source_excerpt_short || '').length > 240) problems.push(`${c.id}: excerpt too long`);
}
const by = (k) => claims.reduce((a, r) => ((a[r[k]] = (a[r[k]] || 0) + 1), a), {});
console.log(JSON.stringify({ file, rows: claims.length, by_status: by('claim_status'), by_type: by('claim_type'), problems: problems.slice(0, 20), problem_count: problems.length, mode: apply ? 'apply' : 'dry-run' }, null, 1));
if (problems.length) process.exit(1);
if (!apply) process.exit(0);

const rows = claims.map((c) => Object.fromEntries(COLS.map((k) => [k, c[k] ?? null])).valueOf()).map((r) => ({ ...r, evidence: r.evidence || {}, updated_at: new Date().toISOString() }));
for (let i = 0; i < rows.length; i += 200) {
  const r = await fetch(`${BASE}/rest/v1/ufc_dwcs_outcome_claims?on_conflict=id`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 200)),
  });
  if (!r.ok) { console.error(`upsert failed at ${i}: ${r.status} ${await r.text()}`); process.exit(1); }
}
const check = await fetch(`${BASE}/rest/v1/ufc_dwcs_outcome_claims?select=claim_status`, { headers: { ...H, Range: '0-9999' } });
const stored = (await check.json()).reduce((a, r) => ((a[r.claim_status] = (a[r.claim_status] || 0) + 1), a), {});
console.log(JSON.stringify({ written: rows.length, stored_by_status: stored }, null, 1));
