// PBE Algo scheduler cycle.
//
//   card discovered -> identity verified -> features assembled -> eligibility
//   -> (armed) draft generated / regenerated / withdrawn -> (armed, in the lock
//   window) final pass + database-clock lock -> (armed) automatic grading
//
// MODES
//   dry_run  reads everything, scores with the registered model (or, before
//            registration, the bundled release artifact, clearly labelled) and
//            writes ONLY a ufc_model_runs row. No evaluation, draft, lock or grade.
//   armed    requires a registered, status=live model whose stored coefficients
//            re-hash to its spec_sha256. Writes evaluations, drafts, locks, grades.
//
// Every write the database guards is also refused by the database: locked rows
// cannot change, locks take the database clock and refuse after the cutoff,
// grades are append-only and bound to the stored result.

import { FEATURE_KEYS, FEATURE_VERSION, MODEL_VERSION } from '../../../scripts/model/feature_spec.mjs';
import { SNAPSHOT_SELECT, assembleBoutRow, round } from '../../../scripts/model/features_core.mjs';
import { evaluateBout, ELIGIBILITY_VERSION, RULES, CARD_CHANGE_BLOCKING } from '../../../scripts/model/eligibility.mjs';
import { predictOne } from '../../../scripts/model/logistic.mjs';
import { marketComparison, officialMarketColumns } from './market.js';
import { resolveChampion } from './champion.js';
import { activeChallenger } from './learning/daily.js';
import { shadowCall, writeShadow, gradeShadow } from './learning/shadow.js';
import artifact from '../../../web/lib/generated/model-v1.json';
import { db } from './supabase.js';

export const LOCK_HOURS_BEFORE_EVENT_DAY = 8;       // lock pass opens at event_date 00:00Z - 8h (16:00Z the day before)
export const HORIZON_DAYS = 14;
const MAX_PAGE = 1000;

export const band = (p) => {
  const c = Math.max(p, 1 - p);
  return c < 0.55 ? '50-55' : c < 0.6 ? '55-60' : c < 0.65 ? '60-65' : c < 0.7 ? '65-70' : c < 0.8 ? '70-80' : '80-100';
};

const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const dayMs = 86400e3;

/**
 * The model the cycle may score with: the one live, hash-verified champion of
 * the family, resolved from the registry every cycle (so an owner-approved
 * promotion applies from the next cycle, and nothing else can). The bundled
 * release artifact is used only by a dry run before any version is registered.
 */
export async function resolveModel(q, mode) {
  const c = await resolveChampion(q);
  if (c.live) return { source: 'registry', live: true, model_version: c.model_version, spec_sha256: c.spec_sha256, beta: c.beta, scale: c.scale };
  if (c.row) {
    if (/re-hash|live versions/.test(c.blocked) || mode === 'armed') return { source: 'registry', live: false, blocked: c.blocked };
  } else if (mode === 'armed') return { source: 'none', live: false, blocked: c.blocked };
  const a = artifact.model;
  return { source: 'artifact_unregistered', live: false, model_version: a.model_version, spec_sha256: a.spec_sha256, beta: FEATURE_KEYS.map((k) => a.coefficients[k]), scale: FEATURE_KEYS.map((k) => a.feature_scale[k]) };
}

