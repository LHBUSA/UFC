#!/usr/bin/env node
// Generate PBE Fight Model predictions for upcoming bouts.
//
//   node scripts/model/predict_upcoming.mjs                 # DRY RUN (default)
//   node scripts/model/predict_upcoming.mjs --until 2026-10-01
//   node scripts/model/predict_upcoming.mjs --apply          # insert UNLOCKED drafts
//
// A dry run writes nothing and prints exactly the rows it would insert.
//
// --apply inserts DRAFTS. A draft is not a pick: it is unlocked, it is excluded
// from the live record by every view, and it can still be revised or deleted.
// Publishing is a separate, deliberate command (publish_predictions.mjs) and a
// separate database function, because "generate a number" and "put your name to
// it in public before a fight" are different decisions and should not share a
// keystroke.
//
// The features come from the SAME builder that produced the walk-forward
// backtest, over the same as-of Fight DNA snapshots, with the same leakage
// audit applied. A live prediction assembled by a second, subtly different code
// path would inherit none of the evidence the backtest provides.

import fs from 'node:fs';
import path from 'node:path';
import { rest, cacheDir, writeJsonl } from './common.mjs';
import { argv, flag, opt, loadArtifact, scoreRow, upcomingRows, marketIndex, cacheAge, line, LINE_HEADER, lockCutoff, hoursUntil } from './live.mjs';

const APPLY = flag('--apply');
const FROM = opt('--from', new Date().toISOString().slice(0, 10));
const UNTIL = opt('--until', null);
const LIMIT = Number(opt('--limit', 0)) || null;

async function main() {
  const artifact = loadArtifact();
  const age = cacheAge();
  const cache = cacheDir();

  console.log(`PBE Fight Model — upcoming predictions  [${APPLY ? 'APPLY' : 'DRY RUN'}]`);
  console.log(`model    ${artifact.model.model_version}  ${artifact.model.feature_version}  status=${artifact.model.status}`);
  console.log(`spec     ${artifact.model.spec_sha256}`);
  if (age) {
    console.log(`extract  ${age.extracted_at} (${age.hours.toFixed(1)}h old)`);
    // Stale features are the quiet failure here: a fighter who fought last
    // weekend would still be scored on the snapshot from before that bout.
    if (age.hours > 24) console.log('WARNING  the extract is over a day old; re-run extract_dataset.mjs before publishing anything.');
  }

  const rows = upcomingRows({ from: FROM, until: UNTIL });
  const byBout = marketIndex();
  const scored = rows.map((r) => scoreRow(r, artifact, byBout));
  const use = LIMIT ? scored.slice(0, LIMIT) : scored;

  if (!use.length) {
    console.log(`\nNo upcoming ungraded bouts in the cache from ${FROM}${UNTIL ? ` to ${UNTIL}` : ''}.`);
    return;
  }

  const byEvent = new Map();
  for (const p of use) {
    if (!byEvent.has(p.event_id)) byEvent.set(p.event_id, []);
    byEvent.get(p.event_id).push(p);
  }

  console.log(`\n${use.length} bouts across ${byEvent.size} events\n`);
  for (const [, group] of byEvent) {
    const head = group[0];
    const cutoff = lockCutoff(head.event_date);
    const hrs = hoursUntil(cutoff);
    console.log(`${head.event_name ?? head.event_id}  ·  ${head.event_date}`);
    console.log(`  lock window closes ${cutoff.toISOString()} — ${hrs >= 0 ? `${hrs.toFixed(1)}h from now` : `CLOSED ${Math.abs(hrs).toFixed(1)}h ago, these can never be published`}`);
    console.log(`  ${LINE_HEADER}`);
    for (const p of group) console.log(`  ${line(p)}`);
    console.log('');
  }

  const withMarket = use.filter((p) => p.market_implied_prob_pick != null);
  const debuts = use.filter((p) => p.sample_context.min_prior_bouts === 0);
  console.log('summary');
  console.log(`  market comparison available   ${withMarket.length}/${use.length}`);
  console.log(`  one corner debuting           ${debuts.length}/${use.length}  (the model has little to say about these)`);
  console.log(`  confidence bands              ${[...new Set(use.map((p) => p.confidence_band))].sort().join(', ')}`);
  const publishable = use.filter((p) => hoursUntil(lockCutoff(p.event_date)) > 0);
  console.log(`  still inside the lock window  ${publishable.length}/${use.length}`);

  // How far the model is from the market, where both exist. This is printed as
  // a WARNING rather than a feature, and the reasoning is worth stating.
  //
  // The backtest gives v1 a Brier skill of about 5.5% over a coin. A closing
  // line does considerably better than that. A model with modest skill should
  // therefore sit CLOSE to the market and differ occasionally; one that
  // disagrees by double digits on the typical fight is far more likely to be
  // wrong than to have found something. "Edge" is a seductive word for a
  // number that is mostly the model's own error, so the operator gets told the
  // size of the disagreement before anyone reads a plus sign as an opportunity.
  if (withMarket.length) {
    const abs = withMarket.map((p) => Math.abs(p.model_edge_pts)).sort((a, b) => a - b);
    const median = abs[abs.length >> 1];
    const wide = withMarket.filter((p) => Math.abs(p.model_edge_pts) >= 15);
    console.log(`
  market disagreement           median ${median.toFixed(1)} pts, ${wide.length}/${withMarket.length} at 15 pts or more`);
    if (median >= 5) {
      console.log('  WARNING  the model is a long way from the market on the typical priced bout. Given its measured');
      console.log('           skill, a disagreement this size is more likely to be model error than an opportunity.');
      console.log('           Treat the edge column as a diagnostic, not a recommendation.');
    }
  }

  const out = path.join(cache, 'upcoming_predictions.json');
  fs.writeFileSync(out, JSON.stringify({
    generated_at: new Date().toISOString(),
    model_version: artifact.model.model_version,
    feature_version: artifact.model.feature_version,
    spec_sha256: artifact.model.spec_sha256,
    dry_run: !APPLY,
    extract: age,
    predictions: use,
  }, null, 2));
  writeJsonl(path.join(cache, 'upcoming_predictions.jsonl'), use);
  console.log(`\n-> ${out}`);

  if (!APPLY) {
    console.log('\nDRY RUN: nothing was written to the database.');
    console.log('  --apply would insert these as UNLOCKED drafts. They would still not appear in the live record.');
    console.log('  Publishing is a separate command: scripts/model/publish_predictions.mjs');
    return;
  }

  await insertDrafts(use, artifact);
}

