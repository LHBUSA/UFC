/* ufc-stats-ingest — schedule, results and the round-stat lane.
 *
 * Sources (decision 2026-09-05):
 *   ESPN core API  -> events, bouts, results, fighter identity + physicals.
 *   ufcstats.com   -> per-round stats only (fight pages). Fails closed on its
 *                     JS challenge unless UFCSTATS_SOLVE_CHALLENGE="true".
 *
 * Run shape:
 *   1. ESPN: events for this year (and last year in January). Upsert every
 *      event; upsert bouts + results for events that are new, not yet
 *      complete, or dated within the last 14 days. Cap: MAX_EVENTS_PER_RUN
 *      completed events get their full bout/result pass per run.
 *   2. Fighters: every ESPN athlete on those bouts is resolved against
 *      ufc_fighters with the alias resolver (name + DOB/record). Matched ->
 *      espn_athlete_id set. Unmatched -> new espn-first row. Ambiguous ->
 *      new espn-first row AND one ufc_alias_review_queue entry (never merge on
 *      name alone; a duplicate row is recoverable, a wrong merge is not).
 *   3. Round-stat lane (queue: ufc_round_stat_queue, decisions in lane.mjs):
 *      every bout our own record says is final (stored result) inside
 *      UFCSTATS_FORWARD_DAYS with no round rows is ENQUEUED, Contender Series
 *      included. Identity: stored bout id -> the event's UFC Stats page ->
 *      either fighter's UFC Stats history -> the completed-events list only as
 *      a cross-check. Fetching happens only when source access is allowed;
 *      otherwise items wait in awaiting_source with the reason. Identities and
 *      the result are validated before an idempotent upsert. A page with no
 *      stats tables is recorded, never written as zeros.
 *   4. New round rows -> one Fight DNA rebuild requested from ufc-intelligence
 *      (the DNA owner) over the INTELLIGENCE service binding.
 *   5. card_status='complete' once every bout on the event has a result.
 *   6. One ufc_ingest_runs row per run with source telemetry and latency
 *      windows; Discord one-liner on success, loud on SchemaAssertionError /
 *      AccessGateError (which abort the run).
 *
 * Source health: any UFC Stats challenge fails the pass closed (the lane does
 * not answer challenges unless UFCSTATS_SOLVE_CHALLENGE="true"). It is stored
 * in R2 as challenged/source/at/retry_after and keeps the lane off UFC Stats
 * for SOURCE_BACKOFF_HOURS; queued bouts wait in awaiting_source. ESPN keeps
 * running. Degrade, never guess, never hammer.
 *
 * Latency: recorded as a window (last look that found nothing, first look that
 * found rows) against the first run that saw ESPN report the bout final. At a
 * 15-minute cadence that window is up to 15 minutes wide, and nothing about
 * the lane claims more precision than it measured.
 *
 * Announced bouts that vanish from ESPN's card are recorded in
 * assertion_failures as AnnouncedBoutVanished.
 */

import { selectAll, select, insert, insertIgnore, upsert, patch, patchCount, count } from './supabase.mjs';
import { discord } from './discord.mjs';
import { Fetcher, SchemaAssertionError, AccessGateError } from './ufcstats.mjs';
import { Espn } from './espn.mjs';
import * as P from './parsers.mjs';
import { normWeightClass, normMethod, normStance, scheduledRounds, mmssToSec } from './normalizers.mjs';
import { AliasResolver, aliasRowsForFighter, normalize } from './shared/alias_resolver.mjs';
import { selectCandidates, validateFight, roundRowsFor, latencySummary, sourceBlocked, matchHistoryRow, nextAttempt, isContenderSeries } from './lane.mjs';

const SERVICE = 'ufc-stats-ingest';
const VERSION = 'v0.4.0';

const health = { last_cron_run: null, last_result: null, last_error_class: null };
const nowIso = () => new Date().toISOString();

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}

/* Fails CLOSED: no token configured, or mismatch -> 404. Same path as the cron. */
function adminAuthorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

/* R2-held state. Small JSON documents next to the raw page archive. */
const STATE = {
  health: 'ufc-raw/_state/source_health.json',
  latency: (boutId) => `ufc-raw/_state/latency/${boutId}.json`,
};
async function getState(env, key) {
  if (!env.RAW) return null;
  try { const o = await env.RAW.get(key); return o ? await o.json() : null; } catch (_) { return null; }
}
async function putState(env, key, value) {
  if (!env.RAW) return;
  try { await env.RAW.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }); } catch (e) {
    console.error(`[${SERVICE}] state write failed ${key}: ${String(e?.message || e).slice(0, 100)}`);
  }
}
/* The one shape a challenge is remembered in: what, where, when, and when the
 * lane may look again. Health, the canary and the run row all report this. */
function challengedState(env, { detail, url, telemetry, via }) {
  const at = nowIso();
  const backoffHours = Number(env.SOURCE_BACKOFF_HOURS || 6);
  return {
    status: 'challenged', challenged: true, source: 'ufcstats.com', at, detail, url, via,
    backoff_hours: backoffHours, retry_after: new Date(Date.parse(at) + backoffHours * 3600000).toISOString(),
    telemetry,
  };
}

async function mergeState(env, key, patchObj, { onlyIfAbsent = [] } = {}) {
  const cur = (await getState(env, key)) || {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(patchObj)) {
    if (onlyIfAbsent.includes(k) && cur[k] != null) continue;
    next[k] = v;
  }
  await putState(env, key, next);
  return next;
}

/* Exposed for the offline lane tests only. */
export const __test = { runIngest };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      let lastSuccess = null; let lastRoundWrite = null; let lastResultWrite = null; let lastWorkerRoundWrite = null; let queue = null;
      try {
        lastSuccess = (await select(env, 'ufc_ingest_runs', `select=started_at,finished_at,status,notes&worker=eq.${SERVICE}&status=eq.success&order=started_at.desc&limit=1`))?.[0] || null;
        lastRoundWrite = (await select(env, 'ufc_bout_round_stats', 'select=captured_at,source_url&order=captured_at.desc&limit=1'))?.[0] || null;
        lastResultWrite = (await select(env, 'ufc_bout_results', 'select=captured_at,result_source&order=captured_at.desc&limit=1'))?.[0] || null;
        /* Round rows carry no writer column, so "did THIS Worker ever write
         * one" is answered from its own run ledger, not from the table. */
        const runs = await select(env, 'ufc_ingest_runs', `select=id,started_at,round_rows:notes->round_rows_written&worker=eq.${SERVICE}&order=started_at.desc&limit=500`);
        lastWorkerRoundWrite = (runs || []).find((r) => Number(r.round_rows) > 0) || null;
        const qrows = await selectAll(env, 'ufc_round_stat_queue', 'select=state');
        queue = qrows.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] || 0) + 1 }), {});
      } catch (_) { /* reported as null */ }
      return json({
        service: SERVICE, version: VERSION, ...health,
        ufcstats_enabled: String(env.UFCSTATS_ENABLED ?? 'true') !== 'false',
        forward_days: Number(env.UFCSTATS_FORWARD_DAYS || 45),
        source_health: await getState(env, STATE.health),
        last_success: lastSuccess ? { started_at: lastSuccess.started_at, finished_at: lastSuccess.finished_at, round_rows: lastSuccess.notes?.round_rows ?? null, ufcstats_pass: lastSuccess.notes?.ufcstats_pass ?? null } : null,
        last_round_write: lastRoundWrite,
        last_worker_round_write: lastWorkerRoundWrite,
        last_result_write: lastResultWrite,
        round_stat_queue: queue,
        challenge_policy: String(env.UFCSTATS_SOLVE_CHALLENGE || 'false') === 'true' ? 'solve_known_shape' : 'fail_closed',
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
          DISCORD_WEBHOOK_URL: Boolean(env.DISCORD_WEBHOOK_URL),
          RAW_BUCKET: Boolean(env.RAW),
          INTELLIGENCE_BINDING: Boolean(env.INTELLIGENCE),
        },
      });
    }
    if (req.method !== 'POST' || !['/admin/run', '/admin/canary'].includes(url.pathname)) {
      return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
    }
    if (!adminAuthorized(req, env)) return json({ error: 'not_found' }, 404);
    if (url.pathname === '/admin/canary') {
      return json({ service: SERVICE, version: VERSION, invoked: 'manual', canary: await runCanary(env, { n: Number(url.searchParams.get('n') || 3) }) });
    }
    const result = await runIngest(env, {
      invoked: 'manual',
      skipEspn: url.searchParams.get('espn') === 'false',
      onlyBout: url.searchParams.get('bout') || null,
      force: url.searchParams.get('force') === 'true',
    });
    return json({ service: SERVICE, version: VERSION, invoked: 'manual', result });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIngest(env, { invoked: 'cron', cron: event.cron }));
  },
};