/** Everything needed to assemble and evaluate one card, in bounded reads. */
export async function loadCard(q, event, nowIso = new Date().toISOString()) {
  const D = event.event_date;
  const bouts = await q.get(`ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,weight_class,is_womens,is_title,scheduled_rounds,card_position,bout_order,status&event_id=eq.${event.id}&order=bout_order.desc`);
  const fighterIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];
  const fighters = new Map((await q.inChunks('ufc_fighters', 'id', fighterIds, 'id,name,dob,height_in,reach_in,stance')).map((f) => [f.id, f]));

  const snapsOf = new Map();
  for (const id of fighterIds) {
    const s = await q.get(`ufc_fighter_dna_snapshots?select=${SNAPSHOT_SELECT}&fighter_id=eq.${id}&definition_version=eq.1&as_of_date=lte.${D}&order=as_of_date.desc&limit=1`);
    snapsOf.set(id, s);
  }

  const rowsOf = new Map();
  const addRows = (rows) => { for (const r of rows) { if (!rowsOf.has(r.fighter_id)) rowsOf.set(r.fighter_id, []); if (!rowsOf.get(r.fighter_id).some((x) => x.bout_id === r.bout_id)) rowsOf.get(r.fighter_id).push(r); } };
  const own = await q.inChunks('ufc_fighter_bout_features', 'fighter_id', fighterIds, 'fighter_id,bout_id,opponent_id,event_date,outcome,opp_totals:raw_stats->opp_totals', `&feature_version=eq.1&event_date=lt.${D}`, 8);
  if (own.length >= MAX_PAGE) throw new Error('bout feature read hit the page cap');
  addRows(own);
  const opponents = [...new Set(own.map((r) => r.opponent_id))].filter((id) => id && !fighterIds.includes(id));
  const opp = await q.inChunks('ufc_fighter_bout_features', 'fighter_id', opponents, 'fighter_id,bout_id,opponent_id,event_date,outcome', `&feature_version=eq.1&event_date=lt.${D}`, 8);
  addRows(opp);

  const boutIds = bouts.map((b) => b.id);
  const results = new Set((await q.inChunks('ufc_bout_results', 'bout_id', boutIds, 'bout_id')).map((r) => r.bout_id));
  const changes = await q.inChunks('ufc_event_card_changes', 'bout_id', boutIds, 'bout_id,status_type,state', `&state=eq.active&status_type=in.(${CARD_CHANGE_BLOCKING.join(',')})`);
  const changed = new Set(changes.map((c) => c.bout_id));

  const reviews = fighterIds.length ? await q.get(`ufc_alias_review_queue?select=raw_name,candidate_fighter_ids&resolved_at=is.null&candidate_fighter_ids=ov.{${fighterIds.join(',')}}`) : [];
  const aliases = await q.inChunks('ufc_fighter_aliases', 'fighter_id', fighterIds, 'fighter_id,normalized');
  const names = new Map(fighterIds.map((id) => [id, new Set([norm(fighters.get(id)?.name)])]));
  for (const a of aliases) names.get(a.fighter_id)?.add(norm(a.normalized));
  const underReview = new Set();
  for (const r of reviews) for (const id of r.candidate_fighter_ids || []) if (names.get(id)?.has(norm(r.raw_name))) underReview.add(id);

  const lastCompleted = new Map();
  for (const id of fighterIds) {
    const done = await q.get(`ufc_bouts?select=id,ufc_events!inner(event_date),ufc_bout_results!inner(bout_id)&or=(fighter_a_id.eq.${id},fighter_b_id.eq.${id})&ufc_events.event_date=lt.${D}`);
    lastCompleted.set(id, done.map((b) => b.ufc_events.event_date).sort().pop() || null);
  }

  const corner = (id) => {
    const snap = snapsOf.get(id)?.[0] || null;
    const prior = (rowsOf.get(id) || []).filter((r) => ['W', 'L', 'D', 'NC'].includes(r.outcome)).length;
    const last = lastCompleted.get(id);
    return {
      fighter_id: id, name: fighters.get(id)?.name ?? null,
      fighter_exists: fighters.has(id), open_alias_review: underReview.has(id),
      record_reconciles: snap?.record ? Number(snap.record.appearances) === prior : prior === 0,
      stale: Boolean(last && (!snap || snap.as_of_date <= last)),
      snapshot_as_of: snap?.as_of_date ?? null, last_completed_bout: last, ladder_prior_bouts: prior,
    };
  };

  /* Market, read only up to this cycle's clock: the newest provider snapshot per
   * bout (all quotes of that fetch), and change history as the fallback. */
  const snapshots = [];
  for (const id of boutIds) {
    const rows = await q.get(`ufc_market_run_quotes?select=bout_id,run_id,bookmaker_key,market_key,outcome_fighter_id,price,source_last_update,observed_at&bout_id=eq.${id}&market_key=eq.h2h&observed_at=lte.${encodeURIComponent(nowIso)}&order=observed_at.desc&limit=60`);
    snapshots.push(...rows);
  }
  const market = boutIds.length ? await q.inChunks('ufc_market_observations', 'bout_id', boutIds, 'bout_id,bookmaker_key,market_key,outcome_fighter_id,price,source_last_update,observed_at', `&market_key=eq.h2h&observed_at=lte.${encodeURIComponent(nowIso)}`) : [];
  return { bouts, fighters, snapsOf, rowsOf, results, changed, corner, market, snapshots };
}

/**
 * When the prices behind a market comparison were actually taken. The consensus
 * uses the latest h2h price per book per side at or before `nowIso`; this
 * reports the newest and oldest of exactly those prices, so a comparison can
 * never present a days-old snapshot as current.
 */
