/* ufc-stats-ingest — nightly incremental UFC Stats -> Supabase.
 *
 * Steps (kickoff brief):
 *   1. completed list -> events not in ufc_events (cap MAX_EVENTS_PER_RUN)
 *   2. per new event: event page -> bouts -> fight pages -> results + round
 *      stats -> refresh both fighter pages
 *   3. upcoming list every run: seed announced events/bouts; an announced
 *      bout that vanished is noted in ufc_ingest_runs.assertion_failures
 *      (Phase 2 card watcher does real change tracking)
 *   4. card_status='complete' once every bout on the event has a result
 *   5. one ufc_ingest_runs row per run; Discord one-liner on success, loud
 *      message on assertion failure
 *
 * Fails loudly: any SchemaAssertionError or AccessGateError aborts the run,
 * marks it failed, and nothing partial is silently left behind — writes are
 * per-event and the event is only marked complete after all its fights
 * landed, so a re-run resumes cleanly.
 */

import { select, selectAll, insert, upsert, patch } from './supabase.mjs';
import { discord } from './discord.mjs';
import { Fetcher, SchemaAssertionError, AccessGateError } from './ufcstats.mjs';
import * as P from './parsers.mjs';
import { normWeightClass } from './normalizers.mjs';
import { aliasRowsForFighter } from './shared/alias_resolver.mjs';

const SERVICE = 'ufc-stats-ingest';
const VERSION = 'v0.1.0';

const health = { last_cron_run: null, last_result: null, last_error_class: null };

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

const nowIso = () => new Date().toISOString();

async function runIngest(env) {
  health.last_cron_run = nowIso();
  console.log(`[${SERVICE}] START ${health.last_cron_run}`);
  const run = { events_new: 0, bouts_new: 0, fighters_touched: 0, assertion_failures: [], notes: {} };
  let runId = null;
  let status = 'success';
  try {
    const created = await insert(env, 'ufc_ingest_runs', { worker: SERVICE, status: 'running' });
    runId = created?.[0]?.id || null;

    const ctx = await loadContext(env);
    const fetcher = new Fetcher(env);
    const maxEvents = Number(env.MAX_EVENTS_PER_RUN || 3);

    /* 1. completed list */
    const completedUrl = `${fetcher.base}/statistics/events/completed?page=all`;
    const { html: completedHtml } = await fetcher.get('lists', 'completed', completedUrl, { refresh: true });
    const completed = P.parseEventList(completedHtml, completedUrl);
    const newEvents = completed.filter((e) => !ctx.events.has(e.ufcstats_id));
    run.notes.completed_listed = completed.length;
    run.notes.completed_new = newEvents.length;
    const todo = newEvents.slice(0, maxEvents);
    if (newEvents.length > maxEvents) run.notes.deferred_events = newEvents.length - maxEvents;

    /* 2. per new event */
    for (const e of todo) {
      await ingestEvent(env, fetcher, ctx, e, run);
    }

    /* 2b. previously announced events whose date has passed: promote if UFC Stats now has results */
    for (const ev of ctx.pendingAnnounced.slice(0, Math.max(0, maxEvents - todo.length))) {
      if (completed.some((c) => c.ufcstats_id === ev.ufcstats_id)) {
        await ingestEvent(env, fetcher, ctx, completed.find((c) => c.ufcstats_id === ev.ufcstats_id), run);
      }
    }

    /* 3. upcoming list */
    await ingestUpcoming(env, fetcher, ctx, run);

    run.notes.fetched = fetcher.fetched;
    run.notes.subrequests = fetcher.subrequests;
  } catch (e) {
    status = 'failed';
    const cls = e?.name || 'Error';
    health.last_error_class = cls;
    const detail = String(e?.message || e).slice(0, 400);
    run.assertion_failures.push({ class: cls, url: e?.url || null, detail, at: nowIso() });
    console.error(`[${SERVICE}] ${cls}: ${detail}`);
    if (e instanceof SchemaAssertionError || e instanceof AccessGateError) {
      await discord(env, `**${SERVICE} STOPPED** ${cls}\n\`${detail}\`\n${e.url || ''}`, { loud: true });
    } else {
      await discord(env, `**${SERVICE} CRASHED** ${cls}: ${detail}`, { loud: true });
    }
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
        + `${n.deferred_events ? ` deferred=${n.deferred_events}` : ''}`
        + `${run.assertion_failures.length ? ` notes=${run.assertion_failures.length}` : ''}`);
    }
    console.log(`[${SERVICE}] END status=${status} events_new=${run.events_new} bouts_new=${run.bouts_new}`);
  }
  return { status, ...run };
}