/* ------------------------------------------------------------------------ */
/* Run driver                                                                */
/* ------------------------------------------------------------------------ */
async function runIngest(env, { invoked = 'cron', cron = null, skipEspn = false, onlyBout = null, force = false } = {}) {
  health.last_cron_run = nowIso();
  console.log(`[${SERVICE}] START ${health.last_cron_run} invoked=${invoked}`);
  const run = { events_new: 0, bouts_new: 0, fighters_touched: 0, assertion_failures: [], notes: { invoked, cron, version: VERSION } };
  let runId = null;
  let status = 'success';
  /* Challenges are answered only when UFCSTATS_SOLVE_CHALLENGE="true". The
   * default is to fail closed: a challenge is recorded, the lane backs off,
   * ESPN continues, and nothing is presented as live. Solving the known
   * proof-of-work shape (decision 2026-09-05) is an explicit operator choice,
   * not something the lane does on its own. */
  const fetcher = new Fetcher(env, { solveGate: String(env.UFCSTATS_SOLVE_CHALLENGE || 'false') === 'true' });
  const espn = new Espn();
  try {
    const created = await insert(env, 'ufc_ingest_runs', { worker: SERVICE, status: 'running', notes: { invoked, cron, version: VERSION } });
    runId = created?.[0]?.id || null;

    const ctx = await loadContext(env);
    if (!skipEspn) await espnPass(env, espn, ctx, run);
    else run.notes.espn_pass = 'skipped (manual espn=false)';
    /* The round-stat pass being off is a silent, months-long outage: ESPN
     * keeps writing events and results, so every dashboard looks healthy
     * while no round data lands at all. The flag state is therefore recorded
     * on every run, enabled or not, and the disabled case is stated in words
     * a human reading the run row will notice. */
    const ufcstatsEnabled = String(env.UFCSTATS_ENABLED ?? 'true') !== 'false';
    run.notes.ufcstats_enabled = ufcstatsEnabled;
    const sourceHealth = await getState(env, STATE.health);
    const backoffHours = Number(env.SOURCE_BACKOFF_HOURS || 6);
    /* The queue is maintained on every run. Source access only decides
     * whether due items may be fetched now or wait, with the reason stored. */
    let sourceReason = null;
    if (!ufcstatsEnabled) {
      sourceReason = 'UFCSTATS_ENABLED=false';
      run.notes.health_warning = 'ROUND STATS NOT FETCHED: UFCSTATS_ENABLED=false. Final bouts are queued (ufc_round_stat_queue, state awaiting_source) and wait for source access.';
    } else if (sourceBlocked(sourceHealth, Date.now(), backoffHours) && !force) {
      sourceReason = `source challenged at ${sourceHealth.at}; backing off ${backoffHours}h`;
      run.notes.health_warning = `UFC STATS CHALLENGED: ${sourceHealth.detail}. Round stats queued, not fetched; ESPN continues.`;
    }
    await roundStatLane(env, fetcher, ctx, run, { sourceAllowed: !sourceReason, sourceReason, onlyBout, force });
    /* "ok" means the source actually answered this run; a run that made no
     * request proves nothing about the source and leaves stored health alone. */
    if (!sourceReason && fetcher.subrequests > 0) await putState(env, STATE.health, { status: 'ok', challenged: false, source: 'ufcstats.com', at: nowIso(), telemetry: fetcher.telemetry(), via: invoked });

    run.notes.espn_subrequests = espn.subrequests;
    run.notes.ufcstats_subrequests = fetcher.subrequests;
    run.notes.ufcstats_fetched = fetcher.fetched;
    run.notes.challenges_solved = fetcher.challengesSolved;
    run.notes.ufcstats_source = fetcher.telemetry();
    run.notes.review_queued = ctx.reviewQueued;
    run.notes.review_deduplicated = ctx.reviewDeduplicated;

    if ((run.notes.round_rows_written || 0) > 0) run.notes.dna_trigger = await triggerFightDna(env, run);
  } catch (e) {
    status = 'failed';
    const cls = e?.name || 'Error';
    health.last_error_class = cls;
    const detail = String(e?.message || e).slice(0, 400);
    run.assertion_failures.push({ class: cls, url: e?.url || null, detail, at: nowIso() });
    run.notes.ufcstats_source = fetcher.telemetry();
    console.error(`[${SERVICE}] ${cls}: ${detail}`);
    if (e instanceof AccessGateError) {
      /* Fail closed and remember it, so the next runs stay away instead of
       * probing a source that has just changed its answer to automation. */
      const state = challengedState(env, { detail, url: e?.url || null, telemetry: fetcher.telemetry(), via: invoked });
      await putState(env, STATE.health, state);
      run.notes.ufcstats_pass = 'aborted (access gate)';
      run.notes.source_health = state;
    }
    const loud = e instanceof SchemaAssertionError || e instanceof AccessGateError;
    await discord(env, `**${SERVICE} ${loud ? 'STOPPED' : 'CRASHED'}** ${cls}\n\`${detail}\`\n${e?.url || ''}`, { loud: true });
  } finally {
    if (runId) {
      try {
        await patch(env, 'ufc_ingest_runs', `id=eq.${runId}`, {
          finished_at: nowIso(), status,
          events_new: run.events_new, bouts_new: run.bouts_new, fighters_touched: run.fighters_touched,
          assertion_failures: run.assertion_failures, notes: run.notes,
        });
      } catch (e2) { console.error(`[${SERVICE}] could not close run row: ${String(e2?.message || e2).slice(0, 120)}`); }
    }
    health.last_result = { status, ...run };
    if (status === 'success') {
      const n = run.notes;
      await discord(env, `${SERVICE} ok: events_new=${run.events_new} bouts_new=${run.bouts_new} fighters=${run.fighters_touched}`
        + ` rounds=${n.round_rows_written || 0}${n.review_queued ? ` review=${n.review_queued}` : ''}`
        + `${run.assertion_failures.length ? ` notes=${run.assertion_failures.length}` : ''}`);
    }
    console.log(`[${SERVICE}] END status=${status} events_new=${run.events_new} bouts_new=${run.bouts_new} round_rows_written=${run.notes.round_rows_written || 0}`);
  }
  return { status, ...run };
}