export function marketProvenance(observations, nowIso) {
  const usable = observations.filter((o) => o.market_key === 'h2h' && o.outcome_fighter_id && o.price != null && o.observed_at && o.observed_at <= nowIso);
  const latest = new Map();
  for (const o of usable) {
    const k = `${o.bookmaker_key}|${o.outcome_fighter_id}`;
    const prev = latest.get(k);
    if (!prev || (prev.source_last_update || prev.observed_at) <= (o.source_last_update || o.observed_at)) latest.set(k, o);
  }
  const rows = [...latest.values()];
  if (!rows.length) return null;
  const obs = rows.map((o) => o.observed_at).sort();
  const upd = rows.map((o) => o.source_last_update || o.observed_at).sort();
  return {
    observed_at: obs[obs.length - 1],
    oldest_observed_at: obs[0],
    oldest_book_update: upd[0],
    age_hours: Math.round(((Date.parse(nowIso) - Date.parse(obs[obs.length - 1])) / 3600e3) * 10) / 10,
  };
}

export function lockWindow(eventDate, now) {
  const cutoff = Date.parse(`${eventDate}T00:00:00Z`);
  const opens = cutoff - LOCK_HOURS_BEFORE_EVENT_DAY * 3600e3;
  const closes = cutoff - RULES.lockMinLeadHours * 3600e3;
  return { opens: new Date(opens).toISOString(), closes: new Date(closes).toISOString(), open: now >= opens && now < closes };
}

