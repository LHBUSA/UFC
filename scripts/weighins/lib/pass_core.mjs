/* The weigh-in pass, host-agnostic.
 *
 * Runs unchanged under the Node CLI (scripts/weighins/weighin_pass.mjs) and the
 * Cloudflare Worker (workers/ufc-weigh-ins). Everything host-specific is
 * injected: the PostgREST client (`sb`), the network fetch (`fetchImpl`) and a
 * logger. No node: imports anywhere in this module's graph — the Worker path
 * must not depend on Node APIs (asserted in pass.test.mjs).
 *
 * WHAT IT MUST NEVER DO: call a model, write an article, trigger Fight DNA.
 * The structured line "Fighter — 145.5 lb — made weight" is built from stored
 * fields in weights.mjs and is reproducible six months later.
 */
import { resolveLimit, evaluateWeight, fingerprintOf, projectCurrent, SOURCE_RANK } from './weights.mjs';
import { planWindow } from './window.mjs';
import { parseWeighInSources } from './sources.mjs';
import { discoverWeighInSources } from './discover.mjs';
import { sha256 } from './sha256.mjs';

/** Not 'newsroom'. A live desk cannot queue behind a batch writer. */
export const LOCK_ID = 'weigh-ins';
export const WORKER = 'ufc-weigh-ins';

export function resolveOptions(options = {}) {
  return {
    write: Boolean(options.write),
    /* Ignore the cadence gate — an operator's manual run, never a scheduler. */
    force: Boolean(options.force),
    eventId: options.eventId || null,
    now: options.now ?? Date.now(),
    fetchImpl: options.fetchImpl || null,
    /* Record the pass in ufc_ingest_runs (the cadence gate reads it). */
    ledger: Boolean(options.ledger),
    trigger: options.trigger || 'manual',
  };
}

const zero = () => ({
  sources_fetched: 0, sources_failed: 0, readings: 0, made: 0, missed: 0, pending: 0,
  limit_unsupported: 0, offered: 0, inserted: 0, duplicate_noop: 0, corrections: 0, confirmations: 0,
  lower_authority_archived: 0, status_events: 0, rejected: 0,
});

/**
 * One pass. The window decision comes FIRST and before any source fetch: out
 * of window it costs one indexed query for the next event and stops.
 */
export async function runWeighInPass({ sb, log = console }, options = {}) {
  const opts = resolveOptions(options);
  const started = Date.now();

  const EVENT_COLS = 'id,name,event_date,venue,city,region,country,card_status';
  const event = opts.eventId
    ? (await sb.select('ufc_events', `select=${EVENT_COLS}&id=eq.${opts.eventId}&limit=1`))[0] || null
    : (await sb.select('ufc_events', `select=${EVENT_COLS}&event_date=gte.${new Date(opts.now - 36 * 3600e3).toISOString().slice(0, 10)}&order=event_date.asc&limit=1`))[0] || null;

  const lastRun = opts.force ? null
    : (await sb.select('ufc_ingest_runs', `select=started_at&worker=eq.${WORKER}&order=started_at.desc&limit=1`).catch(() => []))[0]?.started_at || null;

  const plan = planWindow({ nextEvent: event, now: opts.now, lastRunAt: lastRun });

  if (plan.skip && !opts.force) {
    return { status: 'skipped', plan, event, fetched: 0, readings: [], counters: zero(), duration_ms: Date.now() - started };
  }

  const runId = opts.ledger ? await openRun(sb, opts, plan, event) : null;

  if (plan.mode === 'idle' && !opts.force) {
    log.log?.(`[weigh-ins] idle: ${plan.reason} — no source fetched`);
    const result = { status: 'idle', plan, event, fetched: 0, readings: [], counters: zero(), duration_ms: Date.now() - started };
    await closeRun(sb, runId, opts, result);
    return result;
  }

  try {
    const bouts = (await sb.select('ufc_bouts',
      `select=id,event_id,fighter_a_id,fighter_b_id,weight_class,weight_class_raw,is_womens,is_title,card_position,bout_order,status&event_id=eq.${event.id}`))
      .filter((b) => b.status !== 'cancelled');
    const fighterIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]).filter(Boolean))];
    const fighters = fighterIds.length ? await sb.select('ufc_fighters', `select=id,name&id=in.(${fighterIds.join(',')})`) : [];

    const discovered = await discoverWeighInSources(sb, { event, bouts, fighters });
    const parsed = await parseWeighInSources({ event, bouts, fighters, now: opts.now, fetchImpl: opts.fetchImpl, discovered });

    const counters = zero();
    counters.sources_fetched = parsed.sources_fetched;
    counters.sources_failed = parsed.sources_failed;
    const readings = parsed.readings.map((r) => buildRow(r, { event, bouts, now: opts.now }));

    counters.readings = readings.length;
    counters.made = readings.filter((r) => r.result === 'made').length;
    counters.missed = readings.filter((r) => r.result === 'missed').length;
    counters.pending = readings.filter((r) => r.result === 'pending').length;
    counters.limit_unsupported = readings.filter((r) => r.limit_basis === 'unsupported').length;

    const expected = fighterIds.length;
    const coverage = { expected, sourced_fighters: new Set(readings.map((r) => r.fighter_id)).size };
    const sources = {
      official: discovered.official.map((o) => o.url),
      wire: discovered.wire.map((w) => w.url),
      considered: discovered.considered,
      trail: parsed.trail,
    };

    if (!opts.write) {
      const result = { status: 'dry_run', plan, event, coverage, sources, readings, counters, duration_ms: Date.now() - started };
      await closeRun(sb, runId, opts, result);
      return result;
    }

    const write = await storeReadings(sb, readings, { now: opts.now, log });
    Object.assign(counters, write.counters);
    log.log?.(`[weigh-ins] ${plan.mode}: ${event.name} offered=${counters.offered} inserted=${counters.inserted} duplicate_noop=${counters.duplicate_noop} corrections=${counters.corrections} confirmations=${counters.confirmations} status_events=${counters.status_events}`);
    const result = { status: counters.rejected ? 'partial' : 'ok', plan, event, coverage, sources, readings: readings.length, counters, duration_ms: Date.now() - started };
    await closeRun(sb, runId, opts, result);
    return result;
  } catch (e) {
    await closeRun(sb, runId, opts, { status: 'failed', error: String(e?.message || e).slice(0, 300), plan, event });
    throw e;
  }
}