/* Ask the Fight DNA owner to rebuild. ufc-intelligence gates the build on its
 * own input fingerprint (result + round-stat counts), so this cannot cause a
 * rebuild when nothing moved; it only stops fresh rounds from waiting for the
 * next 07:17 UTC build. Never fatal: DNA lag is a staleness, not a data loss. */
async function triggerFightDna(env, run) {
  if (!env.INTELLIGENCE || typeof env.INTELLIGENCE.refreshFightDna !== 'function') {
    return { status: 'not_bound', note: 'no INTELLIGENCE binding; DNA refreshes on its 07:17 UTC build' };
  }
  try {
    const r = await env.INTELLIGENCE.refreshFightDna({
      reason: 'ufc-stats-ingest round rows', bouts: (run.notes.written_bouts || []).map((b) => b.bout_id),
    });
    return { status: r?.status || 'unknown', snapshots: r?.snapshots ?? null, fingerprint: r?.fingerprint ?? null, as_of: r?.as_of ?? null, error: r?.error ?? null };
  } catch (e) {
    return { status: 'failed', error: String(e?.message || e).slice(0, 200) };
  }
}

/* ------------------------------------------------------------------------ */
/* Context: id maps + resolver over every known fighter                      */
/* ------------------------------------------------------------------------ */
async function loadContext(env) {
  const fighters = await selectAll(env, 'ufc_fighters', 'select=id,ufcstats_id,espn_athlete_id,name,nickname,dob,record_w,record_l,record_d');
  const aliases = await selectAll(env, 'ufc_fighter_aliases', 'select=fighter_id,alias,source');
  const aliasByFighter = new Map();
  for (const a of aliases) {
    if (!aliasByFighter.has(a.fighter_id)) aliasByFighter.set(a.fighter_id, []);
    aliasByFighter.get(a.fighter_id).push(a.alias);
  }
  const boutRows = await selectAll(env, 'ufc_bouts', 'select=id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,status,weight_class,scheduled_rounds');
  const wcByFighter = new Map();
  for (const b of boutRows) {
    for (const f of [b.fighter_a_id, b.fighter_b_id]) {
      if (!wcByFighter.has(f)) wcByFighter.set(f, new Set());
      if (b.weight_class) wcByFighter.get(f).add(b.weight_class);
    }
  }
  const resolver = new AliasResolver(fighters.map((f) => ({
    id: f.id, ufcstats_id: f.ufcstats_id, name: f.name, nickname: f.nickname, dob: f.dob,
    record: f.record_w == null ? null : `${f.record_w}-${f.record_l}-${f.record_d}`,
    weight_classes: [...(wcByFighter.get(f.id) || [])],
    aliases: aliasByFighter.get(f.id) || [],
  })));
  const byEspnAthlete = new Map(fighters.filter((f) => f.espn_athlete_id).map((f) => [f.espn_athlete_id, f]));
  const byUfcstatsFighter = new Map(fighters.filter((f) => f.ufcstats_id).map((f) => [f.ufcstats_id, f]));
  const events = await selectAll(env, 'ufc_events', 'select=id,ufcstats_id,espn_event_id,name,event_date,card_status');
  const results = await selectAll(env, 'ufc_bout_results', 'select=bout_id,has_stats,winner_id,round,referee,finish_detail,time_format,stats_captured_at');
  return {
    resolver, byEspnAthlete, byUfcstatsFighter,
    fightersById: new Map(fighters.map((f) => [f.id, f])),
    events, eventsByEspn: new Map(events.filter((e) => e.espn_event_id).map((e) => [e.espn_event_id, e])),
    bouts: boutRows, boutsByEspn: new Map(boutRows.filter((b) => b.espn_competition_id).map((b) => [b.espn_competition_id, b])),
    resultsByBout: new Map(results.map((r) => [r.bout_id, r])),
    reviewQueued: 0,
    reviewDeduplicated: 0,
  };
}

function registerFighter(ctx, row) {
  ctx.fightersById.set(row.id, row);
  if (row.espn_athlete_id) ctx.byEspnAthlete.set(row.espn_athlete_id, row);
  if (row.ufcstats_id) ctx.byUfcstatsFighter.set(row.ufcstats_id, row);
  ctx.resolver.add({ id: row.id, ufcstats_id: row.ufcstats_id, name: row.name, nickname: row.nickname, dob: row.dob,
    record: row.record_w == null ? null : `${row.record_w}-${row.record_l}-${row.record_d}`, weight_classes: [], aliases: [] });
}

/* One open review item per (name, source). A 15-minute lane that re-queues the
 * same unresolved fighter every run buries the queue in copies of one
 * question, and a human then answers it once and leaves the rest open. */
async function queueReview(env, ctx, res, rawName, source, extra) {
  const row = res.review_row || { raw_name: rawName, source, candidate_fighter_ids: [], context: {} };
  const open = await select(env, 'ufc_alias_review_queue',
    `select=id&raw_name=eq.${encodeURIComponent(row.raw_name || rawName)}&source=eq.${encodeURIComponent(source)}&resolved_at=is.null&limit=1`);
  if (Array.isArray(open) && open.length) { ctx.reviewDeduplicated += 1; return; }
  row.context = { ...row.context, ...extra };
  await insert(env, 'ufc_alias_review_queue', row, { returning: 'minimal' });
  ctx.reviewQueued += 1;
}

/* ------------------------------------------------------------------------ */
/* ESPN pass                                                                 */
/* ------------------------------------------------------------------------ */
async function espnPass(env, espn, ctx, run) {
  const year = new Date().getUTCFullYear();
  /* ESPN_DATES overrides the window: "2025", "20251214", "20251201-20251231".
   * Default: this year, plus last year during January. */
  const dates = env.ESPN_DATES ? String(env.ESPN_DATES).split(',') : (new Date().getUTCMonth() === 0 ? [year - 1, year] : [year]);
  const refs = (await Promise.all(dates.map((d) => espn.eventRefs(String(d).trim())))).flat();
  run.notes.espn_events_listed = refs.length;
  const maxEvents = Number(env.MAX_EVENTS_PER_RUN || 3);
  const cutoff = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10);
  let fullPasses = 0;
  for (const ref of refs) {
    const ev = await espn.event(ref);
    const espnId = String(ev.raw.id);
    const eventDate = String(ev.raw.date).slice(0, 10);
    /* Link to a UFC Stats-keyed row for the same card before creating a new
     * row: same date (+-1 day) AND the same "UFC <n>" number or overlapping
     * headline tokens. Never on date alone (2026-09-06: 45 duplicate cards). */
    const existing = ctx.eventsByEspn.get(espnId) || linkUfcstatsEvent(ctx, ev.raw.name, eventDate);
    const isComplete = ev.raw.status?.type?.completed === true && ev.raw.status?.type?.state === 'post';
    const evRow = {
      espn_event_id: espnId, name: ev.raw.name, event_date: eventDate,
      venue: ev.venue?.name || null, city: ev.venue?.city || null, region: ev.venue?.region || null, country: ev.venue?.country || null,
      card_status: existing?.card_status === 'complete' ? 'complete' : (isComplete ? 'locked' : 'announced'),
      source_url: ev.url, captured_at: nowIso(), updated_at: nowIso(),
    };
    if (existing?.ufcstats_id) evRow.ufcstats_id = existing.ufcstats_id;
    let saved;
    if (existing && !existing.espn_event_id) {
      /* PATCH the UFC Stats row (see ensureEspnFighter for why not upsert). */
      const { source_url: _src, captured_at: _cap, ...fill } = evRow;
      const patched = await patch(env, 'ufc_events', `id=eq.${existing.id}`, { ...fill, venue: fill.venue ?? undefined, city: fill.city ?? undefined, region: fill.region ?? undefined, country: fill.country ?? undefined });
      saved = Array.isArray(patched) && patched[0] ? patched[0] : { ...existing, ...fill };
      Object.assign(existing, saved);
      run.notes.events_linked = (run.notes.events_linked || 0) + 1;
    } else {
      [saved] = await upsert(env, 'ufc_events', evRow, 'espn_event_id', { returning: 'representation' });
    }
    if (!existing) { run.events_new += 1; ctx.events.push(saved); }
    ctx.eventsByEspn.set(espnId, saved);

    const needsPass = !existing || existing.card_status !== 'complete' || eventDate >= cutoff;
    if (!needsPass) continue;
    if (isComplete && existing?.card_status !== 'complete') {
      if (fullPasses >= maxEvents) { run.notes.deferred_events = (run.notes.deferred_events || 0) + 1; continue; }
      fullPasses += 1;
    }
    await espnBouts(env, espn, ctx, run, saved, ev);
  }
}

