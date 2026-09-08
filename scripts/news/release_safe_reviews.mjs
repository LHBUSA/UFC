#!/usr/bin/env node
/*
 * Release only newsroom rows held by the known exact-time validator bug.
 *
 * The deterministic writer stores elapsed/control values as *_sec numbers in
 * the fact block, then may render the same value as M:SS in prose. The legacy
 * numeric gate compared tokens literally, so 716 seconds in the fact block
 * could falsely hold the article for publishing "11:56".
 *
 * This repair is intentionally narrow:
 *   - only status=review rows with a machine review_reason are considered;
 *   - the reason must contain NOTHING except "numbers not in fact block";
 *   - every rejected M:SS token must be an exact formatting of a finite *_sec
 *     value already present in that same stored fact block;
 *   - editor-held / external rows (no review_reason) are never touched;
 *   - depth, link, injury, odds/model, duplicate, or any other gate failure
 *     keeps the row in review.
 *
 * Usage:
 *   node scripts/news/release_safe_reviews.mjs --dry-run
 *   node scripts/news/release_safe_reviews.mjs --apply
 */
import { Supabase, loadEnv } from './lib.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const APPLY = argv.includes('--apply');
if (DRY === APPLY) {
  console.error('Pass exactly one of --dry-run or --apply.');
  process.exit(2);
}

function mmss(seconds) {
  const n = Math.abs(Math.trunc(Number(seconds)));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function exactSecondTokens(value, key = '', out = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) exactSecondTokens(v, key, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (/_sec$/i.test(k) && typeof v === 'number' && Number.isFinite(v)) out.add(mmss(v));
    if (v && typeof v === 'object') exactSecondTokens(v, k, out);
  }
  return out;
}

function parsePureNumberHold(reason) {
  const text = String(reason || '').trim();
  const m = text.match(/^numbers not in fact block:\s*(.+)$/i);
  if (!m) return null;
  const tokens = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  return tokens.length ? tokens : null;
}

async function main() {
  const sb = new Supabase(loadEnv());
  const rows = await sb.select(
    'ufc_articles',
    'select=id,slug,story_type,status,needs_human,published_at,updated_at,fact_block,model_version&status=eq.review&order=updated_at.desc&limit=500',
  );

  const eligible = [];
  const held = [];
  for (const row of rows) {
    const reason = row.fact_block?.review_reason || null;
    const bad = parsePureNumberHold(reason);
    if (!bad) {
      held.push({ slug: row.slug, reason: reason || 'editor/manual review' });
      continue;
    }
    const exact = exactSecondTokens(row.fact_block);
    const unsupported = bad.filter((token) => !exact.has(token));
    if (unsupported.length) {
      held.push({ slug: row.slug, reason, unsupported });
      continue;
    }
    eligible.push({ row, bad, exact: [...exact].sort() });
  }

  console.log(JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY_RUN',
    review_rows: rows.length,
    eligible: eligible.map(({ row, bad }) => ({ slug: row.slug, story_type: row.story_type, tokens: bad })),
    held,
  }, null, 2));

  if (!APPLY) return;
  for (const { row, bad } of eligible) {
    const factBlock = structuredClone(row.fact_block || {});
    delete factBlock.review_reason;
    const now = new Date().toISOString();
    await sb.patch('ufc_articles', `id=eq.${row.id}`, {
      status: 'published',
      needs_human: false,
      published_at: row.published_at || now,
      updated_at: now,
      fact_block: factBlock,
    });
    console.log(`released ${row.slug} (${bad.join(', ')})`);
  }

  console.log(JSON.stringify({ acceptance: 'PASS', released: eligible.length }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
