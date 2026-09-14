#!/usr/bin/env node
// PBE Algo card readiness: a full dry run of the pre-lock pipeline for upcoming
// UFC cards. READ-ONLY. Writes a report file to the model cache and prints it.
//
//   node scripts/model/algo_readiness.mjs --from 2026-09-15 --until 2026-09-26
//
// For every bout on every card in the window: identity, freshness, feature
// completeness, sample sizes, the registered-model gate, the eligibility
// decision with its exact reasons, and (for eligible bouts only) the dry-run
// probability, confidence label and a market benchmark where a real
// timestamped observation exists. The model score of a NO MODEL CALL bout is
// not reported: an ineligible bout has no call, not a hidden one.

import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, readJsonl, rest, round, daysBetween } from './common.mjs';
import { FEATURE_KEYS } from './feature_spec.mjs';
import { loadArtifact, scoreRow, checkRegisteredModel } from './live.mjs';
import { consensusForBout } from './market_baseline.mjs';
import { evaluateBout, ELIGIBILITY_VERSION, RULES } from './eligibility.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const from = opt('--from', new Date().toISOString().slice(0, 10));
const until = opt('--until', null);
const nowIso = opt('--now', new Date().toISOString());

const cache = cacheDir();
const manifest = JSON.parse(fs.readFileSync(path.join(cache, 'manifest.json'), 'utf8'));
const L = (n) => readJsonl(path.join(cache, `${n}.jsonl`));
const events = L('events'), bouts = L('bouts'), fighters = new Map(L('fighters').map((f) => [f.id, f]));
const results = new Set(L('results').map((r) => r.bout_id));
const featureRows = L('bout_features'), snapshots = L('snapshots'), market = L('market');
const dataset = new Map(readJsonl(path.join(cache, 'dataset.jsonl')).map((r) => [r.bout_id, r]));
const artifact = loadArtifact();
const registry = await checkRegisteredModel(artifact);

const db = rest();
const openAliases = await db.selectAll('ufc_alias_review_queue', '?select=raw_name,candidate_fighter_ids,status&resolved_at=is.null');
const aliases = await db.selectAll('ufc_fighter_aliases', '?select=fighter_id,normalized');
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const namesByFighter = new Map();
for (const [id, f] of fighters) namesByFighter.set(id, new Set([norm(f.name)]));
for (const a of aliases) namesByFighter.get(a.fighter_id)?.add(norm(a.normalized));
/* A pending review blocks a corner only when it is about the SAME name: an
 * unresolved record that may be this fighter (a possible duplicate or split).
 * A different person whose record merely listed this fighter as a fuzzy
 * candidate ("Mauricio Rua" -> Mauricio Ruffy) says nothing about identity. */
const underReview = new Set();
for (const q of openAliases) for (const id of q.candidate_fighter_ids || []) if (namesByFighter.get(id)?.has(norm(q.raw_name))) underReview.add(id);

const eventById = new Map(events.map((e) => [e.id, e]));
const rowsByFighter = new Map();
for (const r of featureRows) { if (!rowsByFighter.has(r.fighter_id)) rowsByFighter.set(r.fighter_id, []); rowsByFighter.get(r.fighter_id).push(r); }
const snapsByFighter = new Map();
for (const s of snapshots) { if (!snapsByFighter.has(s.fighter_id)) snapsByFighter.set(s.fighter_id, []); snapsByFighter.get(s.fighter_id).push(s); }
for (const a of snapsByFighter.values()) a.sort((x, y) => x.as_of_date.localeCompare(y.as_of_date));
const completedByFighter = new Map();
for (const b of bouts) {
  if (!results.has(b.id)) continue;
  const d = eventById.get(b.event_id)?.event_date;
  if (!d) continue;
  for (const f of [b.fighter_a_id, b.fighter_b_id]) { if (!completedByFighter.has(f)) completedByFighter.set(f, []); completedByFighter.get(f).push(d); }
}

function cornerCheck(fighterId, eventDate) {
  const exists = fighters.has(fighterId);
  const prior = (rowsByFighter.get(fighterId) || []).filter((r) => r.event_date < eventDate && ['W', 'L', 'D', 'NC'].includes(r.outcome));
  const snaps = (snapsByFighter.get(fighterId) || []).filter((s) => s.as_of_date <= eventDate);
  const snap = snaps[snaps.length - 1] || null;
  const snapApps = snap?.record ? Number(snap.record.appearances) : 0;
  const lastCompleted = (completedByFighter.get(fighterId) || []).filter((d) => d < eventDate).sort().pop() || null;
  // A snapshot is dated the day after the bout it last includes.
  const stale = Boolean(lastCompleted && (!snap || snap.as_of_date <= lastCompleted));
  return {
    fighter_id: fighterId,
    name: fighters.get(fighterId)?.name ?? null,
    fighter_exists: exists,
    open_alias_review: underReview.has(fighterId),
    ladder_prior_bouts: prior.length,
    snapshot_prior_bouts: snapApps,
    record_reconciles: !snap ? prior.length === 0 : snapApps === prior.length,
    last_completed_bout: lastCompleted,
    snapshot_as_of: snap?.as_of_date ?? null,
    stale,
  };
}