const EVENT_STOP = new Set(['vs', 'v', 'ufc', 'fight', 'night', 'on', 'the', 'noche', 'espn', 'abc', 'fox', 'fx', 'jr', 'de', 'da', 'dos']);
function eventTokens(name) {
  return new Set(String(name || '').split(':').slice(-1)[0].normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t && !EVENT_STOP.has(t)));
}
function sameCard(a, b) {
  const na = /ufc\s*(\d+)/i.exec(a), nb = /ufc\s*(\d+)/i.exec(b);
  if (na && nb) return na[1] === nb[1];
  if (Boolean(na) !== Boolean(nb)) return false;
  const ta = eventTokens(a), tb = eventTokens(b);
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared >= 2 || (shared >= 1 && (ta.size <= 2 || tb.size <= 2));
}
function linkUfcstatsEvent(ctx, name, eventDate) {
  const cands = ctx.events.filter((x) => x.ufcstats_id && !x.espn_event_id && x.event_date && dayDiff(x.event_date, eventDate) <= 1 && sameCard(x.name, name));
  return cands.length === 1 ? cands[0] : undefined;
}

async function ensureEspnFighter(env, espn, ctx, run, f, weightClass, eventId = null) {
  const known = ctx.byEspnAthlete.get(f.espn_athlete_id);
  if (known) return known;
  const a = await espn.athlete(f.athlete_ref);
  /* Card evidence: fighters already on this event's bouts who have no ESPN id
   * yet (typically the UFC Stats-first rows the backfill created). A unique
   * name match among them is this athlete, even when the two sources print
   * different birth dates. */
  const scope = eventId ? [...new Set(ctx.bouts.filter((b) => b.event_id === eventId).flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))]
    .filter((id) => id && !ctx.fightersById.get(id)?.espn_athlete_id) : null;
  const res = ctx.resolver.resolve(a.name, 'espn', { weight_class: weightClass, dob: a.dob, record: a.record, event_scope: scope });
  if (res.status === 'matched' && res.dob_conflict) {
    run.notes.dob_conflicts_linked = (run.notes.dob_conflicts_linked || []).concat({ source: 'espn', name: a.name, espn_dob: a.dob, fighter_id: res.fighter_id, method: res.method });
  }
  const physical = {
    dob: a.dob, height_in: a.height_in, reach_in: a.reach_in, weight_lbs: a.weight_lbs,
    stance: a.stance_raw ? normStance(a.stance_raw, a.source_url) : null,
    is_active: a.active, updated_at: nowIso(),
  };
  const rec = a.record ? a.record.match(/(\d+)-(\d+)-(\d+)/) : null;
  if (rec) Object.assign(physical, { record_w: +rec[1], record_l: +rec[2], record_d: +rec[3] });
  let row;
  if (res.status === 'matched') {
    /* PATCH, not upsert: a PostgREST upsert on `id` attempts the INSERT
     * first, so NOT NULL columns absent from the body (source_url) fail
     * before the conflict merge runs. */
    const existing = ctx.fightersById.get(res.fighter_id);
    /* On a DOB conflict the stored date stays; the disagreement is in the run notes. */
    const fill = res.dob_conflict ? (({ dob: _d, ...rest }) => rest)(physical) : physical;
    await patch(env, 'ufc_fighters', `id=eq.${existing.id}`, { espn_athlete_id: a.espn_athlete_id, ...fill });
    row = { ...existing, espn_athlete_id: a.espn_athlete_id, ...fill };
  } else {
    [row] = await upsert(env, 'ufc_fighters', { espn_athlete_id: a.espn_athlete_id, name: a.name, nickname: a.nickname, ...physical,
      source_url: a.source_url, captured_at: nowIso() }, 'espn_athlete_id', { returning: 'representation' });
    if (res.status === 'review') await queueReview(env, ctx, res, a.name, 'espn', { espn_athlete_id: a.espn_athlete_id, created_fighter_id: row.id, url: a.source_url });
  }
  registerFighter(ctx, row);
  await upsert(env, 'ufc_fighter_aliases', [
    ...aliasRowsForFighter(row.id, a.name, a.nickname).map((r) => ({ ...r, source: r.source === 'ufcstats' ? 'espn' : 'espn_nickname' })),
    ...(a.display_name && normalize(a.display_name) !== normalize(a.name) ? [{ fighter_id: row.id, alias: a.display_name, source: 'espn', normalized: normalize(a.display_name) }] : []),
  ], 'fighter_id,source,normalized');
  run.fighters_touched += 1;
  return row;
}