function buildRow(r, { event, bouts, now }) {
  const bout = bouts.find((b) => b.id === r.bout_id) || null;
  const limit = resolveLimit({
    weightClass: bout?.weight_class,
    isTitle: typeof bout?.is_title === 'boolean' ? bout.is_title : undefined,
    sourcedLimitLbs: r.sourced_limit_lbs ?? null,
  });
  const verdict = evaluateWeight({
    officialWeightLbs: r.official_weight_lbs,
    applicableLimitLbs: limit.applicable_limit_lbs,
    reportedMiss: Boolean(r.reported_miss),
  });
  /* The schema forbids result='missed' with no weight: an unmeasured miss is
   * carried as a status event alone; the invented measurement never exists. */
  const measured = r.official_weight_lbs != null;
  const result = verdict.result === 'missed_unmeasured' ? 'pending'
    : verdict.result === 'unjudged' ? (measured ? 'made' : 'pending')
      : verdict.result;
  const iso = new Date(now).toISOString();
  const row = {
    event_id: event.id,
    bout_id: r.bout_id ?? null,
    fighter_id: r.fighter_id,
    contracted_limit_lbs: limit.contracted_limit_lbs,
    allowance_lbs: limit.allowance_lbs,
    limit_basis: limit.limit_basis,
    official_weight_lbs: measured ? r.official_weight_lbs : null,
    attempt_number: r.attempt_number ?? 1,
    result: r.result_override || result,
    over_by_lbs: verdict.over_by_lbs,
    catchweight_lbs: r.catchweight_lbs ?? null,
    weighed_at: r.weighed_at ?? null,
    source_url: r.source_url,
    source_name: r.source_name,
    source_kind: r.source_kind,
    source_published_at: r.source_published_at ?? null,
    detected_at: iso,
    first_seen_at: iso,
    last_seen_at: iso,
    raw_text: r.raw_text ?? null,
    provenance: {
      adapter: r.adapter,
      matched: r.matched ?? null,
      limit_reason: limit.reason,
      verdict: verdict.result,
      unmeasured_miss: verdict.result === 'missed_unmeasured',
      bout_resolved: Boolean(bout),
      news_item_id: r.news_item_id ?? null,
    },
    _fighter_name: r.fighter_name,
    _unmeasured_miss: verdict.result === 'missed_unmeasured',
  };
  row.fingerprint = fingerprintOf(row, sha256);
  return row;
}