const cards = events.filter((e) => e.event_date >= from && (!until || e.event_date <= until)).sort((a, b) => a.event_date.localeCompare(b.event_date));
const report = {
  generated_at: new Date().toISOString(), now: nowIso, eligibility_version: ELIGIBILITY_VERSION, rules: RULES,
  extract: { extracted_at: manifest.extracted_at, age_hours: round((Date.parse(nowIso) - Date.parse(manifest.extracted_at)) / 3600e3, 2) },
  model: { model_version: artifact.model.model_version, feature_version: artifact.model.feature_version, artifact_status: artifact.model.status, spec_sha256: artifact.model.spec_sha256, registry },
  cards: [],
};

for (const e of cards) {
  const card = { event_id: e.id, event: e.name, event_date: e.event_date, lock_cutoff: new Date(Date.parse(`${e.event_date}T00:00:00Z`) - RULES.lockMinLeadHours * 3600e3).toISOString(), bouts: [] };
  for (const b of bouts.filter((x) => x.event_id === e.id).sort((x, y) => (y.bout_order ?? 0) - (x.bout_order ?? 0))) {
    const row = dataset.get(b.id) || null;
    const corners = [cornerCheck(b.fighter_a_id, e.event_date), cornerCheck(b.fighter_b_id, e.event_date)];
    let scored = null, pickProbability = null, marketBench = null;
    if (row) {
      scored = scoreRow(row, artifact, new Map());
      pickProbability = scored.pick_probability;
      const sides = consensusForBout(market.filter((o) => o.bout_id === b.id), nowIso);
      if (sides) {
        const m = sides.find((s) => s.fighter_id === scored.pick_fighter_id);
        if (m) marketBench = { books: m.books, raw_implied_pick: round(m.implied, 4), devigged_pick: round(m.devigged, 4), pbe_delta_pts: round((pickProbability - m.devigged) * 100, 1) };
      }
    }
    // The registry gate is evaluated as "live" here ONLY to show what the card
    // would look like once the version is registered; the real gate is reported
    // separately and blocks every call today.
    const decision = evaluateBout({
      event: e, bout: { status: b.status, has_result: results.has(b.id), fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id },
      corners, row, pickProbability, modelLive: true, nowIso,
      marketDisagreementPts: marketBench ? Math.abs(marketBench.pbe_delta_pts) : null, regenerationDriftPts: null,
    });
    const eligible = decision.decision === 'ELIGIBLE';
    card.bouts.push({
      bout_id: b.id, order: b.bout_order, card_position: b.card_position, weight_class: b.weight_class, rounds: b.scheduled_rounds, status: b.status,
      fighter_a: corners[0].name, fighter_b: corners[1].name,
      decision: decision.decision, reasons: decision.reasons, confidence: decision.confidence, elite_candidate: decision.elite_candidate,
      pick: eligible ? scored.pick_fighter_name : null,
      pick_probability: eligible ? round(pickProbability, 4) : null,
      band: eligible ? scored.confidence_band : null,
      features_available: row ? `${row.available_count}/${FEATURE_KEYS.length}` : null,
      missing_features: row ? FEATURE_KEYS.filter((_, i) => !row.available[i]) : null,
      sample: row ? { min_prior_bouts: row.min_prior_bouts, min_stat_bouts: row.min_stat_bouts } : null,
      market: eligible ? marketBench : null,
      identity: corners.map(({ name, fighter_exists, open_alias_review, record_reconciles, ladder_prior_bouts, snapshot_prior_bouts, last_completed_bout, snapshot_as_of, stale }) => ({ name, fighter_exists, open_alias_review, record_reconciles, ladder_prior_bouts, snapshot_prior_bouts, last_completed_bout, snapshot_as_of, stale })),
    });
  }
  report.cards.push(card);
}

const out = path.join(cache, 'algo_readiness.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
for (const c of report.cards) {
  const el = c.bouts.filter((x) => x.decision === 'ELIGIBLE').length;
  console.log(`\n${c.event} · ${c.event_date} · lock cutoff ${c.lock_cutoff} · ${el}/${c.bouts.length} eligible`);
  for (const x of c.bouts) {
    const head = `${String(x.order).padStart(2)} ${(x.fighter_a + ' vs ' + x.fighter_b).padEnd(44).slice(0, 44)}`;
    console.log(x.decision === 'ELIGIBLE'
      ? `${head} ELIGIBLE  ${String(x.pick).padEnd(20).slice(0, 20)} ${(x.pick_probability * 100).toFixed(1)}% ${x.confidence.padEnd(6)} feat ${x.features_available} prior ${x.sample.min_prior_bouts}/${x.sample.min_stat_bouts}${x.market ? ` mkt ${(x.market.devigged_pick * 100).toFixed(1)}% Δ${x.market.pbe_delta_pts > 0 ? '+' : ''}${x.market.pbe_delta_pts}` : ' mkt —'}${x.elite_candidate ? ' ELITE?' : ''}`
      : `${head} NO MODEL CALL  ${x.reasons.join(', ')}  (feat ${x.features_available ?? '—'}, prior ${x.sample ? `${x.sample.min_prior_bouts}/${x.sample.min_stat_bouts}` : '—'})`);
  }
}
console.log(`\nmodel registry: ${registry.ok ? 'LIVE' : `NOT LIVE — ${registry.reason}`}`);
console.log(`extract age: ${report.extract.age_hours}h · open alias reviews: ${openAliases.length} (same-name reviews touching a corner: ${[...underReview].length})`);
console.log(`-> ${out}\nREAD-ONLY: nothing was written to the database.`);