async function espnBouts(env, espn, ctx, run, evRow, ev) {
  const bouts = await espn.bouts(ev);
  if (ev.skipped?.length) run.notes.placeholder_competitions = (run.notes.placeholder_competitions || 0) + ev.skipped.length;
  const seen = new Set();
  let allResults = bouts.length > 0;
  for (const b of bouts) {
    const wc = normWeightClass(b.weight_class_raw, b.source_url);
    const fa = await ensureEspnFighter(env, espn, ctx, run, b.fighters[0], wc.weight_class, evRow.id);
    const fb = await ensureEspnFighter(env, espn, ctx, run, b.fighters[1], wc.weight_class, evRow.id);
    const existing = ctx.boutsByEspn.get(b.espn_competition_id);
    const cancelled = /CANCEL|POSTPONED/i.test(b.status_name);
    const boutRow = {
      espn_competition_id: b.espn_competition_id, event_id: evRow.id,
      fighter_a_id: fa.id, fighter_b_id: fb.id,
      weight_class: wc.weight_class, weight_class_raw: b.weight_class_raw, is_womens: wc.is_womens, is_title: wc.is_title,
      scheduled_rounds: b.scheduled_rounds ?? (b.time_format ? scheduledRounds(b.time_format, b.source_url) : null),
      card_position: b.card_position, bout_order: b.bout_order,
      status: b.completed ? 'complete' : (cancelled ? 'cancelled' : 'announced'),
      source_url: b.source_url, captured_at: nowIso(), updated_at: nowIso(),
    };
    if (existing?.ufcstats_id) boutRow.ufcstats_id = existing.ufcstats_id;
    const [saved] = await upsert(env, 'ufc_bouts', boutRow, 'espn_competition_id', { returning: 'representation' });
    if (!existing) { run.bouts_new += 1; ctx.bouts.push(saved); }
    ctx.boutsByEspn.set(b.espn_competition_id, saved);
    seen.add(b.espn_competition_id);

    if (b.completed && b.result) {
      const method = normMethod(b.result.method_raw, b.source_url);
      const winnerRow = b.result.winner_espn_athlete_id ? ctx.byEspnAthlete.get(b.result.winner_espn_athlete_id) : null;
      if (!winnerRow && !['DRAW', 'NC'].includes(method)) throw new SchemaAssertionError(b.source_url, `completed ${method} bout without a winner`);
      const prior = ctx.resultsByBout.get(saved.id);
      if (!prior) {
        /* The first run that sees ESPN call this bout final. That is the
         * start of the latency window the round-stat lane later closes. */
        await mergeState(env, STATE.latency(saved.id), { bout_id: saved.id, espn_final_first_seen_at: nowIso() }, { onlyIfAbsent: ['espn_final_first_seen_at'] });
      }
      const referee = await espn.referee(b.officials_ref);
      await upsert(env, 'ufc_bout_results', {
        bout_id: saved.id, winner_id: winnerRow?.id || null, method, method_raw: b.result.method_raw,
        round: b.result.round, time_sec: b.result.time ? mmssToSec(b.result.time, b.source_url) : null,
        time_format: b.time_format, referee, finish_detail: b.result.finish_detail,
        has_stats: prior?.has_stats || false, result_source: prior?.has_stats ? 'ufcstats' : 'espn',
        source_url: b.source_url, captured_at: nowIso(),
      }, 'bout_id');
      ctx.resultsByBout.set(saved.id, { ...(prior || {}), bout_id: saved.id, has_stats: prior?.has_stats || false,
        winner_id: winnerRow?.id || null, round: b.result.round });
    } else if (!cancelled) {
      allResults = false;
    }
  }
  for (const b of ctx.bouts) {
    if (b.event_id === evRow.id && b.espn_competition_id && !seen.has(b.espn_competition_id) && b.status === 'announced') {
      run.assertion_failures.push({ class: 'AnnouncedBoutVanished', url: ev.url, detail: `competition ${b.espn_competition_id} no longer on ESPN card`, at: nowIso() });
    }
  }
  if (allResults && evRow.card_status !== 'complete') {
    await patch(env, 'ufc_events', `id=eq.${evRow.id}`, { card_status: 'complete', updated_at: nowIso() });
    evRow.card_status = 'complete';
  }
}

/* ------------------------------------------------------------------------ */
/* UFC Stats pass — round stats only                                         */
/* ------------------------------------------------------------------------ */
function dayDiff(a, b) { return Math.abs((Date.parse(a) - Date.parse(b)) / 86400e3); }

/* bout ids (of the given set) that already hold at least one round row. */
async function boutsWithRounds(env, boutIds) {
  const have = new Set();
  const ids = [...new Set(boutIds)];
  for (let i = 0; i < ids.length; i += 60) {
    const rows = await selectAll(env, 'ufc_bout_round_stats', `select=bout_id&bout_id=in.(${ids.slice(i, i + 60).join(',')})`);
    for (const r of rows) have.add(r.bout_id);
  }
  return have;
}

/* ------------------------------------------------------------------------ */
/* Round-stat lane: an explicit queue from "final" to verified round rows    */
/* ------------------------------------------------------------------------ */
const Q = 'ufc_round_stat_queue';

async function qset(env, boutId, fields) {
  await patch(env, Q, `bout_id=eq.${boutId}`, { ...fields, updated_at: nowIso() });
}

/* The lane (docs: supabase/migrations/20260910180000_ufc_round_stat_queue.sql).
 *
 *   1. ENQUEUE every bout our own record says is final (a stored result), in
 *      the forward window, with no round rows. Contender Series included. The
 *      UFC Stats completed list plays no part in eligibility.
 *   2. CLOSE items whose rows arrived by another path (backfill, repair).
 *   3. If source access is not allowed (UFCSTATS_ENABLED=false, or a stored
 *      challenge), due items are marked awaiting_source with the reason and
 *      NOTHING is fetched.
 *   4. Otherwise RESOLVE identity (stored bout id -> event page -> fighter
 *      history -> completed list as a cross-check only), FETCH the fight page,
 *      VALIDATE identities and result, WRITE idempotently. Every outcome is a
 *      queue state with its reason. */
