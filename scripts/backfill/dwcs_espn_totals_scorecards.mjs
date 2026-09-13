#!/usr/bin/env node
/* Contender Series ESPN fight totals + official scorecards — bounded operator repair.
 *
 * The ufc-stats-ingest daily pass never re-walks a completed card, so its ESPN
 * fight-total and scorecard lanes only reach cards that go final from now on.
 * This fills historical Dana White's Contender Series weeks through THOSE SAME
 * LANES (espnLanes exported from the Worker), so a backfilled row cannot pass a
 * check the live lane would refuse:
 *
 *   fight totals  -> writeFightTotals(): final only, both corners, athlete ids
 *                    round-trip, sig <= total, landed <= attempted, and the 3x3
 *                    significant-strike matrix reproduces its total on BOTH
 *                    axes. Incoherent bout = nothing stored. No sub_att.
 *                    Bouts that already hold totals are skipped.
 *   scorecards    -> reconcileScorecard(): FINAL CARD TOTALS joined on
 *                    official.$ref, named officials only ("Judge 1" slots are
 *                    rejected and counted), both corners required. Written
 *                    only where judge_1 is still null; an existing card is
 *                    never overwritten.
 *
 * What it does NOT touch: events, bouts, results other than the four card
 * fields, fighters, ufc_bout_round_stats (ESPN has no round dimension).
 * Identity is never resolved here: a competition is used only when its ESPN
 * competition id is already on a stored bout AND both ESPN athlete ids are the
 * two fighters that bout already holds.
 *
 *   node scripts/backfill/dwcs_espn_totals_scorecards.mjs plan  [--season 5|brazil] [--max-events N]
 *   node scripts/backfill/dwcs_espn_totals_scorecards.mjs apply [--season 5|brazil] [--max-events N]
 *
 * plan reads ESPN and the database and writes nothing. apply writes, and
 * records one ufc_ingest_runs row (worker dwcs_espn_backfill) with every count
 * and every refusal. Re-running apply is idempotent.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY from the repo .env, or the file
 * named by UFC_ENV_FILE (worktrees have no .env).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(ROOT, 'workers', 'ufc-stats-ingest', 'src');
const { espnLanes } = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
const { Espn } = await import(pathToFileURL(path.join(SRC, 'espn.mjs')).href);
const db = await import(pathToFileURL(path.join(SRC, 'supabase.mjs')).href);
const { writeFightTotals, reconcileScorecard, JUDGED_METHODS } = espnLanes;

const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
const env = {
  ...Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').replace(/^﻿/, '')
    .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])),
  ...process.env,
};
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error(`SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (env file ${envFile})`); process.exit(2); }

const args = process.argv.slice(2);
const mode = args[0];
if (!['plan', 'apply'].includes(mode)) { console.error('usage: plan|apply [--season N|brazil] [--max-events N]'); process.exit(2); }
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const seasonOpt = opt('--season');
const maxEvents = Number(opt('--max-events') || 200);
const apply = mode === 'apply';

/* Series identity, same rule as web/lib/contender.ts. */
const isDwcs = (name) => /contender series/i.test(name || '') && !/road to ufc/i.test(name || '');
const seriesKey = (name) => (/contender series:\s*brazil/i.test(name) ? 'brazil' : (name.match(/season\s*(\d+)/i)?.[1] ?? null));

const nowIso = () => new Date().toISOString();
const events = (await db.selectAll(env, 'ufc_events', 'select=id,name,event_date,espn_event_id,card_status&name=ilike.*contender*series*&order=event_date.asc'))
  .filter((e) => isDwcs(e.name) && e.espn_event_id && (!seasonOpt || seriesKey(e.name) === String(seasonOpt)))
  .slice(0, maxEvents);
