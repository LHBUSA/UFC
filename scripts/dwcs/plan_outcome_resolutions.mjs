#!/usr/bin/env node
/* Contender Series outcome resolutions — REVIEW PLAN. Read-only.
 *
 *   node scripts/dwcs/plan_outcome_resolutions.mjs --out <plan.json>
 *
 * Lists which evidence rows COULD be put in front of an operator for a
 * display decision. It approves nothing and writes nothing to the database;
 * approving is scripts/dwcs/resolve_outcome.mjs, one claim at a time, by a
 * named person.
 *
 * A claim is a review candidate only if every check holds:
 *   - official source (ufc.com) and triage 'eligible'
 *   - an explicit, fighter-named contract / developmental / TUF statement
 *     (that is what 'eligible' already required of the extractor)
 *   - the claim's fighter is on the claim's bout, and the bout on its event
 *   - the fighter has no conflicted claim of the same outcome type
 *   - the stored result records that fighter as the winner (result coherence)
 *   - no approved resolution already covers the outcome
 * One candidate per (fighter, event, outcome); where several UFC.com articles
 * say the same thing, the ESPN-corroborated then earliest is proposed, and the
 * others are listed as supporting evidence. Everything else is listed with
 * the reason it is not a candidate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? process.argv[i + 1] : null; })();
if (!out) { console.error('usage: --out <plan.json>'); process.exit(2); }
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
const env = Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').replace(/^﻿/, '')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const BASE = (process.env.SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Accept: 'application/json', ...(KEY?.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}) };
async function all(p) {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${BASE}/rest/v1/${p}&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
    const page = await r.json(); rows.push(...page); if (page.length < 1000) break;
  }
  return rows;
}

const claims = await all('ufc_dwcs_outcome_claims?select=id,fighter_id,event_id,bout_id,claim_type,claim_status,source_family,source_url,source_title,source_date,source_excerpt_short,evidence&order=id.asc');
const resolutions = await all('ufc_dwcs_outcome_resolutions?select=id,fighter_id,event_id,claim_type,selected_claim_id,resolution_status&order=id.asc');
const boutIds = [...new Set(claims.map((c) => c.bout_id).filter(Boolean))];
const bouts = new Map();
for (let i = 0; i < boutIds.length; i += 100) {
  for (const b of await all(`ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,result:ufc_bout_results(winner_id,method),event:ufc_events(name,event_date),fa:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name),fb:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name)&id=in.(${boutIds.slice(i, i + 100).join(',')})`)) bouts.set(b.id, b);
}
const one = (v) => (Array.isArray(v) ? v[0] : v);
const conflicted = new Set(claims.filter((c) => c.claim_status === 'conflicted').map((c) => `${c.fighter_id}|${c.claim_type}`));
const approved = new Set(resolutions.filter((r) => r.resolution_status === 'approved').map((r) => `${r.fighter_id}|${r.event_id}|${r.claim_type}`));

const excluded = [];
const eligible = [];
for (const c of claims) {
  const b = bouts.get(c.bout_id);
  const reasons = [];
  if (c.source_family !== 'ufc.com') reasons.push(`source ${c.source_family} is not the official source`);
  if (c.claim_status !== 'eligible') reasons.push(`triage ${c.claim_status}`);
  if (!b) reasons.push('bout not found');
  else {
    if (b.event_id !== c.event_id) reasons.push('bout is not on the claim event');
    if (![b.fighter_a_id, b.fighter_b_id].includes(c.fighter_id)) reasons.push('fighter is not on the claim bout');
    if (one(b.result)?.winner_id !== c.fighter_id) reasons.push('stored result does not record this fighter as the winner');
  }
  if (conflicted.has(`${c.fighter_id}|${c.claim_type}`)) reasons.push('a conflicting claim for this fighter and outcome is unresolved');
  if (approved.has(`${c.fighter_id}|${c.event_id}|${c.claim_type}`)) reasons.push('already resolved');
  if (reasons.length) excluded.push({ claim_id: c.id, claim_status: c.claim_status, source_family: c.source_family, reasons });
  else eligible.push({ c, b });
}

const byOutcome = new Map();
for (const x of eligible) {
  const k = `${x.c.fighter_id}|${x.c.event_id}|${x.c.claim_type}`;
  byOutcome.set(k, [...(byOutcome.get(k) || []), x]);
}
const candidates = [...byOutcome.values()].map((list) => {
  const sorted = [...list].sort((a, z) => Number(Boolean(z.c.evidence?.corroborated_by)) - Number(Boolean(a.c.evidence?.corroborated_by))
    || String(a.c.source_date || '').localeCompare(String(z.c.source_date || '')));
  const { c, b } = sorted[0];
  const fighter = [one(b.fa), one(b.fb)].find((f) => f?.id === c.fighter_id);
  return {
    proposed_claim_id: c.id,
    fighter: fighter?.name, fighter_id: c.fighter_id,
    event: one(b.event)?.name, event_date: one(b.event)?.event_date, event_id: c.event_id, bout_id: c.bout_id,
    claim_type: c.claim_type,
    source_url: c.source_url, source_date: c.source_date, excerpt: c.source_excerpt_short,
    espn_corroborated: Boolean(c.evidence?.corroborated_by),
    supporting_claim_ids: sorted.slice(1).map((x) => x.c.id),
    decision: 'PENDING OPERATOR REVIEW',
  };
}).sort((a, z) => String(a.event_date).localeCompare(String(z.event_date)) || String(a.fighter).localeCompare(String(z.fighter)));

const plan = {
  generated_at: new Date().toISOString(),
  approves_nothing: true,
  apply_with: 'node scripts/dwcs/resolve_outcome.mjs --claim <proposed_claim_id> --by "<operator name>" [--notes "..."] --apply',
  counts: {
    evidence_rows: claims.length,
    candidates: candidates.length,
    candidates_espn_corroborated: candidates.filter((x) => x.espn_corroborated).length,
    by_type: candidates.reduce((a, x) => ((a[x.claim_type] = (a[x.claim_type] || 0) + 1), a), {}),
    excluded_rows: excluded.length,
    already_resolved: resolutions.filter((r) => r.resolution_status === 'approved').length,
  },
  candidates,
  excluded,
};
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(JSON.stringify(plan.counts, null, 1));
