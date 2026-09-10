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
 *   3. Round-stat lane (BOUT-driven, see lane.mjs): every bout the stored
 *      record says is finished, inside UFCSTATS_FORWARD_DAYS, with no round
 *      rows -> its UFC Stats event page -> its fight page -> identity and
 *      result validated -> round rows upserted -> result marked enriched.
 *      Anything that cannot be validated is recorded and left without rows.
 *      A fight page with no stats tables is recorded, never written as zeros.
 *   4. New round rows -> one Fight DNA rebuild requested from ufc-intelligence
 *      (the DNA owner) over the INTELLIGENCE service binding.
 *   5. card_status='complete' once every bout on the event has a result.
 *   6. One ufc_ingest_runs row per run with source telemetry and latency
 *      windows; Discord one-liner on success, loud on SchemaAssertionError /
 *      AccessGateError (which abort the run).
 *
 * Source health: a challenge the fetch layer will not answer (shape change,
 * difficulty over the limit, failed solve) is stored in R2 and keeps the lane
 * off UFC Stats for SOURCE_BACKOFF_HOURS. ESPN keeps running. Degrade, never
 * guess, never hammer.
 *
 * Latency: recorded as a window (last look that found nothing, first look that
 * found rows) against the first run that saw ESPN report the bout final. At a
 * 15-minute cadence that window is up to 15 minutes wide, and nothing about
 * the lane claims more precision than it measured.
 *
 * Announced bouts that vanish from ESPN's card are recorded in
 * assertion_failures as AnnouncedBoutVanished.
 */

import { selectAll, select, insert, upsert, patch, count } from './supabase.mjs';
import { discord } from './discord.mjs';
import { Fetcher, SchemaAssertionError, AccessGateError } from './ufcstats.mjs';
import { Espn } from './espn.mjs';
import * as P from './parsers.mjs';
import { normWeightClass, normMethod, normStance, scheduledRounds, mmssToSec } from './normalizers.mjs';
import { AliasResolver, aliasRowsForFighter, normalize } from './shared/alias_resolver.mjs';
import { selectCandidates, validateFight, roundRowsFor, latencySummary, sourceBlocked } from './lane.mjs';