export async function runCycle(env, { trigger = 'cron', mode: requested, now = Date.now() } = {}) {
  const mode = (requested || env.ALGO_MODE) === 'armed' && env.ALGO_MODE === 'armed' ? 'armed' : 'dry_run';
  const q = db(env);
  const nowIso = new Date(now).toISOString();
  const [run] = await q.post('ufc_model_runs', { trigger, mode, worker_version: env.CF_VERSION_METADATA?.id || null, model_version: MODEL_VERSION, feature_version: FEATURE_VERSION, eligibility_version: ELIGIBILITY_VERSION });
  const report = { run_id: run.id, mode, trigger, now: nowIso, model: null, cards: [], writes: { evaluations: 0, drafts_inserted: 0, drafts_regenerated: 0, drafts_withdrawn: 0, locked: 0, graded: 0 }, blocked: null };
  try {
    const model = await resolveModel(q, mode);
    report.model = { source: model.source, live: model.live, model_version: model.model_version ?? null, spec_sha256: model.spec_sha256 ?? null, blocked: model.blocked ?? null };
    /* Shadow track: the single active challenger of this champion, scored beside it. Never an official call. */
    /* Isolated: nothing on the shadow track can fail, delay or alter an official call. */
    report.writes.shadow = { inserted: 0, updated: 0, locked: 0, skipped_locked: 0, graded: 0, errors: [] };
    const shadowError = (where, e) => { if (report.writes.shadow.errors.length < 20) report.writes.shadow.errors.push(`${where}: ${String(e?.message || e).slice(0, 200)}`); };
    let challenger = null;
    try { challenger = model.live ? await activeChallenger(q, model.model_version) : null; } catch (e) { shadowError('challenger', e); }
    report.challenger = challenger ? { training_run_id: challenger.id, spec_sha256: challenger.spec_sha256, training_bouts: challenger.training_bouts, created_at: challenger.created_at } : null;
    if (mode === 'armed' && !model.live) {
      report.blocked = model.blocked;
      await q.patch(`ufc_model_runs?id=eq.${run.id}`, { status: 'blocked', finished_at: new Date().toISOString(), counts: report.writes, error: model.blocked }, 'return=minimal');
      return report;
    }

    const today = nowIso.slice(0, 10);
    const until = new Date(now + HORIZON_DAYS * dayMs).toISOString().slice(0, 10);
    const events = await q.get(`ufc_events?select=id,name,event_date,card_status&event_date=gte.${today}&event_date=lte.${until}&order=event_date.asc`);

    for (const event of events) {
      const card = await loadCard(q, event, nowIso);
      const win = lockWindow(event.event_date, now);
      const cardReport = { event_id: event.id, event: event.name, event_date: event.event_date, lock_window: win, bouts: [] };
      /* Every version's rows for these bouts: a locked call of ANY version is permanent and blocks a new draft; an unlocked draft of a non-champion version is withdrawn. */
      const existing = mode === 'armed' && card.bouts.length
        ? await q.inChunks('ufc_model_predictions', 'bout_id', card.bouts.map((b) => b.id), 'id,bout_id,locked_at,prob_a,pick_probability,model_version', `&feature_version=eq.${FEATURE_VERSION}`)
        : [];
      const predByBout = new Map(existing.filter((p) => p.model_version === model.model_version).map((p) => [p.bout_id, p]));
      const lockedByBout = new Map(existing.filter((p) => p.locked_at).map((p) => [p.bout_id, p]));
      const staleDrafts = existing.filter((p) => !p.locked_at && p.model_version !== model.model_version);
      let shadowByBout = null;
      if (mode === 'armed' && challenger && card.bouts.length) {
        try { shadowByBout = new Map((await q.inChunks('ufc_model_shadow_predictions', 'bout_id', card.bouts.map((b) => b.id), 'id,bout_id,locked_at', `&training_run_id=eq.${challenger.id}`)).map((x) => [x.bout_id, x])); } catch (e) { shadowError('shadow read', e); }
      }
      if (mode === 'armed') {
        for (const d of staleDrafts) {
          await q.del(`ufc_model_predictions?id=eq.${d.id}&locked_at=is.null`);
          report.writes.drafts_withdrawn += 1;
        }
      }

      for (const b of card.bouts) {
        const corners = [card.corner(b.fighter_a_id), card.corner(b.fighter_b_id)];
        let row = null;
        try { row = assembleBoutRow(b, event, card.fighters, card.snapsOf, card.rowsOf); } catch { row = null; }
        const integrityBad = row?.snapshot_integrity?.some((s) => s.target_in_snapshot || s.snapshot_after_event);
        if (integrityBad) row = null;

        let p1 = null, pickFighter = null, pickProbability = null, probA = null;
        if (row) {
          p1 = predictOne(row.x, model.beta, model.scale);
          const pick1 = p1 >= 0.5;
          pickFighter = pick1 ? row.fighter_1_id : row.fighter_2_id;
          pickProbability = Math.max(p1, 1 - p1);
          probA = b.fighter_a_id === row.fighter_1_id ? p1 : 1 - p1;
        }
        const market = marketComparison({
          snapshots: card.snapshots.filter((o) => o.bout_id === b.id),
          observations: card.market.filter((o) => o.bout_id === b.id),
          pickFighterId: pickFighter, pickProbability, nowIso,
        });

        const prior = mode === 'armed' ? await q.get(`ufc_model_bout_evaluations?select=pick_probability,evaluated_at&bout_id=eq.${b.id}&decision=eq.ELIGIBLE&model_version=eq.${model.model_version}&order=evaluated_at.desc&limit=6`) : [];
        const drift = prior.length >= 2 && pickProbability != null
          ? round(Math.max(...prior.map((x) => Math.abs(Number(x.pick_probability) - pickProbability))) * 100, 2) : null;

        const decision = evaluateBout({
          event, nowIso, row, corners, pickProbability,
          modelLive: model.live || mode === 'dry_run',
          bout: { status: b.status, has_result: card.results.has(b.id), fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id, active_card_change: card.changed.has(b.id) },
          marketStatus: market?.status ?? 'UNAVAILABLE',
          marketDisagreementPts: market?.status === 'FRESH' ? Math.abs(market.pbe_delta_pts) : null, regenerationDriftPts: drift,
        });
        if (!model.live && mode === 'dry_run') decision.model_note = 'scored with the unregistered release artifact; not callable until registered';
        const eligible = decision.decision === 'ELIGIBLE';
        const boutState = { status: b.status, has_result: card.results.has(b.id), fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id, active_card_change: card.changed.has(b.id) };
        let shadow = null;
        if (challenger) {
          try {
            shadow = shadowCall({
              challenger, row, bout: b, event, corners, nowIso, boutState,
              marketSnapshots: card.snapshots.filter((o) => o.bout_id === b.id), marketObservations: card.market.filter((o) => o.bout_id === b.id),
            });
          } catch (e) { shadowError(`shadow score ${b.id}`, e); }
        }

        const boutReport = {
          bout_id: b.id, order: b.bout_order, fighter_a: corners[0].name, fighter_b: corners[1].name,
          decision: decision.decision, reasons: decision.reasons, confidence: decision.confidence, elite_candidate: decision.elite_candidate,
          pick_fighter_id: eligible ? pickFighter : null, pick: eligible ? card.fighters.get(pickFighter)?.name : null,
          pick_probability: eligible ? round(pickProbability, 4) : null, band: eligible ? band(pickProbability) : null,
          features_available: row ? row.available_count : null, sample: row ? { min_prior_bouts: row.min_prior_bouts, min_stat_bouts: row.min_stat_bouts } : null,
          market: eligible ? market : null, regeneration_drift_pts: drift, identity: corners,
          shadow: shadow ? { decision: shadow.decision, reasons: shadow.reasons, pick_fighter_id: shadow.pick_fighter_id, pick_probability: shadow.raw_pick_probability, same_pick_as_champion: shadow.raw_pick_fighter_id === pickFighter } : null,
        };
        // Admin report only: exactly what a draft would store, so a dry run can be audited feature by feature.
        if (eligible) {
          boutReport.prob_a = round(probA, 8);
          boutReport.feature_vector = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, row.x[i]]));
          boutReport.feature_availability = Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, Boolean(row.available[i])]));
        }

        if (mode === 'armed') {
          await q.post('ufc_model_bout_evaluations', {
            run_id: run.id, event_id: event.id, bout_id: b.id, fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id,
            model_version: model.model_version, feature_version: FEATURE_VERSION, eligibility_version: ELIGIBILITY_VERSION,
            decision: decision.decision, reasons: decision.reasons, confidence: decision.confidence, elite_candidate: decision.elite_candidate,
            pick_fighter_id: eligible ? pickFighter : null, pick_probability: eligible ? round(pickProbability, 8) : null,
            features_available: row ? row.available_count : null, sample: boutReport.sample || {}, identity: { corners }, market: eligible ? market : null,
          }, 'return=minimal');
          report.writes.evaluations += 1;

          const pred = predByBout.get(b.id) || null;
          const lockedAny = lockedByBout.get(b.id) || null;
          if (lockedAny) {
            /* A locked call never moves to another model version. */
            boutReport.locked_at = lockedAny.locked_at;
            boutReport.locked_model_version = lockedAny.model_version;
          } else if (eligible) {
            const draft = {
              bout_id: b.id, event_id: event.id, fighter_a_id: b.fighter_a_id, fighter_b_id: b.fighter_b_id,
              model_version: model.model_version, feature_version: FEATURE_VERSION,
              prob_a: round(probA, 8), prob_b: round(1 - probA, 8), pick_fighter_id: pickFighter, pick_probability: round(pickProbability, 8),
              confidence_band: band(pickProbability),
              feature_vector: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, row.x[i]])),
              feature_availability: Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, Boolean(row.available[i])])),
              sample_context: { ...boutReport.sample, features_available: row.available_count, features_total: FEATURE_KEYS.length, eligibility_version: ELIGIBILITY_VERSION, confidence: decision.confidence, identity: corners, market },
              /* Official comparison columns: FRESH market only (<= 60 min at this pass). */
              ...officialMarketColumns(market),
              // The cycle's start, a second early: the schema refuses a generated_at ahead of the database clock.
              generated_at: new Date(now - 1000).toISOString(),
            };
            let draftId = pred?.id || null;
            if (pred) {
              await q.patch(`ufc_model_predictions?id=eq.${pred.id}&locked_at=is.null`, draft, 'return=minimal');
              report.writes.drafts_regenerated += 1;
            } else {
              const [ins] = await q.post('ufc_model_predictions?on_conflict=bout_id,model_version,feature_version', draft, 'resolution=ignore-duplicates,return=representation');
              draftId = ins?.id || null;
              report.writes.drafts_inserted += 1;
            }
            // Final pass is THIS evaluation: a lock only follows a same-run eligible regeneration.
            if (win.open && draftId) {
              const locked = await q.rpc('ufc_model_publish_prediction', { p_prediction_id: draftId, p_min_lead: `${RULES.lockMinLeadHours} hours` });
              boutReport.locked_at = Array.isArray(locked) ? locked[0]?.locked_at : locked?.locked_at;
              report.writes.locked += 1;
            }
          } else if (pred && !pred.locked_at) {
            await q.del(`ufc_model_predictions?id=eq.${pred.id}&locked_at=is.null`);
            report.writes.drafts_withdrawn += 1;
          }

          /* Shadow after the official work for this bout, and never allowed to throw into it. */
          if (challenger && shadow && shadowByBout) {
            try {
              const w = await writeShadow(q, {
                challenger, championVersion: model.model_version, eligibilityVersion: ELIGIBILITY_VERSION, event, bout: b, call: shadow,
                existing: shadowByBout.get(b.id) || null, lockOpen: win.open, minLeadHours: RULES.lockMinLeadHours, generatedAt: new Date(now - 1000).toISOString(),
              });
              for (const k of ['inserted', 'updated', 'locked', 'skipped_locked']) report.writes.shadow[k] += w[k];
            } catch (e) { shadowError(`shadow write ${b.id}`, e); }
          }
        }
        cardReport.bouts.push(boutReport);
      }
      report.cards.push(cardReport);
    }

    if (mode === 'armed') {
      report.writes.graded = await gradeLocked(q);
      try { report.writes.shadow.graded = await gradeShadow(q, gradeFor); } catch (e) { shadowError('shadow grading', e); }
    }

    await q.patch(`ufc_model_runs?id=eq.${run.id}`, {
      status: 'ok', finished_at: new Date().toISOString(), model_version: report.model.model_version ?? MODEL_VERSION,
      counts: { ...report.writes, cards: report.cards.length, bouts: report.cards.reduce((a, c) => a + c.bouts.length, 0), eligible: report.cards.reduce((a, c) => a + c.bouts.filter((x) => x.decision === 'ELIGIBLE').length, 0), model_source: report.model.source },
    }, 'return=minimal');
    return report;
  } catch (error) {
    const msg = String(error?.message || error).slice(0, 500);
    await q.patch(`ufc_model_runs?id=eq.${run.id}`, { status: 'failed', finished_at: new Date().toISOString(), error: msg, counts: report.writes }, 'return=minimal').catch(() => {});
    report.error = msg;
    return report;
  }
}

