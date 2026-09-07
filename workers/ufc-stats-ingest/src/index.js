/* ufc-stats-ingest — nightly incremental ingest.
 *
 * Sources (decision 2026-09-05):
 *   ESPN core API  -> events, bouts, results, fighter identity + physicals.
 *   ufcstats.com   -> per-round stats only (fight pages), behind the PoW gate.
 *
 * Run shape:
 *   1. ESPN: events for this year (and last year in January). Upsert every
 *      event; upsert bouts + results for events that are new, not yet
 *      complete, or dated within the last 14 days. Cap: MAX_EVENTS_PER_RUN
 *      completed events get their full bout/result pass per run.
 *   2. Fighters: every ESPN athlete on those bouts is resolved against
 *      ufc_fighters with the alias resolver (name + DOB/record). Matched ->
 *      espn_athlete_id set. Unmatched -> new espn-first row. Ambiguous ->
 *      new espn-first row AND a ufc_alias_review_queue entry (never merge on
 *      name alone; a duplicate row is recoverable, a wrong merge is not).
 *   3. UFC Stats: completed list -> events whose date matches an ESPN event
 *      dated within +-1 day that has no ufcstats_id yet -> event page ->
 *      fight pages -> fighter pages -> resolver links ufcstats_id onto the
 *      ESPN fighters -> bout matched by fighter pair -> round stats written.
 *      Fighter/bout that cannot be linked: counted, queued, skipped. Never
 *      fatal, never guessed.
 *   4. card_status='complete' once every bout on the event has a result.
 *   5. One ufc_ingest_runs row per run; Discord one-liner on success, loud on
 *      SchemaAssertionError / AccessGateError (which abort the run).
 *
 * Announced bouts that vanish from ESPN's card are recorded in
 * assertion_failures as AnnouncedBoutVanished (Phase 2 card watcher takes
 * over real change tracking).
 */

import { selectAll, insert, upsert, patch } from './supabase.mjs';
import { discord } from './discord.mjs';
import { Fetcher, SchemaAssertionError, AccessGateError } from './ufcstats.mjs';
import { Espn } from './espn.mjs';
import * as P from './parsers.mjs';
import { normWeightClass, normMethod, normStance, scheduledRounds, mmssToSec } from './normalizers.mjs';
import { AliasResolver, aliasRowsForFighter, normalize } from './shared/alias_resolver.mjs';

const SERVICE = 'ufc-stats-ingest';
const VERSION = 'v0.2.0';

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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({
        service: SERVICE, version: VERSION, ...health,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          DISCORD_WEBHOOK_URL: Boolean(env.DISCORD_WEBHOOK_URL),
          RAW_BUCKET: Boolean(env.RAW),
        },
      });
    }
    if (url.pathname === '/admin/run' && req.method === 'POST') {
      if (!adminAuthorized(req, env)) return json({ error: 'not_found' }, 404);
      const result = await runIngest(env);
      return json({ service: SERVICE, version: VERSION, invoked: 'manual', result });
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIngest(env));
  },
};