async function roundStatLane(env, fetcher, ctx, run, { sourceAllowed, sourceReason = null, onlyBout = null, force = false } = {}) {
  const now = Date.now();
  const forwardDays = Number(env.UFCSTATS_FORWARD_DAYS || 45);
  const maxEvents = Number(env.MAX_EVENTS_PER_RUN || 3);
  const maxFights = Number(env.MAX_UFCSTATS_FIGHTS_PER_RUN || 24);
  const fetchCap = Number(env.MAX_UFCSTATS_REQUESTS_PER_RUN || 60);
  const events = new Map(ctx.events.map((e) => [e.id, e]));
  const cutoff = new Date(now - forwardDays * 86400000).toISOString().slice(0, 10);
  const windowBouts = ctx.bouts.filter((b) => (onlyBout ? b.id === onlyBout : (events.get(b.event_id)?.event_date || '') >= cutoff));
  const withRows = force && onlyBout ? new Set() : await boutsWithRounds(env, windowBouts.map((b) => b.id));
  const { candidates, skipped } = selectCandidates({
    bouts: windowBouts, events, results: ctx.resultsByBout, withRows, now, forwardDays: onlyBout ? 36500 : forwardDays,
  });
  const outcomes = { enqueued_new: 0, closed_written_elsewhere: 0, awaiting_source: 0, written: 0, not_yet_published: 0, no_round_detail: 0,
    identity_review: 0, validation_failed: 0, deferred_cap: 0, not_due: 0 };
  run.notes.lane = { source_allowed: sourceAllowed, source_reason: sourceReason, window_from: cutoff, candidates: candidates.length, skipped, outcomes };
  run.notes.written_bouts = [];
  run.notes.lane_problems = [];
  run.notes.round_rows = 0;
  run.notes.round_rows_written = 0;

  /* 2. close items whose rows exist now */
  const rowed = windowBouts.filter((b) => withRows.has(b.id)).map((b) => b.id);
  for (let i = 0; i < rowed.length; i += 60) {
    const closed = await patchCount(env, Q, `bout_id=in.(${rowed.slice(i, i + 60).join(',')})&state=not.in.(written,written_elsewhere)`,
      { state: 'written_elsewhere', last_reason: 'round rows present from another path', updated_at: nowIso() });
    outcomes.closed_written_elsewhere += closed;
  }
  if (!candidates.length) { run.notes.ufcstats_pass = 'no final bouts without round rows'; return; }

  /* 1. enqueue (insert-if-absent on bout_id) and load the queue state */
  const qBy = new Map();
  for (let i = 0; i < candidates.length; i += 60) {
    const ids = candidates.slice(i, i + 60).map((c) => c.bout.id);
    for (const q of (await select(env, Q, `select=*&bout_id=in.(${ids.join(',')})`)) || []) qBy.set(q.bout_id, q);
  }
  const fresh = candidates.filter((c) => !qBy.has(c.bout.id));
  if (fresh.length) {
    const rows = [];
    for (const c of fresh) {
      const lat = await getState(env, STATE.latency(c.bout.id));
      rows.push({ bout_id: c.bout.id, event_id: c.event.id, state: 'queued', first_final_seen_at: lat?.espn_final_first_seen_at || null,
        ufcstats_fight_id: c.bout.ufcstats_id || null, ufcstats_event_id: c.event.ufcstats_id || null, last_reason: 'final with no round rows' });
    }
    const inserted = await insertIgnore(env, Q, rows, 'bout_id');
    for (const q of inserted) qBy.set(q.bout_id, q);
    outcomes.enqueued_new = inserted.length;
  }

  const due = candidates.filter((c) => {
    const q = qBy.get(c.bout.id);
    const ok = force || !q?.next_attempt_at || Date.parse(q.next_attempt_at) <= now;
    if (!ok) outcomes.not_due += 1;
    return ok;
  });

  /* 3. no source access: record why, fetch nothing */
  if (!sourceAllowed) {
    for (const c of due) {
      const q = qBy.get(c.bout.id);
      if (q?.state !== 'awaiting_source' || q?.last_reason !== sourceReason) {
        await qset(env, c.bout.id, { state: 'awaiting_source', last_reason: sourceReason, next_attempt_at: null });
      }
      outcomes.awaiting_source += 1;
    }
    run.notes.ufcstats_pass = `not fetched (${sourceReason})`;
    return;
  }

  /* 4. resolve, fetch, validate, write */
  const byEvent = new Map();
  for (const c of due) {
    if (!byEvent.has(c.event.id)) byEvent.set(c.event.id, []);
    byEvent.get(c.event.id).push(c);
  }
  const cache = { events: new Map(), fighters: new Map(), completed: null };
  let fights = 0;
  let eventsDone = 0;
  let current = null;
  try {
    for (const [, group] of byEvent) {
      if (eventsDone >= maxEvents) { outcomes.deferred_cap += group.length; continue; }
      eventsDone += 1;
      for (const { bout, event, result } of group) {
        if (fights >= maxFights || fetcher.subrequests >= fetchCap) { outcomes.deferred_cap += 1; continue; }
        current = bout.id;
        const q = qBy.get(bout.id) || {};
        const attempt = { attempts: (q.attempts || 0) + 1, last_attempt_at: nowIso() };
        const id = await resolveIdentity(env, fetcher, ctx, run, bout, event, cache);
        if (!id.fightId) {
          outcomes.identity_review += 1;
          run.notes.lane_problems.push({ bout_id: bout.id, kind: 'identity_review', event: event.name, reason: id.reason, evidence: id.evidence });
          await qset(env, bout.id, { ...attempt, state: 'identity_review', last_reason: id.reason, identity_evidence: id.evidence || {},
            next_attempt_at: nextAttempt('identity_review', Date.now()) });
          continue;
        }
        const fighterA = ctx.fightersById.get(bout.fighter_a_id);
        const fighterB = ctx.fightersById.get(bout.fighter_b_id);
        const fUrl = fetcher.url('fights', id.fightId);
        fights += 1;
        const { html } = await fetcher.get('fights', id.fightId, fUrl, { refresh: true });
        const idFields = { ufcstats_fight_id: id.fightId, ufcstats_event_id: id.eventUsId || event.ufcstats_id || null, identity_method: id.method, identity_evidence: id.evidence || {} };
        if (P.isPreResultFightPage(html)) {
          outcomes.not_yet_published += 1;
          await qset(env, bout.id, { ...attempt, ...idFields, state: 'not_yet_published', last_reason: 'fight page is a pre-result preview',
            last_unavailable_at: nowIso(), next_attempt_at: nextAttempt('not_yet_published', Date.now()) });
          continue;
        }
        const f = P.parseFightPage(html, fUrl);
        const problems = validateFight({ parsed: f, fighterA, fighterB, result });
        if (problems.length) {
          outcomes.validation_failed += 1;
          run.notes.lane_problems.push({ bout_id: bout.id, kind: 'validation_failed', url: fUrl, problems });
          run.assertion_failures.push({ class: 'RoundLaneValidation', url: fUrl, detail: problems.join('; ').slice(0, 300), at: nowIso() });
          await qset(env, bout.id, { ...attempt, ...idFields, state: 'validation_failed', last_reason: problems.join('; ').slice(0, 500),
            next_attempt_at: nextAttempt('validation_failed', Date.now()) });
          continue;
        }
        /* Link the ids we just proved. A UFC Stats id already on ANOTHER row of
         * ours is a duplicate-row problem for reconciliation, not something to
         * overwrite: the bout goes to review instead. */
        const clash = ctx.bouts.find((x) => x.id !== bout.id && x.ufcstats_id === id.fightId);
        if (clash) {
          outcomes.identity_review += 1;
          const reason = `UFC Stats fight ${id.fightId} is already on bout ${clash.id} (duplicate bout row)`;
          run.notes.lane_problems.push({ bout_id: bout.id, kind: 'duplicate_bout_row', other_bout_id: clash.id, fight_id: id.fightId });
          await qset(env, bout.id, { ...attempt, ...idFields, state: 'identity_review', last_reason: reason, next_attempt_at: nextAttempt('identity_review', Date.now()) });
          continue;
        }
        const capturedAt = nowIso();
        const boutPatch = { updated_at: capturedAt };
        if (!bout.ufcstats_id) boutPatch.ufcstats_id = id.fightId;
        if (bout.scheduled_rounds == null && f.scheduled_rounds != null) boutPatch.scheduled_rounds = f.scheduled_rounds;
        await patch(env, 'ufc_bouts', `id=eq.${bout.id}`, boutPatch);
        bout.ufcstats_id = id.fightId;
        if (id.eventUsId && !event.ufcstats_id && !ctx.events.some((x) => x.id !== event.id && x.ufcstats_id === id.eventUsId)) {
          await patch(env, 'ufc_events', `id=eq.${event.id}`, { ufcstats_id: id.eventUsId, updated_at: capturedAt });
          event.ufcstats_id = id.eventUsId;
        }
        const statsMarks = { stats_source_url: fUrl, stats_captured_at: capturedAt, has_stats: f.has_stats };
        if (!f.rounds.length) {
          outcomes.no_round_detail += 1;
          await patch(env, 'ufc_bout_results', `bout_id=eq.${bout.id}`, statsMarks);
          await qset(env, bout.id, { ...attempt, ...idFields, state: 'no_round_detail', last_reason: 'fight page has no stats tables',
            last_unavailable_at: capturedAt, next_attempt_at: nextAttempt('no_round_detail', Date.now()) });
          continue;
        }
        const rows = roundRowsFor(f, fighterA, fighterB, bout.id, fUrl, capturedAt);
        const before = await count(env, 'ufc_bout_round_stats', `bout_id=eq.${bout.id}`);
        await upsert(env, 'ufc_bout_round_stats', rows, 'bout_id,fighter_id,round');
        const after = await count(env, 'ufc_bout_round_stats', `bout_id=eq.${bout.id}`);
        if (after !== rows.length) throw new SchemaAssertionError(fUrl, `round rows after upsert ${after} != parsed ${rows.length}`);
        const resultPatch = { ...statsMarks, scorecards: f.scorecards ?? undefined,
          judge_1: f.scorecards?.[0]?.judge, judge_2: f.scorecards?.[1]?.judge, judge_3: f.scorecards?.[2]?.judge };
        if (!result.referee && f.referee) resultPatch.referee = f.referee;
        if (!result.finish_detail && f.finish_detail) resultPatch.finish_detail = f.finish_detail;
        if (!result.time_format && f.time_format) resultPatch.time_format = f.time_format;
        await patch(env, 'ufc_bout_results', `bout_id=eq.${bout.id}`, resultPatch);
        await qset(env, bout.id, { ...attempt, ...idFields, state: 'written', last_reason: null, written_at: capturedAt, rows_written: after - before,
          source_first_available_at: q.source_first_available_at || capturedAt, next_attempt_at: null });
        await mergeState(env, STATE.latency(bout.id), { ufcstats_first_available_at: capturedAt, round_rows_captured_at: capturedAt },
          { onlyIfAbsent: ['ufcstats_first_available_at', 'round_rows_captured_at'] });
        run.notes.round_rows_written += after - before;
        outcomes.written += 1;
        run.notes.written_bouts.push({ bout_id: bout.id, ufcstats_fight_id: id.fightId, identity_method: id.method, rows: rows.length,
          rows_before: before, rows_after: after, fighters: [fighterA.name, fighterB.name],
          latency: latencySummary({ espn_final_first_seen_at: q.first_final_seen_at, ufcstats_last_unavailable_at: q.last_unavailable_at,
            ufcstats_first_available_at: capturedAt, round_rows_captured_at: capturedAt }) });
      }
    }
  } catch (e) {
    if (e instanceof AccessGateError && current) {
      await qset(env, current, { state: 'awaiting_source', last_reason: `source challenged: ${String(e.message || e).slice(0, 200)}`, next_attempt_at: null });
    }
    throw e;
  }
  run.notes.round_rows = run.notes.round_rows_written;
  run.notes.ufcstats_pass = 'ran';
}