/** Grade every locked prediction whose current grade is missing or disagrees with the stored result. */
export function gradeFor(pred, result, bout) {
  if (result) {
    if (result.method === 'NC') return { result: 'NC', winner_id: null };
    if (result.method === 'DRAW') return { result: 'DRAW', winner_id: null };
    if (!result.winner_id) return null;
    if (result.winner_id === pred.pick_fighter_id) return { result: 'WIN', winner_id: result.winner_id };
    const other = pred.pick_fighter_id === pred.fighter_a_id ? pred.fighter_b_id : pred.fighter_a_id;
    if (result.winner_id === other) return { result: 'LOSS', winner_id: result.winner_id };
    return null; // winner is neither corner: identity problem, never guessed
  }
  if (bout && (['cancelled', 'replaced'].includes(bout.status) || bout.event_complete)) return { result: 'VOID', winner_id: null };
  return null;
}

async function gradeLocked(q) {
  const locked = await q.get('ufc_model_predictions?select=id,bout_id,pick_fighter_id,fighter_a_id,fighter_b_id&locked_at=not.is.null&limit=1000');
  if (!locked.length) return 0;
  const current = new Map((await q.inChunks('ufc_model_prediction_current_grade', 'prediction_id', locked.map((p) => p.id), 'prediction_id,result,winner_id')).map((g) => [g.prediction_id, g]));
  const results = new Map((await q.inChunks('ufc_bout_results', 'bout_id', locked.map((p) => p.bout_id), 'bout_id,winner_id,method,source_url,captured_at')).map((r) => [r.bout_id, r]));
  const bouts = new Map((await q.inChunks('ufc_bouts', 'id', locked.map((p) => p.bout_id), 'id,status,ufc_events(card_status)')).map((b) => [b.id, { status: b.status, event_complete: b.ufc_events?.card_status === 'complete' }]));
  let n = 0;
  for (const p of locked) {
    const g = gradeFor(p, results.get(p.bout_id) || null, bouts.get(p.bout_id));
    if (!g) continue;
    const cur = current.get(p.id);
    if (cur && cur.result === g.result && (cur.winner_id || null) === (g.winner_id || null)) continue;
    const r = results.get(p.bout_id);
    await q.post('ufc_model_prediction_grades', {
      prediction_id: p.id, result: g.result, winner_id: g.winner_id, method: r?.method ?? null,
      source: r ? 'ufc_bout_results' : 'ufc_bouts.status/ufc_events.card_status', source_ref: r?.source_url ?? null, source_captured_at: r?.captured_at ?? null,
      graded_by: 'ufc-algo', revision_reason: cur ? `stored result changed from ${cur.result} to ${g.result}` : null,
    }, 'return=minimal');
    n += 1;
  }
  return n;
}
