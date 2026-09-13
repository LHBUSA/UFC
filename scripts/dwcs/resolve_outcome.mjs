#!/usr/bin/env node
/* Record ONE operator decision to display a Contender Series outcome claim.
 *
 *   node scripts/dwcs/resolve_outcome.mjs --claim <claim_id> --by "<operator>" [--notes "..."]            # dry run
 *   node scripts/dwcs/resolve_outcome.mjs --claim <claim_id> --by "<operator>" [--notes "..."] --apply
 *   node scripts/dwcs/resolve_outcome.mjs --withdraw <resolution_id> --by "<operator>" --reason "..." --apply
 *
 * One claim per invocation, a named person every time, no batch mode: the
 * resolution is the review act, so it is never generated in bulk. The
 * database trigger on ufc_dwcs_outcome_resolutions rejects anything that is
 * not an eligible official claim for a fighter without a conflicting claim;
 * this script adds nothing it could bypass. Withdrawal hides the outcome and
 * keeps both the decision and the evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const apply = argv.includes('--apply');
const by = opt('--by');
if (!by || !by.trim()) { console.error('--by "<operator name>" is required'); process.exit(2); }
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
const env = Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').replace(/^﻿/, '')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const BASE = (process.env.SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, 'content-type': 'application/json', ...(KEY?.startsWith('eyJ') ? { authorization: `Bearer ${KEY}` } : {}) };

const withdraw = opt('--withdraw');
if (withdraw) {
  const reason = opt('--reason');
  if (!reason) { console.error('--reason is required to withdraw'); process.exit(2); }
  const body = { resolution_status: 'withdrawn', withdrawn_at: new Date().toISOString(), withdrawn_by: by, withdrawn_reason: reason };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', withdraw, ...body }, null, 1));
  if (!apply) process.exit(0);
  const r = await fetch(`${BASE}/rest/v1/ufc_dwcs_outcome_resolutions?id=eq.${withdraw}&resolution_status=eq.approved`, { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(body) });
  const rows = r.ok ? await r.json() : null;
  if (!r.ok || rows.length !== 1) { console.error(`withdraw failed: ${r.status} ${rows ? JSON.stringify(rows) : await r.text()}`); process.exit(1); }
  console.log('withdrawn', rows[0].id);
  process.exit(0);
}

const claimId = opt('--claim');
if (!claimId) { console.error('--claim <claim_id> is required'); process.exit(2); }
const cr = await fetch(`${BASE}/rest/v1/ufc_dwcs_outcome_claims?select=id,fighter_id,event_id,bout_id,claim_type,claim_status,source_family,source_url,source_excerpt_short&id=eq.${claimId}`, { headers: H });
const [c] = cr.ok ? await cr.json() : [];
if (!c) { console.error(`claim ${claimId} not found`); process.exit(1); }
const row = { fighter_id: c.fighter_id, event_id: c.event_id, bout_id: c.bout_id, claim_type: c.claim_type, selected_claim_id: c.id,
  resolution_rule: 'operator_decision', resolved_by: by, review_notes: opt('--notes') || null };
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', claim: c, resolution: row }, null, 1));
if (!apply) process.exit(0);
const r = await fetch(`${BASE}/rest/v1/ufc_dwcs_outcome_resolutions`, { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row) });
if (!r.ok) { console.error(`refused: ${r.status} ${await r.text()}`); process.exit(1); }
console.log('approved', (await r.json())[0].id);