const rankOf = (r) => SOURCE_RANK[r?.source_kind] ?? 0;
const sameWeight = (a, b) => (a.official_weight_lbs == null ? null : Number(a.official_weight_lbs)) === (b.official_weight_lbs == null ? null : Number(b.official_weight_lbs));

/**
 * Store readings, count what actually landed, and mirror misses into status.
 *
 * Authority ordering (the correction chain):
 *   - readings are applied in ASCENDING source authority, so when the wire and
 *     UFC.com both arrive in one pass the wire lands first and the official
 *     reading supersedes it — exactly as it would across two passes;
 *   - a higher-authority reading for a fighter supersedes the current lower-
 *     authority one at the same attempt, even at the same weight (recorded as
 *     a confirmation, with the reason) — history keeps both;
 *   - a same-authority reading with a different weight is a correction;
 *   - a LOWER-authority reading arriving after a higher one is kept for the
 *     record but stored already superseded, so it can never displace the
 *     official number in ufc_weigh_in_current (which orders by detected_at).
 *
 * Counters measure the DATABASE: under ignore-duplicates a repeat inserts
 * nothing, and return=representation is what tells a new row from a replay.
 */
export async function storeReadings(sb, readings, { now = Date.now(), log = console } = {}) {
  const counters = { offered: readings.length, inserted: 0, duplicate_noop: 0, corrections: 0, confirmations: 0, lower_authority_archived: 0, status_events: 0, rejected: 0 };
  if (!readings.length) return { counters, inserted: [] };
  const iso = new Date(now).toISOString();

  const eventId = readings[0].event_id;
  const existing = await sb.select('ufc_weigh_in_results',
    `select=id,fighter_id,attempt_number,official_weight_lbs,result,source_kind,source_name,source_published_at,detected_at,fingerprint,superseded_at&event_id=eq.${eventId}`).catch(() => []);
  const knownFingerprints = new Set(existing.map((e) => e.fingerprint));
  const live = existing.filter((e) => !e.superseded_at);
  const currentByFighter = new Map(projectCurrent(live.map((e) => ({ ...e, event_id: eventId }))).map((e) => [e.fighter_id, e]));

  const fresh = [];
  for (const r of readings) {
    if (knownFingerprints.has(r.fingerprint)) { counters.duplicate_noop += 1; continue; }
    knownFingerprints.add(r.fingerprint);
    fresh.push(r);
  }
  fresh.sort((a, b) => rankOf(a) - rankOf(b));

  const columns = (r) => { const out = { ...r }; delete out._fighter_name; delete out._unmeasured_miss; return out; };
  const allInserted = [];

  /* One group per authority level, lowest first, so a later group can chain
   * onto rows the earlier group just inserted. */
  const ranks = [...new Set(fresh.map(rankOf))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const group = fresh.filter((r) => rankOf(r) === rank);
    const supersedes = [];
    for (const r of group) {
      const prior = currentByFighter.get(r.fighter_id);
      if (!prior || prior.attempt_number !== r.attempt_number) continue;
      const pr = rankOf(prior);
      if (rank > pr) {
        r.supersedes_id = prior.id;
        if (sameWeight(prior, r)) {
          r.correction_reason = `${r.source_name} (${r.source_kind}) confirmed the ${prior.source_name || prior.source_kind} reading and supersedes it`;
          counters.confirmations += 1;
        } else {
          r.correction_reason = `${r.source_name} (${r.source_kind}) corrected ${prior.official_weight_lbs ?? 'no weight'} → ${r.official_weight_lbs ?? 'no weight'} from ${prior.source_name || prior.source_kind}`;
          counters.corrections += 1;
        }
        supersedes.push(prior.id);
      } else if (rank === pr) {
        if (!sameWeight(prior, r)) {
          r.supersedes_id = prior.id;
          r.correction_reason = `superseded by ${r.source_kind} reading at ${iso}`;
          supersedes.push(prior.id);
          counters.corrections += 1;
        }
      } else {
        /* Lower authority than what the desk already shows: keep it, never let
         * it become current. */
        r.superseded_at = iso;
        r.correction_reason = `lower authority than the current ${prior.source_kind} reading (${prior.source_name || prior.source_kind})`;
        counters.lower_authority_archived += 1;
      }
    }

    try {
      const back = await sb.insert('ufc_weigh_in_results', group.map(columns), { onConflict: 'fingerprint', ignoreDuplicates: true, returning: true });
      const inserted = Array.isArray(back) ? back : [];
      counters.inserted += inserted.length;
      counters.duplicate_noop += group.length - inserted.length;
      for (const id of supersedes) await sb.patch('ufc_weigh_in_results', `id=eq.${id}`, { superseded_at: iso });
      for (const row of inserted) {
        if (row.superseded_at) continue;
        currentByFighter.set(row.fighter_id, row);
      }
      allInserted.push(...inserted);
    } catch (e) {
      counters.rejected += group.length;
      log.error?.(`[weigh-ins] insert failed: ${String(e?.message || e).slice(0, 200)}`);
    }
  }

  /* Mirror only readings that are current: a lower-authority row stored
   * already-superseded must not mint a status claim. */
  const mirrorable = allInserted.filter((r) => !r.superseded_at);
  try {
    counters.status_events = await mirrorMisses(sb, mirrorable, readings, { now });
  } catch (e) {
    log.error?.(`[weigh-ins] status mirror failed: ${String(e?.message || e).slice(0, 200)}`);
  }
  return { counters, inserted: allInserted };
}