/* ------------------------------------------------------------------------ */
/* Run driver                                                                */
/* ------------------------------------------------------------------------ */
async function runIngest(env) {
  health.last_cron_run = nowIso();
  console.log(`[${SERVICE}] START ${health.last_cron_run}`);
  const run = { events_new: 0, bouts_new: 0, fighters_touched: 0, assertion_failures: [], notes: {} };
  let runId = null;
  let status = 'success';
  const fetcher = new Fetcher(env);
  const espn = new Espn();
  try {
    const created = await insert(env, 'ufc_ingest_runs', { worker: SERVICE, status: 'running' });
    runId = created?.[0]?.id || null;

    const ctx = await loadContext(env);
    await espnPass(env, espn, ctx, run);
    /* UFCSTATS_ENABLED="false" runs the ESPN-first path alone (schedule,
     * results, fighters). Used for the production proof run and while the
     * UFC Stats parsers are pending. */
    /* The round-stat pass being off is a silent, months-long outage: ESPN
     * keeps writing events and results, so every dashboard looks healthy
     * while no round data lands at all. The flag state is therefore recorded
     * on every run, enabled or not, and the disabled case is stated in words
     * a human reading the run row will notice. */
    const ufcstatsEnabled = String(env.UFCSTATS_ENABLED ?? 'true') !== 'false';
    run.notes.ufcstats_enabled = ufcstatsEnabled;
    if (ufcstatsEnabled) {
      await ufcstatsPass(env, fetcher, ctx, run);
    } else {
      run.notes.ufcstats_pass = 'skipped (UFCSTATS_ENABLED=false)';
      run.notes.round_rows = 0;
      run.notes.health_warning = 'ROUND STATS DISABLED: UFCSTATS_ENABLED=false, so no round-level data is being ingested. Newly completed events will accumulate round-stat gaps until this is turned on.';
    }

    run.notes.espn_subrequests = espn.subrequests;
    run.notes.ufcstats_subrequests = fetcher.subrequests;
    run.notes.ufcstats_fetched = fetcher.fetched;
    run.notes.challenges_solved = fetcher.challengesSolved;
    run.notes.review_queued = ctx.reviewQueued;
  } catch (e) {
    status = 'failed';
    const cls = e?.name || 'Error';
    health.last_error_class = cls;
    const detail = String(e?.message || e).slice(0, 400);
    run.assertion_failures.push({ class: cls, url: e?.url || null, detail, at: nowIso() });
    console.error(`[${SERVICE}] ${cls}: ${detail}`);
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
        + ` rounds=${n.round_rows || 0}${n.review_queued ? ` review=${n.review_queued}` : ''}`
        + `${run.assertion_failures.length ? ` notes=${run.assertion_failures.length}` : ''}`);
    }
    console.log(`[${SERVICE}] END status=${status} events_new=${run.events_new} bouts_new=${run.bouts_new}`);
  }
  return { status, ...run };
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
  const boutRows = await selectAll(env, 'ufc_bouts', 'select=id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,status,weight_class');
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
  const results = await selectAll(env, 'ufc_bout_results', 'select=bout_id,has_stats');
  return {
    resolver, byEspnAthlete, byUfcstatsFighter,
    fightersById: new Map(fighters.map((f) => [f.id, f])),
    events, eventsByEspn: new Map(events.filter((e) => e.espn_event_id).map((e) => [e.espn_event_id, e])),
    bouts: boutRows, boutsByEspn: new Map(boutRows.filter((b) => b.espn_competition_id).map((b) => [b.espn_competition_id, b])),
    resultsByBout: new Map(results.map((r) => [r.bout_id, r])),
    reviewQueued: 0,
  };
}

function registerFighter(ctx, row) {
  ctx.fightersById.set(row.id, row);
  if (row.espn_athlete_id) ctx.byEspnAthlete.set(row.espn_athlete_id, row);
  if (row.ufcstats_id) ctx.byUfcstatsFighter.set(row.ufcstats_id, row);
  ctx.resolver.add({ id: row.id, ufcstats_id: row.ufcstats_id, name: row.name, nickname: row.nickname, dob: row.dob,
    record: row.record_w == null ? null : `${row.record_w}-${row.record_l}-${row.record_d}`, weight_classes: [], aliases: [] });
}