const SERVICE = 'ufc-stats-ingest';
const VERSION = 'v0.3.0';

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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      let lastSuccess = null; let lastRoundWrite = null;
      try {
        lastSuccess = (await select(env, 'ufc_ingest_runs', `select=started_at,finished_at,status,notes&worker=eq.${SERVICE}&status=eq.success&order=started_at.desc&limit=1`))?.[0] || null;
        lastRoundWrite = (await select(env, 'ufc_bout_round_stats', 'select=captured_at,source_url&order=captured_at.desc&limit=1'))?.[0] || null;
      } catch (_) { /* reported as null */ }
      return json({
        service: SERVICE, version: VERSION, ...health,
        ufcstats_enabled: String(env.UFCSTATS_ENABLED ?? 'true') !== 'false',
        forward_days: Number(env.UFCSTATS_FORWARD_DAYS || 45),
        source_health: await getState(env, STATE.health),
        last_success: lastSuccess ? { started_at: lastSuccess.started_at, finished_at: lastSuccess.finished_at, round_rows: lastSuccess.notes?.round_rows ?? null, ufcstats_pass: lastSuccess.notes?.ufcstats_pass ?? null } : null,
        last_round_write: lastRoundWrite,
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
    if (!ufcstatsEnabled) {
      run.notes.ufcstats_pass = 'skipped (UFCSTATS_ENABLED=false)';
      run.notes.round_rows = 0;
      run.notes.health_warning = 'ROUND STATS DISABLED: UFCSTATS_ENABLED=false, so no round-level data is being ingested. Newly completed events will accumulate round-stat gaps until this is turned on.';
    } else if (sourceBlocked(sourceHealth, Date.now(), backoffHours) && !force) {
      run.notes.ufcstats_pass = `skipped (source challenged at ${sourceHealth.at}; backing off ${backoffHours}h)`;
      run.notes.round_rows = 0;
      run.notes.health_warning = `UFC STATS CHALLENGED: ${sourceHealth.detail}. Round stats paused, ESPN continues.`;
    } else {
      await ufcstatsPass(env, fetcher, ctx, run, { onlyBout, force });
      await putState(env, STATE.health, { status: 'ok', at: nowIso(), telemetry: fetcher.telemetry() });
    }

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
      await putState(env, STATE.health, { status: 'challenged', at: nowIso(), detail, url: e?.url || null, telemetry: fetcher.telemetry() });
      run.notes.ufcstats_pass = 'aborted (access gate)';
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

async function ensureEspnFighter(env, espn, ctx, run, f, weightClass) {
  const known = ctx.byEspnAthlete.get(f.espn_athlete_id);
  if (known) return known;
  const a = await espn.athlete(f.athlete_ref);
  const res = ctx.resolver.resolve(a.name, 'espn', { weight_class: weightClass, dob: a.dob, record: a.record });
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
    await patch(env, 'ufc_fighters', `id=eq.${existing.id}`, { espn_athlete_id: a.espn_athlete_id, ...physical });
    row = { ...existing, espn_athlete_id: a.espn_athlete_id, ...physical };
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
    const fa = await ensureEspnFighter(env, espn, ctx, run, b.fighters[0], wc.weight_class);
    const fb = await ensureEspnFighter(env, espn, ctx, run, b.fighters[1], wc.weight_class);
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

async function ufcstatsPass(env, fetcher, ctx, run, { onlyBout = null, force = false } = {}) {
  const now = Date.now();
  const forwardDays = Number(env.UFCSTATS_FORWARD_DAYS || 45);
  const maxEvents = Number(env.MAX_EVENTS_PER_RUN || 3);
  const maxFights = Number(env.MAX_UFCSTATS_FIGHTS_PER_RUN || 24);
  const events = new Map(ctx.events.map((e) => [e.id, e]));
  const cutoff = new Date(now - forwardDays * 86400000).toISOString().slice(0, 10);
  const windowBouts = ctx.bouts.filter((b) => (onlyBout ? b.id === onlyBout : (events.get(b.event_id)?.event_date || '') >= cutoff));
  const withRows = force && onlyBout ? new Set() : await boutsWithRounds(env, windowBouts.map((b) => b.id));
  const { candidates, skipped } = selectCandidates({
    bouts: windowBouts, events, results: ctx.resultsByBout, withRows, now,
    forwardDays: onlyBout ? 36500 : forwardDays,
  });
  run.notes.ufcstats_forward_cutoff = cutoff;
  run.notes.lane_candidates = candidates.length;
  run.notes.lane_skipped = skipped;
  const outcomes = { written: 0, not_yet_published: 0, source_no_round_detail: 0, identity_unresolved: 0, validation_failed: 0, event_not_on_ufcstats: 0, fight_not_on_event_page: 0, deferred_cap: 0 };
  run.notes.lane_outcomes = outcomes;
  run.notes.written_bouts = [];
  run.notes.latency = [];
  run.notes.lane_problems = [];
  let roundRowsWritten = 0;
  if (!candidates.length) { run.notes.ufcstats_pass = 'no candidate bouts'; run.notes.round_rows = 0; run.notes.round_rows_written = 0; return; }

  /* Group by card. One event page per card per run, whatever the bout count. */
  const byEvent = new Map();
  for (const c of candidates) {
    if (!byEvent.has(c.event.id)) byEvent.set(c.event.id, []);
    byEvent.get(c.event.id).push(c);
  }
  let completed = null;   // the 640 KB completed list, fetched only if a card is unlinked
  let fights = 0;
  let eventsDone = 0;
  for (const [, group] of byEvent) {
    const event = group[0].event;
    if (eventsDone >= maxEvents || fights >= maxFights) { outcomes.deferred_cap += group.length; continue; }
    eventsDone += 1;
    if (!event.ufcstats_id) {
      if (!completed) {
        const url = `${fetcher.base}/statistics/events/completed?page=all`;
        completed = P.parseEventList((await fetcher.get('lists', 'completed', url, { refresh: true })).html, url);
      }
      const cands = completed.filter((e) => e.event_date && dayDiff(e.event_date, event.event_date) <= 1 && sameCard(e.name, event.name));
      if (cands.length !== 1) {
        outcomes.event_not_on_ufcstats += group.length;
        for (const c of group) await noteUnavailable(env, c.bout.id, cands.length ? 'event_ambiguous_on_ufcstats' : 'event_not_listed_on_ufcstats');
        if (cands.length > 1) run.assertion_failures.push({ class: 'EventMatchAmbiguous', url: null, detail: `${event.name} ${event.event_date} matches ${cands.length} UFC Stats events`, at: nowIso() });
        continue;
      }
      await patch(env, 'ufc_events', `id=eq.${event.id}`, { ufcstats_id: cands[0].ufcstats_id, location_raw: cands[0].location_raw || null, updated_at: nowIso() });
      event.ufcstats_id = cands[0].ufcstats_id;
    }
    const evUrl = fetcher.url('events', event.ufcstats_id);
    const page = P.parseEventPage((await fetcher.get('events', event.ufcstats_id, evUrl, { refresh: true })).html, evUrl);

    for (const { bout, result } of group) {
      if (fights >= maxFights) { outcomes.deferred_cap += 1; continue; }
      const latKey = STATE.latency(bout.id);
      await mergeState(env, latKey, { bout_id: bout.id, ufcstats_first_checked_at: nowIso() }, { onlyIfAbsent: ['ufcstats_first_checked_at'] });
      const fa = ctx.fightersById.get(bout.fighter_a_id);
      const fb = ctx.fightersById.get(bout.fighter_b_id);
      /* Find the fight on the card: by the bout's stored UFC Stats id first,
       * then by the fighter pair's UFC Stats ids. Names alone never decide. */
      let listed = bout.ufcstats_id ? page.bouts.find((x) => x.ufcstats_id === bout.ufcstats_id) : null;
      if (!listed && fa?.ufcstats_id && fb?.ufcstats_id) {
        const pair = new Set([fa.ufcstats_id, fb.ufcstats_id]);
        listed = page.bouts.find((x) => pair.has(x.fighter_a_ufcstats_id) && pair.has(x.fighter_b_ufcstats_id)) || null;
      }
      if (!listed) {
        /* A name hit only nominates a fight. The fighters on it must then
         * resolve (name + DOB/record, the shared resolver) to exactly our
         * two fighter rows, or the bout stays without rows and one review
         * item is queued. */
        const byName = page.bouts.filter((x) => [x.fighter_a_name, x.fighter_b_name].some((nm) => [fa?.name, fb?.name].some((m) => m && normalize(m) === normalize(nm))));
        if (byName.length === 1) {
          const x = byName[0];
          const la = await linkUfcstatsFighter(env, fetcher, ctx, run, x.fighter_a_ufcstats_id, x.fighter_a_name, evUrl);
          const lb = await linkUfcstatsFighter(env, fetcher, ctx, run, x.fighter_b_ufcstats_id, x.fighter_b_name, evUrl);
          const got = new Set([la?.id, lb?.id]);
          if (la && lb && got.has(bout.fighter_a_id) && got.has(bout.fighter_b_id)) listed = x;
        }
      }
      if (!listed || !listed.ufcstats_id) {
        const kind = fa?.ufcstats_id && fb?.ufcstats_id ? 'fight_not_on_event_page' : 'identity_unresolved';
        outcomes[kind] += 1;
        run.notes.lane_problems.push({ bout_id: bout.id, kind, event: event.name, fighters: [fa?.name, fb?.name], ufcstats_ids: [fa?.ufcstats_id || null, fb?.ufcstats_id || null] });
        await noteUnavailable(env, bout.id, kind);
        continue;
      }
      const fighterA = ctx.fightersById.get(bout.fighter_a_id);
      const fighterB = ctx.fightersById.get(bout.fighter_b_id);
      const fUrl = fetcher.url('fights', listed.ufcstats_id);
      fights += 1;
      const { html } = await fetcher.get('fights', listed.ufcstats_id, fUrl, { refresh: true });
      /* Results can post before the stats do. The preview page states no
       * winner or rounds: a gap to retry next run, and the low edge of the
       * latency window. */
      if (P.isPreResultFightPage(html)) {
        outcomes.not_yet_published += 1;
        await noteUnavailable(env, bout.id, 'fight_page_is_preview');
        continue;
      }
      const f = P.parseFightPage(html, fUrl);
      const problems = validateFight({ parsed: f, fighterA, fighterB, result });
      if (problems.length) {
        outcomes.validation_failed += 1;
        run.notes.lane_problems.push({ bout_id: bout.id, kind: 'validation_failed', url: fUrl, problems });
        run.assertion_failures.push({ class: 'RoundLaneValidation', url: fUrl, detail: problems.join('; ').slice(0, 300), at: nowIso() });
        continue;
      }
      const capturedAt = nowIso();
      const boutPatch = { updated_at: capturedAt };
      if (!bout.ufcstats_id) boutPatch.ufcstats_id = listed.ufcstats_id;
      if (bout.scheduled_rounds == null && f.scheduled_rounds != null) boutPatch.scheduled_rounds = f.scheduled_rounds;
      await patch(env, 'ufc_bouts', `id=eq.${bout.id}`, boutPatch);
      bout.ufcstats_id = listed.ufcstats_id;
      const statsMarks = { stats_source_url: fUrl, stats_captured_at: capturedAt, has_stats: f.has_stats };
      if (!f.rounds.length) {
        /* The page exists and carries no stats tables. That is the source's
         * answer, recorded as such and never as a row of zeros. */
        outcomes.source_no_round_detail += 1;
        await patch(env, 'ufc_bout_results', `bout_id=eq.${bout.id}`, statsMarks);
        await noteUnavailable(env, bout.id, 'fight_page_has_no_stats_tables');
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
      roundRowsWritten += after - before;
      outcomes.written += 1;
      const lat = await mergeState(env, latKey, { ufcstats_first_available_at: capturedAt, round_rows_captured_at: capturedAt }, { onlyIfAbsent: ['ufcstats_first_available_at', 'round_rows_captured_at'] });
      run.notes.written_bouts.push({ bout_id: bout.id, ufcstats_fight_id: listed.ufcstats_id, rows: rows.length, rows_before: before, rows_after: after, fighters: [fighterA.name, fighterB.name] });
      run.notes.latency.push(latencySummary(lat));
    }
  }
  run.notes.round_rows = roundRowsWritten;
  run.notes.round_rows_written = roundRowsWritten;
  run.notes.ufcstats_pass = 'ran';
}

/* The latest look that found no round detail. Stops moving once a later look
 * finds rows, which is exactly what makes it the window's low edge. */
async function noteUnavailable(env, boutId, reason) {
  const key = STATE.latency(boutId);
  const cur = (await getState(env, key)) || { bout_id: boutId };
  if (cur.ufcstats_first_available_at) return;
  await putState(env, key, { ...cur, ufcstats_last_unavailable_at: nowIso(), ufcstats_last_unavailable_reason: reason });
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
    if (e instanceof AccessGateError) await putState(env, STATE.health, { status: 'challenged', at: nowIso(), detail: report.error.detail, url: report.error.url, telemetry: report.source, via: 'canary' });
  }
  if (report.verdict === 'clean') await putState(env, STATE.health, { status: 'ok', at: nowIso(), telemetry: report.source, via: 'canary' });
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
async function linkUfcstatsFighter(env, fetcher, ctx, run, ufcstatsId, name, fromUrl) {
  const known = ctx.byUfcstatsFighter.get(ufcstatsId);
  if (known) return known;
  const url = fetcher.url('fighters', ufcstatsId);
  const { html } = await fetcher.get('fighters', ufcstatsId, url, { refresh: true });
  const p = P.parseFighterPage(html, url);
  const record = p.record_w == null ? null : `${p.record_w}-${p.record_l}-${p.record_d}`;
  const res = ctx.resolver.resolve(p.name, 'ufcstats', { dob: p.dob, record });
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