/**
 * Mirror a miss into ufc_fighter_status_events, exactly once (partial unique
 * index on weigh_in_result_id). NO MEDICAL INFERENCE: no injury_type,
 * body_part or clinical_quote is ever written.
 */
export async function mirrorMisses(sb, insertedRows, readings, { now = Date.now() } = {}) {
  const byFingerprint = new Map(readings.map((r) => [r.fingerprint, r]));
  const events = [];
  for (const row of insertedRows) {
    const source = byFingerprint.get(row.fingerprint);
    const isMiss = row.result === 'missed' || source?._unmeasured_miss;
    if (!isMiss) continue;
    events.push({
      fighter_id: row.fighter_id,
      status_type: 'weight_miss',
      state: 'active',
      event_id: row.event_id,
      bout_id: row.bout_id,
      status_detail: row.over_by_lbs != null
        ? `Missed weight by ${row.over_by_lbs} lb (${row.official_weight_lbs} lb against ${Number(row.contracted_limit_lbs) + Number(row.allowance_lbs || 0)} lb)`
        : row.official_weight_lbs != null
          ? `Weighed ${row.official_weight_lbs} lb; contracted limit not published`
          : 'Reported to have missed weight; no figure published',
      source_url: row.source_url,
      source_name: row.source_name,
      source_kind: row.source_kind,
      source_published_at: row.source_published_at,
      detected_at: new Date(now).toISOString(),
      effective_at: row.weighed_at,
      confidence: row.source_kind === 'official' ? 0.95 : row.source_kind === 'commission' ? 0.92 : 0.8,
      weigh_in_result_id: row.id,
      provenance: { origin: 'weigh_in_pass', weigh_in_result_id: row.id, limit_basis: row.limit_basis, over_by_lbs: row.over_by_lbs },
      fingerprint: sha256(['weigh-in-miss', row.fighter_id, row.event_id, row.id].join('|')),
    });
  }
  if (!events.length) return 0;
  const back = await sb.insert('ufc_fighter_status_events', events, { onConflict: 'fingerprint', ignoreDuplicates: true, returning: true });
  return Array.isArray(back) ? back.length : 0;
}

/* ------------------------------------------------------------ run ledger */

async function openRun(sb, opts, plan, event) {
  try {
    const back = await sb.insert('ufc_ingest_runs', [{ worker: WORKER, status: 'running', notes: { trigger: opts.trigger, mode: plan.mode, reason: plan.reason, event_id: event?.id ?? null, write: opts.write, force: opts.force } }], { returning: true });
    return Array.isArray(back) && back[0] ? back[0].id : null;
  } catch {
    return null;
  }
}

async function closeRun(sb, runId, opts, result) {
  if (!runId) return;
  const status = result.status === 'failed' ? 'failed' : result.status === 'partial' ? 'partial' : 'success';
  try {
    await sb.patch('ufc_ingest_runs', `id=eq.${runId}`, {
      finished_at: new Date().toISOString(),
      status,
      notes: {
        trigger: opts.trigger, write: opts.write, force: opts.force,
        outcome: result.status, mode: result.plan?.mode, reason: result.plan?.reason, event: result.event?.name ?? null,
        counters: result.counters ?? null, coverage: result.coverage ?? null,
        sources: result.sources ? { official: result.sources.official, wire: result.sources.wire, trail: result.sources.trail } : null,
        error: result.error ?? null,
      },
    });
  } catch { /* the pass result stands even if the ledger write fails */ }
}