async function queueReview(env, ctx, res, rawName, source, extra) {
  const row = res.review_row || { raw_name: rawName, source, candidate_fighter_ids: [], context: {} };
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
      const referee = await espn.referee(b.officials_ref);
      await upsert(env, 'ufc_bout_results', {
        bout_id: saved.id, winner_id: winnerRow?.id || null, method, method_raw: b.result.method_raw,
        round: b.result.round, time_sec: b.result.time ? mmssToSec(b.result.time, b.source_url) : null,
        time_format: b.time_format, referee, finish_detail: b.result.finish_detail,
        has_stats: prior?.has_stats || false, result_source: prior?.has_stats ? 'ufcstats' : 'espn',
        source_url: b.source_url, captured_at: nowIso(),
      }, 'bout_id');
      ctx.resultsByBout.set(saved.id, { bout_id: saved.id, has_stats: prior?.has_stats || false });
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

async function ufcstatsPass(env, fetcher, ctx, run) {
  const url = `${fetcher.base}/statistics/events/completed?page=all`;
  const { html } = await fetcher.get('lists', 'completed', url, { refresh: true });
  const completed = P.parseEventList(html, url);
  run.notes.ufcstats_completed_listed = completed.length;
  const maxEvents = Number(env.MAX_EVENTS_PER_RUN || 3);
  /* Forward maintenance only. Without a recency bound this loop walks the
   * entire completed list and will happily start reconstructing 1990s cards
   * three at a time, competing with the detached Wayback backfill over the
   * same rows. The scheduled worker's job is narrower: stop newly completed
   * events from creating new gaps. History stays with the backfill queue. */
  const forwardDays = Number(env.UFCSTATS_FORWARD_DAYS || 45);
  const cutoff = new Date(Date.now() - forwardDays * 86400000).toISOString().slice(0, 10);
  run.notes.ufcstats_forward_cutoff = cutoff;
  let skippedHistorical = 0;
  const targets = [];
  for (const e of completed) {
    if (ctx.events.some((x) => x.ufcstats_id === e.ufcstats_id)) continue;
    if (!e.event_date || e.event_date < cutoff) { skippedHistorical += 1; continue; }
    const cands = ctx.events.filter((x) => !x.ufcstats_id && x.event_date && dayDiff(x.event_date, e.event_date) <= 1);
    if (cands.length === 1) targets.push({ listed: e, event: cands[0] });
    else if (cands.length > 1) run.assertion_failures.push({ class: 'EventMatchAmbiguous', url, detail: `${e.name} ${e.event_date} matches ${cands.length} ESPN events`, at: nowIso() });
    if (targets.length >= maxEvents) break;
  }
  run.notes.ufcstats_events_targeted = targets.length;
  run.notes.ufcstats_skipped_historical = skippedHistorical;
  let roundRows = 0;
  for (const { listed, event } of targets) {
    const evUrl = fetcher.url('events', listed.ufcstats_id);
    const { html: evHtml } = await fetcher.get('events', listed.ufcstats_id, evUrl, { refresh: true });
    const page = P.parseEventPage(evHtml, evUrl);
    await patch(env, 'ufc_events', `id=eq.${event.id}`, { ufcstats_id: listed.ufcstats_id, location_raw: page.location_raw || null, updated_at: nowIso() });
    event.ufcstats_id = listed.ufcstats_id;
    const eventBouts = ctx.bouts.filter((b) => b.event_id === event.id);
    for (const b of page.bouts) {
      if (!b.ufcstats_id) continue;
      const fa = await linkUfcstatsFighter(env, fetcher, ctx, run, b.fighter_a_ufcstats_id, b.fighter_a_name, evUrl);
      const fb = await linkUfcstatsFighter(env, fetcher, ctx, run, b.fighter_b_ufcstats_id, b.fighter_b_name, evUrl);
      if (!fa || !fb) { run.notes.bouts_unlinked = (run.notes.bouts_unlinked || 0) + 1; continue; }
      const bout = eventBouts.find((x) => (x.fighter_a_id === fa.id && x.fighter_b_id === fb.id) || (x.fighter_a_id === fb.id && x.fighter_b_id === fa.id));
      if (!bout) { run.assertion_failures.push({ class: 'BoutNotOnEspnCard', url: evUrl, detail: `ufcstats fight ${b.ufcstats_id} (${b.fighter_a_name} v ${b.fighter_b_name}) has no ESPN bout`, at: nowIso() }); continue; }
      const fUrl = fetcher.url('fights', b.ufcstats_id);
      const { html: fHtml } = await fetcher.get('fights', b.ufcstats_id, fUrl, { refresh: true });
      /* An event can appear on the completed list while a bout on it still
       * serves the pre-fight matchup preview. That page states no winner,
       * method or rounds, so it is a coverage gap to retry next run, not a
       * schema violation that should abort the pass. */
      if (P.isPreResultFightPage(fHtml)) {
        run.notes.fight_preview_pages = (run.notes.fight_preview_pages || 0) + 1;
        continue;
      }
      const f = P.parseFightPage(fHtml, fUrl);
      await patch(env, 'ufc_bouts', `id=eq.${bout.id}`, { ufcstats_id: b.ufcstats_id, scheduled_rounds: f.scheduled_rounds ?? undefined, updated_at: nowIso() });
      bout.ufcstats_id = b.ufcstats_id;
      const idFor = (usid) => (usid === fa.ufcstats_id ? fa.id : fb.id);
      if (f.rounds.length) {
        await upsert(env, 'ufc_bout_round_stats', f.rounds.map(({ fighter_ufcstats_id, ...r }) => ({
          ...r, bout_id: bout.id, fighter_id: idFor(fighter_ufcstats_id), source_url: fUrl, captured_at: nowIso(),
        })), 'bout_id,fighter_id,round');
        roundRows += f.rounds.length;
      }
      const prior = ctx.resultsByBout.get(bout.id);
      if (prior) {
        await patch(env, 'ufc_bout_results', `bout_id=eq.${bout.id}`, {
          has_stats: f.has_stats, scorecards: f.scorecards ?? undefined,
          judge_1: f.scorecards?.[0]?.judge, judge_2: f.scorecards?.[1]?.judge, judge_3: f.scorecards?.[2]?.judge,
          referee: f.referee ?? undefined,
        });
      } else {
        run.assertion_failures.push({ class: 'StatsBeforeResult', url: fUrl, detail: `round stats arrived before an ESPN result for bout ${bout.id}`, at: nowIso() });
      }
    }
  }
  run.notes.round_rows = roundRows;
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