/* ufcstats_id -> uuid maps. Fighters can be ~4.5k rows; paginated. */
async function loadContext(env) {
  const fighters = new Map();
  const detailed = new Set();
  for (const r of await selectAll(env, 'ufc_fighters', 'select=id,ufcstats_id,dob')) {
    fighters.set(r.ufcstats_id, r.id);
    if (r.dob) detailed.add(r.ufcstats_id);
  }
  const events = new Map();
  const pendingAnnounced = [];
  for (const r of await selectAll(env, 'ufc_events', 'select=id,ufcstats_id,card_status,event_date')) {
    events.set(r.ufcstats_id, r);
    if (r.card_status !== 'complete' && r.event_date && r.event_date < nowIso().slice(0, 10)) pendingAnnounced.push(r);
  }
  const bouts = new Map();
  for (const r of await selectAll(env, 'ufc_bouts', 'select=id,ufcstats_id,event_id,status&ufcstats_id=not.is.null')) {
    bouts.set(r.ufcstats_id, r);
  }
  return { fighters, detailed, events, bouts, pendingAnnounced };
}

function eventRow(e, base) {
  const parts = String(e.location_raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    ufcstats_id: e.ufcstats_id, name: e.name, event_date: e.event_date,
    city: parts[0] || null, region: parts.length >= 3 ? parts[1] : null, country: parts.length >= 2 ? parts[parts.length - 1] : null,
    location_raw: e.location_raw || null,
    source_url: `${base}/event-details/${e.ufcstats_id}`, captured_at: nowIso(), updated_at: nowIso(),
  };
}

async function ensureFighters(env, ctx, bouts, sourceUrl, run) {
  const missing = [];
  for (const b of bouts) {
    for (const side of ['a', 'b']) {
      const id = b[`fighter_${side}_ufcstats_id`];
      if (!ctx.fighters.has(id) && !missing.some((m) => m.ufcstats_id === id)) {
        missing.push({ ufcstats_id: id, name: b[`fighter_${side}_name`], source_url: sourceUrl, captured_at: nowIso(), updated_at: nowIso() });
      }
    }
  }
  if (!missing.length) return;
  const rows = await upsert(env, 'ufc_fighters', missing, 'ufcstats_id', { returning: 'representation' });
  for (const r of rows) ctx.fighters.set(r.ufcstats_id, r.id);
  run.fighters_touched += rows.length;
}

async function ingestEvent(env, fetcher, ctx, listed, run) {
  const url = fetcher.url('events', listed.ufcstats_id);
  const { html } = await fetcher.get('events', listed.ufcstats_id, url, { refresh: true });
  const page = P.parseEventPage(html, url);

  const [evRow] = await upsert(env, 'ufc_events', { ...eventRow({ ...listed, ...page }, fetcher.base), card_status: 'locked' }, 'ufcstats_id', { returning: 'representation' });
  if (!ctx.events.has(listed.ufcstats_id)) run.events_new += 1;
  ctx.events.set(listed.ufcstats_id, evRow);

  await ensureFighters(env, ctx, page.bouts, url, run);
  const boutRows = page.bouts.map((b) => {
    const wc = normWeightClass(b.weight_class_raw, url);
    return {
      ufcstats_id: b.ufcstats_id || null, event_id: evRow.id,
      fighter_a_id: ctx.fighters.get(b.fighter_a_ufcstats_id), fighter_b_id: ctx.fighters.get(b.fighter_b_ufcstats_id),
      weight_class: wc.weight_class, weight_class_raw: b.weight_class_raw, is_womens: wc.is_womens, is_title: wc.is_title,
      bout_order: b.bout_order, status: 'complete', source_url: url, captured_at: nowIso(), updated_at: nowIso(),
    };
  });
  const before = boutRows.filter((r) => r.ufcstats_id && !ctx.bouts.has(r.ufcstats_id)).length;
  const written = await upsert(env, 'ufc_bouts', boutRows, 'ufcstats_id', { returning: 'representation' });
  for (const r of written) if (r.ufcstats_id) ctx.bouts.set(r.ufcstats_id, r);
  run.bouts_new += before;

  let allResults = true;
  for (const b of page.bouts) {
    if (!b.ufcstats_id) { allResults = false; continue; }
    await ingestFight(env, fetcher, ctx, b.ufcstats_id, run);
  }
  if (allResults) {
    await patch(env, 'ufc_events', `id=eq.${evRow.id}`, { card_status: 'complete', updated_at: nowIso() });
    ctx.events.get(listed.ufcstats_id).card_status = 'complete';
  }
  console.log(`[${SERVICE}] event ${listed.ufcstats_id} bouts=${page.bouts.length} complete=${allResults}`);
}