/* UFC Stats identity for one of our bouts, without trusting names alone and
 * without the completed-events list as a prerequisite. Returns
 * { fightId, eventUsId, method, evidence } or { reason, evidence }. */
async function resolveIdentity(env, fetcher, ctx, run, bout, event, cache) {
  const fa = ctx.fightersById.get(bout.fighter_a_id);
  const fb = ctx.fightersById.get(bout.fighter_b_id);
  const scope = [bout.fighter_a_id, bout.fighter_b_id];
  const evidence = { our_fighters: [fa?.name, fb?.name], our_ufcstats_ids: [fa?.ufcstats_id || null, fb?.ufcstats_id || null], event: event.name, event_date: event.event_date };

  /* a. stored on the bout */
  if (bout.ufcstats_id) return { fightId: bout.ufcstats_id, eventUsId: event.ufcstats_id || null, method: 'stored_bout_id', evidence };

  const eventPage = async (usId) => {
    if (!cache.events.has(usId)) {
      const u = fetcher.url('events', usId);
      cache.events.set(usId, { url: u, page: P.parseEventPage((await fetcher.get('events', usId, u, { refresh: true })).html, u) });
    }
    return cache.events.get(usId);
  };
  const onCard = async (usId, via) => {
    const { url, page } = await eventPage(usId);
    const ids = new Set([fa?.ufcstats_id, fb?.ufcstats_id].filter(Boolean));
    let x = ids.size === 2 ? page.bouts.find((b) => ids.has(b.fighter_a_ufcstats_id) && ids.has(b.fighter_b_ufcstats_id)) : null;
    if (x) return { fightId: x.ufcstats_id, eventUsId: usId, method: `${via}_pair`, evidence: { ...evidence, event_page: url } };
    /* Name nominates; the resolver, scoped to this bout's corners, decides. */
    const byName = page.bouts.filter((b) => [b.fighter_a_name, b.fighter_b_name].some((nm) => [fa?.name, fb?.name].some((m) => m && normalize(m) === normalize(nm))));
    if (byName.length === 1) {
      x = byName[0];
      const la = await linkUfcstatsFighter(env, fetcher, ctx, run, x.fighter_a_ufcstats_id, x.fighter_a_name, url, scope);
      const lb = await linkUfcstatsFighter(env, fetcher, ctx, run, x.fighter_b_ufcstats_id, x.fighter_b_name, url, scope);
      const got = new Set([la?.id, lb?.id]);
      if (la && lb && got.has(bout.fighter_a_id) && got.has(bout.fighter_b_id)) {
        return { fightId: x.ufcstats_id, eventUsId: usId, method: `${via}_name_resolved`, evidence: { ...evidence, event_page: url, resolver_scope: scope } };
      }
    }
    return null;
  };

  /* b. the linked event's own page */
  if (event.ufcstats_id) {
    const r = await onCard(event.ufcstats_id, 'event_page');
    if (r) return r;
  }

  /* c. fighter history: reaches cards the completed list omits */
  for (const [me, other] of [[fa, fb], [fb, fa]]) {
    if (!me?.ufcstats_id) continue;
    if (!cache.fighters.has(me.ufcstats_id)) {
      const u = fetcher.url('fighters', me.ufcstats_id);
      cache.fighters.set(me.ufcstats_id, { url: u, rows: P.parseFighterHistory((await fetcher.get('fighters', me.ufcstats_id, u, { refresh: true })).html, u) });
    }
    const { url, rows } = cache.fighters.get(me.ufcstats_id);
    const m = matchHistoryRow(rows, { eventDate: event.event_date, other: { ufcstats_id: other?.ufcstats_id || null, name: other?.name } });
    if (m.row) {
      if (!other?.ufcstats_id) {
        const linked = await linkUfcstatsFighter(env, fetcher, ctx, run, m.row.opponent_ufcstats_id, m.row.opponent_name, url, scope);
        if (!linked || linked.id !== other?.id) {
          return { reason: `history names ${m.row.opponent_name} (${m.row.opponent_ufcstats_id}) but it did not resolve to our fighter ${other?.name}`, evidence: { ...evidence, history_of: me.ufcstats_id, ...m.evidence } };
        }
      }
      return { fightId: m.row.fight_id, eventUsId: m.row.event_ufcstats_id, method: 'fighter_history', evidence: { ...evidence, history_of: me.ufcstats_id, history_page: url, ...m.evidence } };
    }
    if (m.candidates > 1) return { reason: `fighter history has ${m.candidates} qualifying rows`, evidence: { ...evidence, history_of: me.ufcstats_id } };
  }

  /* d. completed list, cross-check only, for unlinked non-Contender cards */
  if (!event.ufcstats_id && !isContenderSeries(event.name)) {
    if (!cache.completed) {
      const u = `${fetcher.base}/statistics/events/completed?page=all`;
      cache.completed = P.parseEventList((await fetcher.get('lists', 'completed', u, { refresh: true })).html, u);
    }
    const cands = cache.completed.filter((e) => e.event_date && dayDiff(e.event_date, event.event_date) <= 1 && sameCard(e.name, event.name));
    if (cands.length === 1) {
      const r = await onCard(cands[0].ufcstats_id, 'completed_list');
      if (r) return r;
    }
  }
  const anchored = Boolean(fa?.ufcstats_id || fb?.ufcstats_id || event.ufcstats_id);
  return { reason: anchored ? 'not found on the event page or in either fighter history' : 'no UFC Stats anchor (neither fighter nor the event is linked)', evidence };
}

/* ---------------------------------------------------------------- canary */

/* A bounded, read-only look at UFC Stats from Cloudflare's egress. It fetches
 * a handful of fight pages whose round rows the archive already holds, parses
 * them with the production parser, validates identity with the production
 * validator, and compares every stored column. It writes nothing but its own
 * run-ledger row, and it does not answer a challenge: seeing one is the
 * finding. */
const CANARY_COLS = ['kd', 'sig_str_landed', 'sig_str_att', 'total_str_landed', 'total_str_att', 'td_landed', 'td_att', 'sub_att', 'rev', 'ctrl_sec',
  'head_landed', 'head_att', 'body_landed', 'body_att', 'leg_landed', 'leg_att', 'distance_landed', 'distance_att', 'clinch_landed', 'clinch_att', 'ground_landed', 'ground_att'];