const eventIds = events.map((e) => e.id);
const bouts = [];
for (let i = 0; i < eventIds.length; i += 40) {
  bouts.push(...await db.selectAll(env, 'ufc_bouts', `select=id,event_id,espn_competition_id,fighter_a_id,fighter_b_id&event_id=in.(${eventIds.slice(i, i + 40).join(',')})`));
}
const boutByComp = new Map(bouts.filter((b) => b.espn_competition_id).map((b) => [String(b.espn_competition_id), b]));
const fighterIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];
const espnIdOf = new Map();
for (let i = 0; i < fighterIds.length; i += 150) {
  for (const f of await db.selectAll(env, 'ufc_fighters', `select=id,espn_athlete_id&id=in.(${fighterIds.slice(i, i + 150).join(',')})`)) espnIdOf.set(f.id, f.espn_athlete_id);
}
const results = new Map();
for (let i = 0; i < bouts.length; i += 150) {
  for (const r of await db.selectAll(env, 'ufc_bout_results', `select=bout_id,method,judge_1&bout_id=in.(${bouts.slice(i, i + 150).map((b) => b.id).join(',')})`)) results.set(r.bout_id, r);
}

const espn = new Espn({ minIntervalMs: 150 });
const ledger = {
  mode, season: seasonOpt, events: events.length, competitions: 0, completed: 0,
  totals: { candidates: 0, already_stored: 0, bouts_written: 0, rows_written: 0, incoherent: 0, incomplete: 0, identity_refused: 0 },
  cards: { judged: 0, already_carded: 0, looked_up: 0, written: 0, cards_written: 0, no_named_card: 0, rejected_reasons: {} },
  refused: [], assertion_failures: [],
};

let runId = null;
if (apply) {
  const [row] = await db.insert(env, 'ufc_ingest_runs', { worker: 'dwcs_espn_backfill', status: 'running', notes: { mode, season: seasonOpt, operator: 'scripts/backfill/dwcs_espn_totals_scorecards.mjs' } });
  runId = row?.id || null;
}