/** Insert unlocked drafts. Reached only with --apply. */
async function insertDrafts(predictions, artifact) {
  const db = rest();
  const bouts = new Map();
  for (const b of (await db.selectAll('ufc_bouts', '?select=id,fighter_a_id,fighter_b_id'))) bouts.set(b.id, b);

  const payload = predictions.map((p) => {
    const bout = bouts.get(p.bout_id);
    if (!bout) throw new Error(`bout ${p.bout_id} vanished between extract and apply; refusing to guess`);
    // Store the corners in the bout's own order so a row reads the way the card
    // does, and map the probabilities to match rather than reordering them.
    const aIsOne = bout.fighter_a_id === p.fighter_1_id;
    return {
      bout_id: p.bout_id,
      event_id: p.event_id,
      fighter_a_id: bout.fighter_a_id,
      fighter_b_id: bout.fighter_b_id,
      model_version: artifact.model.model_version,
      feature_version: artifact.model.feature_version,
      prob_a: aIsOne ? p.prob_1 : p.prob_2,
      prob_b: aIsOne ? p.prob_2 : p.prob_1,
      pick_fighter_id: p.pick_fighter_id,
      pick_probability: p.pick_probability,
      confidence_band: p.confidence_band,
      feature_vector: p.feature_vector,
      feature_availability: p.feature_availability,
      sample_context: p.sample_context,
      market_implied_prob_pick: p.market_implied_prob_pick,
      market_books: p.market_books,
      market_snapshot_at: p.market_implied_prob_pick == null ? null : new Date().toISOString(),
      model_edge_pts: p.model_edge_pts,
      // locked_at is deliberately absent. The schema rejects it on insert.
    };
  });

  const res = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/ufc_model_predictions?on_conflict=bout_id,model_version,feature_version`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      // ignore-duplicates targets the named conflict columns, not the primary
      // key: without on_conflict above, a second run dies on the unique index.
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`insert failed: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
  const written = await res.json();
  console.log(`\nInserted ${written.length} UNLOCKED drafts (of ${payload.length} offered; duplicates ignored).`);
  console.log('These are NOT published. Nothing appears in the live record until publish_predictions.mjs locks them.');
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