async function runCanary(env, { n = 3 } = {}) {
  const limit = Math.max(1, Math.min(Number(n) || 3, 6));
  const fetcher = new Fetcher(env, { solveGate: false, minIntervalMs: 1500 });
  const report = { at: nowIso(), limit, egress: null, bouts: [], source: null, verdict: null };
  let runId = null;
  try {
    const created = await insert(env, 'ufc_ingest_runs', { worker: SERVICE, status: 'running', notes: { mode: 'canary', version: VERSION } });
    runId = created?.[0]?.id || null;
    try {
      const t = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
      const kv = Object.fromEntries(t.trim().split('\n').map((l) => l.split('=')));
      report.egress = { colo: kv.colo || null, loc: kv.loc || null, ip_family: String(kv.ip || '').includes(':') ? 'v6' : 'v4' };
    } catch (_) { report.egress = null; }

    const recent = await select(env, 'ufc_bout_round_stats', 'select=bout_id&order=captured_at.desc&limit=300');
    const ids = [...new Set((recent || []).map((r) => r.bout_id))].slice(0, 40);
    const bouts = await select(env, 'ufc_bouts', `select=id,ufcstats_id,fighter_a_id,fighter_b_id,event_id&id=in.(${ids.join(',')})&ufcstats_id=not.is.null`);
    const picked = (bouts || []).slice(0, limit);
    for (const b of picked) {
      const fighters = await select(env, 'ufc_fighters', `select=id,name,ufcstats_id&id=in.(${b.fighter_a_id},${b.fighter_b_id})`);
      const fa = fighters.find((x) => x.id === b.fighter_a_id);
      const fb = fighters.find((x) => x.id === b.fighter_b_id);
      const result = (await select(env, 'ufc_bout_results', `select=winner_id,round&bout_id=eq.${b.id}`))?.[0] || null;
      const stored = await select(env, 'ufc_bout_round_stats', `select=fighter_id,round,${CANARY_COLS.join(',')}&bout_id=eq.${b.id}`);
      const url = fetcher.url('fights', b.ufcstats_id);
      const t0 = Date.now();
      const html = await fetcher.httpGet(url);
      const f = P.parseFightPage(html, url);
      const problems = validateFight({ parsed: f, fighterA: fa, fighterB: fb, result });
      const parsedRows = roundRowsFor(f, fa, fb, b.id, url, 'canary');
      const key = (r) => `${r.fighter_id}|${r.round}`;
      const storedBy = new Map(stored.map((r) => [key(r), r]));
      const mismatches = [];
      for (const r of parsedRows) {
        const s = storedBy.get(key(r));
        if (!s) { mismatches.push({ row: key(r), issue: 'parsed row not stored' }); continue; }
        for (const c of CANARY_COLS) if ((s[c] ?? null) !== (r[c] ?? null)) mismatches.push({ row: key(r), col: c, stored: s[c], parsed: r[c] });
      }
      const parsedKeys = new Set(parsedRows.map(key));
      report.bouts.push({
        bout_id: b.id, ufcstats_fight_id: b.ufcstats_id, fighters: [fa?.name, fb?.name], fetch_ms: Date.now() - t0, bytes: html.length,
        parsed_rows: parsedRows.length, stored_rows: stored.length, identity_problems: problems,
        column_mismatches: mismatches.slice(0, 20), mismatch_count: mismatches.length,
        stored_rows_not_on_page: stored.filter((r) => !parsedKeys.has(key(r))).length,
        upsert_would_add_rows: parsedRows.filter((p) => !storedBy.has(key(p))).length,
      });
    }
    report.source = fetcher.telemetry();
    const clean = report.bouts.length > 0 && report.bouts.length === picked.length
      && report.bouts.every((x) => !x.identity_problems.length && !x.mismatch_count && !x.stored_rows_not_on_page && !x.upsert_would_add_rows);
    report.verdict = clean ? 'clean' : 'discrepancies';
  } catch (e) {
    report.source = fetcher.telemetry();
    report.verdict = e instanceof AccessGateError ? 'challenged' : 'error';
    report.error = { class: e?.name || 'Error', detail: String(e?.message || e).slice(0, 300), url: e?.url || null };
    if (e instanceof AccessGateError) {
      report.source_health = challengedState(env, { detail: report.error.detail, url: report.error.url, telemetry: report.source, via: 'canary' });
      await putState(env, STATE.health, report.source_health);
    }
  }
  if (report.verdict === 'clean') await putState(env, STATE.health, { status: 'ok', challenged: false, source: 'ufcstats.com', at: nowIso(), telemetry: report.source, via: 'canary' });
  if (runId) {
    try {
      await patch(env, 'ufc_ingest_runs', `id=eq.${runId}`, { finished_at: nowIso(), status: report.verdict === 'clean' ? 'success' : 'failed', notes: { mode: 'canary', version: VERSION, ...report } });
    } catch (_) { /* the response still carries the report */ }
  }
  return report;
}

/* Resolve a UFC Stats fighter id to our fighter row, fetching the fighter
 * page for DOB/record when the id is not yet linked. Returns null (and
 * queues review) when it cannot be linked safely. */
async function linkUfcstatsFighter(env, fetcher, ctx, run, ufcstatsId, name, fromUrl, eventScope = null) {
  const known = ctx.byUfcstatsFighter.get(ufcstatsId);
  if (known) return known;
  const url = fetcher.url('fighters', ufcstatsId);
  const { html } = await fetcher.get('fighters', ufcstatsId, url, { refresh: true });
  const p = P.parseFighterPage(html, url);
  const record = p.record_w == null ? null : `${p.record_w}-${p.record_l}-${p.record_d}`;
  /* eventScope = the corners of the bout being linked: a unique name match
   * among them is identity even if ESPN and UFC Stats print different DOBs. */
  const res = ctx.resolver.resolve(p.name, 'ufcstats', { ufcstats_id: ufcstatsId, dob: p.dob, record, event_scope: eventScope });
  if (res.status === 'matched' && res.dob_conflict) {
    run.notes.dob_conflicts_linked = (run.notes.dob_conflicts_linked || []).concat({ source: 'ufcstats', ufcstats_id: ufcstatsId, name: p.name, ufcstats_dob: p.dob, fighter_id: res.fighter_id, method: res.method });
  }
  if (res.status !== 'matched') {
    await queueReview(env, ctx, res, p.name, 'ufcstats', { ufcstats_id: ufcstatsId, url, from: fromUrl, dob: p.dob, record });
    return null;
  }
  const row = ctx.fightersById.get(res.fighter_id);
  const changes = {
    ufcstats_id: ufcstatsId,
    nickname: row.nickname || p.nickname || null, dob: row.dob || p.dob || null,
    height_in: row.height_in ?? p.height_in ?? null, reach_in: row.reach_in ?? p.reach_in ?? null,
    career_slpm: p.career_slpm, career_str_acc: p.career_str_acc, career_sapm: p.career_sapm, career_str_def: p.career_str_def,
    career_td_avg: p.career_td_avg, career_td_acc: p.career_td_acc, career_td_def: p.career_td_def, career_sub_avg: p.career_sub_avg,
    fight_history_count: p.fight_history_count, updated_at: nowIso(),
  };
  await patch(env, 'ufc_fighters', `id=eq.${row.id}`, changes);   // PATCH: see ensureEspnFighter
  const saved = { ...row, ...changes };
  registerFighter(ctx, saved);
  await upsert(env, 'ufc_fighter_aliases', aliasRowsForFighter(saved.id, p.name, p.nickname), 'fighter_id,source,normalized');
  run.fighters_touched += 1;
  return saved;
}