let status = 'success';
try {
  for (const e of events) {
    let ev; let espnBouts;
    try {
      ev = await espn.event(e.espn_event_id);
      espnBouts = await espn.bouts(ev);
    } catch (err) {
      ledger.assertion_failures.push({ event: e.name, detail: String(err?.message || err).slice(0, 200) });
      continue;
    }
    /* A fresh run object per card: the lanes' per-run caps (40) then bound one
     * card, never the whole backfill, and every counter still lands in ledger. */
    const run = { scorecards_reconciled: 0, scorecards_written: 0, scorecard_cards_written: 0, totals_reconciled: 0, totals_bouts_written: 0, totals_rows_written: 0, assertion_failures: [], notes: {} };
    const candidates = [];
    for (const b of espnBouts) {
      ledger.competitions += 1;
      if (!b.completed || !b.result) continue;
      ledger.completed += 1;
      const stored = boutByComp.get(String(b.espn_competition_id));
      const pair = b.fighters.map((f) => f.espn_athlete_id);
      const storedPair = stored ? [espnIdOf.get(stored.fighter_a_id), espnIdOf.get(stored.fighter_b_id)] : [];
      /* Identity round-trip BEFORE anything is attached to a stored bout. */
      if (!stored || pair.some((id) => !storedPair.includes(id)) || new Set(pair).size !== 2) {
        ledger.totals.identity_refused += 1;
        ledger.refused.push({ event: e.name, competition: b.espn_competition_id, reason: stored ? 'athlete ids do not match stored bout' : 'competition not on a stored bout' });
        continue;
      }
      const fighterFor = (espnId) => (espnIdOf.get(stored.fighter_a_id) === espnId ? stored.fighter_a_id : stored.fighter_b_id);
      candidates.push({
        boutId: stored.id, competitionRef: b.source_url, espnCompetitionId: b.espn_competition_id,
        corners: b.fighters.map((f) => ({ espnAthleteId: f.espn_athlete_id, fighterId: fighterFor(f.espn_athlete_id) })),
      });

      const res = results.get(stored.id);
      if (!res || !JUDGED_METHODS.includes(res.method)) continue;
      ledger.cards.judged += 1;
      if (res.judge_1) { ledger.cards.already_carded += 1; continue; }
      const officiating = await espn.officiating(b.officials_ref);
      ledger.cards.looked_up += 1;
      const card = await reconcileScorecard(espn, run, { competitionRef: b.source_url, competitorIds: pair, judges: officiating.judges });
      for (const r of card.rejected) ledger.cards.rejected_reasons[r.reason] = (ledger.cards.rejected_reasons[r.reason] || 0) + 1;
      if (!Object.keys(card.fields).length) { ledger.cards.no_named_card += 1; continue; }
      if (apply) {
        /* judge_1=is.null in the filter: a card written by anyone since the read wins. */
        const n = await db.patchCount(env, 'ufc_bout_results', `bout_id=eq.${stored.id}&judge_1=is.null`, card.fields);
        if (n === 1) { ledger.cards.written += 1; ledger.cards.cards_written += card.cards.length; }
      } else {
        ledger.cards.written += 1; ledger.cards.cards_written += card.cards.length;
      }
    }

    ledger.totals.candidates += candidates.length;
    if (apply) {
      await writeFightTotals(env, espn, run, candidates);
    } else {
      /* Plan: the lane's own existence check and readers, no upsert. */
      const have = new Set((await db.select(env, 'ufc_bout_fight_stats', `select=bout_id&bout_id=in.(${candidates.map((c) => c.boutId).join(',') || '00000000-0000-0000-0000-000000000000'})`) || []).map((r) => r.bout_id));
      for (const c of candidates) {
        if (have.has(c.boutId)) continue;
        const corners = await Promise.all(c.corners.map((x) => espn.fightTotals(c.competitionRef, x.espnAthleteId)));
        if (corners.some((x) => !x)) { run.notes.fight_totals_incomplete = (run.notes.fight_totals_incomplete || 0) + 1; continue; }
        const bad = corners.flatMap((t) => espnLanes.fightTotalsIncoherence(t));
        if (bad.length) { run.notes.fight_totals_incoherent = (run.notes.fight_totals_incoherent || 0) + 1; run.assertion_failures.push({ class: 'FightTotalsIncoherent', url: c.competitionRef, detail: bad.join('; ') }); continue; }
        run.totals_bouts_written += 1; run.totals_rows_written += 2;
      }
    }
    /* writeFightTotals counts a lookup only for bouts that held no totals. */
    if (apply) ledger.totals.already_stored += Math.max(0, candidates.length - run.totals_reconciled);
    ledger.totals.bouts_written += run.totals_bouts_written;
    ledger.totals.rows_written += run.totals_rows_written;
    ledger.totals.incoherent += run.notes.fight_totals_incoherent || 0;
    ledger.totals.incomplete += run.notes.fight_totals_incomplete || 0;
    ledger.assertion_failures.push(...run.assertion_failures.map((a) => ({ event: e.name, ...a })));
    console.log(`${apply ? 'APPLY' : 'PLAN '} ${e.event_date} ${e.name}: candidates=${candidates.length} totals+${run.totals_bouts_written} cards+${run.scorecards_written}`);
  }
} catch (err) {
  status = 'failed';
  ledger.assertion_failures.push({ class: err?.name || 'Error', detail: String(err?.message || err).slice(0, 300) });
  console.error(err);
} finally {
  ledger.espn_subrequests = espn.subrequests;
  if (runId) {
    await db.patch(env, 'ufc_ingest_runs', `id=eq.${runId}`, { status, finished_at: nowIso(), assertion_failures: ledger.assertion_failures.slice(0, 50), notes: { ...ledger, refused: ledger.refused.slice(0, 50), assertion_failures: undefined } });
  }
  console.log(JSON.stringify({ status, run_id: runId, ...ledger, refused: ledger.refused.slice(0, 20), assertion_failures: ledger.assertion_failures.slice(0, 20) }, null, 1));
}
process.exit(status === 'success' ? 0 : 1);