async function ingestFight(env, fetcher, ctx, fightId, run) {
  const url = fetcher.url('fights', fightId);
  const { html } = await fetcher.get('fights', fightId, url, { refresh: true });
  const f = P.parseFightPage(html, url);
  const bout = ctx.bouts.get(fightId);
  if (!bout) throw new SchemaAssertionError(url, 'fight page for a bout that is not in ufc_bouts');
  const winner = f.fighters.find((x) => x.flag === 'WIN');
  const sc = f.scorecards || [];
  await upsert(env, 'ufc_bout_results', {
    bout_id: bout.id, winner_id: winner ? ctx.fighters.get(winner.ufcstats_id) : null,
    method: f.method, method_raw: f.method_raw, round: f.round, time_sec: f.time_sec, time_format: f.time_format,
    referee: f.referee, judge_1: sc[0]?.judge || null, judge_2: sc[1]?.judge || null, judge_3: sc[2]?.judge || null,
    scorecards: f.scorecards, finish_detail: f.finish_detail, has_stats: f.has_stats, source_url: url, captured_at: nowIso(),
  }, 'bout_id');
  await patch(env, 'ufc_bouts', `id=eq.${bout.id}`, { scheduled_rounds: f.scheduled_rounds, is_title: f.is_title, status: 'complete', updated_at: nowIso() });
  if (f.rounds.length) {
    await upsert(env, 'ufc_bout_round_stats', f.rounds.map(({ fighter_ufcstats_id, ...r }) => ({
      ...r, bout_id: bout.id, fighter_id: ctx.fighters.get(fighter_ufcstats_id), source_url: url, captured_at: nowIso(),
    })), 'bout_id,fighter_id,round');
  }
  for (const x of f.fighters) await refreshFighter(env, fetcher, ctx, x.ufcstats_id, run);
}

async function refreshFighter(env, fetcher, ctx, fighterId, run) {
  const url = fetcher.url('fighters', fighterId);
  const { html } = await fetcher.get('fighters', fighterId, url, { refresh: true });
  const p = P.parseFighterPage(html, url);
  const [row] = await upsert(env, 'ufc_fighters', { ...p, source_url: url, captured_at: nowIso(), updated_at: nowIso() }, 'ufcstats_id', { returning: 'representation' });
  ctx.fighters.set(fighterId, row.id);
  ctx.detailed.add(fighterId);
  run.fighters_touched += 1;
  await upsert(env, 'ufc_fighter_aliases', aliasRowsForFighter(row.id, p.name, p.nickname), 'fighter_id,source,normalized');
}

async function ingestUpcoming(env, fetcher, ctx, run) {
  const url = `${fetcher.base}/statistics/events/upcoming`;
  const { html } = await fetcher.get('lists', 'upcoming', url, { refresh: true });
  const upcoming = P.parseEventList(html, url);
  run.notes.upcoming_listed = upcoming.length;
  const seenBoutIds = new Set();
  for (const e of upcoming) {
    const existing = ctx.events.get(e.ufcstats_id);
    if (existing?.card_status === 'complete') continue;
    const evUrl = fetcher.url('events', e.ufcstats_id);
    const { html: evHtml } = await fetcher.get('events', e.ufcstats_id, evUrl, { refresh: true });
    const page = P.parseEventPage(evHtml, evUrl);
    const [evRow] = await upsert(env, 'ufc_events', { ...eventRow({ ...e, ...page }, fetcher.base), card_status: 'announced' }, 'ufcstats_id', { returning: 'representation' });
    if (!existing) run.events_new += 1;
    ctx.events.set(e.ufcstats_id, evRow);
    await ensureFighters(env, ctx, page.bouts, evUrl, run);
    const rows = page.bouts.map((b) => {
      const wc = normWeightClass(b.weight_class_raw, evUrl);
      if (b.ufcstats_id) seenBoutIds.add(b.ufcstats_id);
      return {
        ufcstats_id: b.ufcstats_id || null, event_id: evRow.id,
        fighter_a_id: ctx.fighters.get(b.fighter_a_ufcstats_id), fighter_b_id: ctx.fighters.get(b.fighter_b_ufcstats_id),
        weight_class: wc.weight_class, weight_class_raw: b.weight_class_raw, is_womens: wc.is_womens, is_title: wc.is_title,
        bout_order: b.bout_order, status: 'announced', source_url: evUrl, captured_at: nowIso(), updated_at: nowIso(),
      };
    });
    const before = rows.filter((r) => r.ufcstats_id && !ctx.bouts.has(r.ufcstats_id)).length;
    const written = await upsert(env, 'ufc_bouts', rows.filter((r) => r.ufcstats_id), 'ufcstats_id', { returning: 'representation' });
    for (const r of written) ctx.bouts.set(r.ufcstats_id, r);
    run.bouts_new += before;
    /* announced bouts on this event that are no longer listed */
    for (const [id, b] of ctx.bouts) {
      if (b.event_id === evRow.id && b.status === 'announced' && !seenBoutIds.has(id)) {
        run.assertion_failures.push({ class: 'AnnouncedBoutVanished', url: evUrl, detail: `bout ${id} no longer on upcoming card`, at: nowIso() });
      }
    }
  }
}
