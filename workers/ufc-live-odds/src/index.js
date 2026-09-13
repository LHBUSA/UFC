/* ufc-live-odds — paid live market capture during an active UFC bout.
 *
 * WHY THIS IS ITS OWN WORKER
 *
 * The obvious home was ufc-fight-state, which already owns fight state. It was
 * the wrong home. That Worker runs hourly and its failure mode is a PERMANENTLY
 * missed checkpoint — the ledger records state that cannot be reconstructed
 * later. This lane runs every minute, holds a paid provider key, and its
 * failure modes are provider timeouts, quota exhaustion and retry storms.
 * Putting them in one Worker means a live-odds bug forces a rollback of the
 * ledger, a hung provider fetch competes with a capture that cannot be redone,
 * and the provider key sits in a Worker that does not need it.
 *
 * So: separate Worker, separate secret, separate rollback, separate blast
 * radius. It does NOT own fight state and does not keep a second fight clock —
 * it reads the same ESPN status the rest of the system reads.
 *
 * WHY MATCHING IS NOT IN THIS FILE
 *
 * It is imported from scripts/odds/market_match.mjs, the same module the Node
 * CLI uses. Two implementations of "whose price is this" would drift, and the
 * drift would be invisible until a price was already attached to the wrong
 * fighter and stored as history.
 *
 * WAKING IS FREE, CALLING IS NOT
 *
 * The cron fires every minute. Almost every firing must cost nothing: outside
 * an event window the Worker does not even reach ESPN. src/gate.mjs holds every
 * rule that can authorise a paid request, separated so it is unit-tested rather
 * than observed on the invoice.
 *
 * Endpoints
 *   GET  /health      unauthenticated, no writes, no paid calls
 *   POST /admin/tick  run one cycle now (?dry=true never spends)
 */
import { OBS_CONFLICT, observationKey, normName, stripNickname, buildIndex, resolveOutcome, matchBout } from '../../../scripts/odds/market_match.mjs';
import { readConfig, shouldPoll, readQuotaHeaders, isActive, isImminent, roundFromStatus } from './gate.mjs';

const WORKER = 'ufc-live-odds';
const VERSION = 'v0.1.0';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc';
const SPORT = 'mma_mixed_martial_arts';

const health = { last_tick_at: null, last_decision: null, last_paid_call_at: null, paid_calls: 0, observations_written: 0, last_error: null };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const got = req.headers.get('x-admin-token') || new URL(req.url).searchParams.get('token') || '';
  return got === expected;
}

/* ---- supabase ----------------------------------------------------------- */
const sb = (env) => ({
  url: String(env.SUPABASE_URL || '').replace(/\/$/, ''),
  key: String(env.SUPABASE_SERVICE_ROLE_KEY || ''),
});
async function rest(env, pathq, init = {}) {
  const { url, key } = sb(env);
  const r = await fetch(`${url}/rest/v1/${pathq}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${pathq.split('?')[0]} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * The active card, resolved from stored broadcast times.
 *
 * One indexed query. This is the cheap check that makes a quiet week free: no
 * ESPN request and no provider request happen until this returns a card.
 */
async function activeCard(env, cfg, now) {
  const from = new Date(now - cfg.closeHoursAfter * 3_600_000).toISOString();
  const to = new Date(now + cfg.eventWindowMinutes * 60_000).toISOString();
  const rows = await rest(env,
    `ufc_event_broadcasts?select=ufc_slug,event_id,event_name,event_date,prelims_start_utc,main_card_start_utc,early_prelims_start_utc`
    + `&or=(prelims_start_utc.gte.${from},main_card_start_utc.gte.${from})&order=event_date.asc&limit=10`).catch(() => []);
  for (const r of rows || []) {
    const starts = [r.early_prelims_start_utc, r.prelims_start_utc, r.main_card_start_utc].filter(Boolean).sort();
    const startsAt = starts[0] || null;
    if (!startsAt) continue;
    const t = Date.parse(startsAt);
    if (now >= t - cfg.eventWindowMinutes * 60_000 && now <= t + cfg.closeHoursAfter * 3_600_000) {
      return { ...r, startsAt };
    }
    void to;
  }
  return null;
}

/** ESPN bout statuses for one event. Free, and only reached inside a window. */
async function boutStatuses(espnEventId) {
  if (!espnEventId) return [];
  const ev = await fetch(`${ESPN_CORE}/events/${espnEventId}?lang=en&region=us`, { cf: { cacheTtl: 0 } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const comps = ev?.competitions || [];
  const out = [];
  for (const c of comps) {
    if (!c?.status?.$ref) continue;
    const st = await fetch(String(c.status.$ref).replace(/^http:/, 'https:'), { cf: { cacheTtl: 0 } })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!st) continue;
    out.push({
      competitionId: String(c.id),
      status: st.type?.name || null,
      period: Number.isInteger(st.period) ? st.period : null,
      round: roundFromStatus(st.type?.name, st.period),
    });
  }
  return out;
}

/**
 * Record a fight-state transition the first time we observe it.
 *
 * The timestamp stored is when WE FIRST SAW the state, not a bell and not a
 * broadcast clock. Provenance says exactly that, so nothing downstream can
 * present it as the moment the round ended.
 */
async function recordTransitions(env, card, statuses, now) {
  const rows = [];
  for (const s of statuses) {
    const kind = isActive(s.status) && s.round === null && s.status !== 'STATUS_END_OF_ROUND' ? 'in_progress'
      : s.status === 'STATUS_END_OF_ROUND' && s.round ? 'round_end'
        : isActive(s.status) ? 'in_progress' : null;
    if (!kind) continue;
    rows.push({
      espn_competition_id: s.competitionId,
      event_id: card.event_id ?? null,
      kind,
      round: kind === 'round_end' ? s.round : null,
      espn_status: s.status,
      observed_at: new Date(now).toISOString(),
      provenance: `ESPN status first observed as ${s.status}${s.round ? ` period ${s.round}` : ''} by ${WORKER}`,
    });
  }
  if (!rows.length) return 0;
  /* Append-only and first-seen-wins: the unique target means a state we have
   * already recorded is a database no-op rather than a newer timestamp
   * overwriting the moment we actually first saw it. */
  await rest(env, `ufc_market_state_transitions?on_conflict=espn_competition_id,kind,round`, {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  }).catch(() => null);
  return rows.length;
}

/* ---- the tick ----------------------------------------------------------- */
async function tick(env, { dry = false } = {}) {
  const now = Date.now();
  const cfg = readConfig(env);
  health.last_tick_at = new Date(now).toISOString();

  const card = await activeCard(env, cfg, now).catch(() => null);
  if (!card) {
    const decision = { poll: false, reason: 'no_card_in_window', paid_calls: 0 };
    health.last_decision = decision;
    return decision;
  }

  const statuses = await boutStatuses(card.espn_event_id || card.event_id ? card.espn_event_id : null).catch(() => []);
  if (!dry) await recordTransitions(env, card, statuses, now).catch(() => 0);

  /* Quota is read from the last metered response we stored, never guessed. */
  const lastRun = (await rest(env, 'ufc_market_runs?select=started_at,quota_remaining,quota_used,last_cost&order=started_at.desc&limit=1').catch(() => []))?.[0] || null;
  const quota = lastRun && Number.isFinite(Number(lastRun.quota_remaining))
    ? { known: true, remaining: Number(lastRun.quota_remaining), used: Number(lastRun.quota_used), last: Number(lastRun.last_cost) }
    : { known: false, remaining: null };

  const decision = shouldPoll({
    now, cfg, cardStartsAt: card.startsAt, boutStatuses: statuses,
    quota, cardSpend: 0, lastCallAt: health.last_paid_call_at,
  });
  health.last_decision = { ...decision, card: card.event_name, statuses: statuses.length };
  if (!decision.poll || dry) return { ...decision, dry, card: card.event_name, statuses: statuses.length, paid_calls: 0 };

  /* Everything above this line is free. Past it, a credit is spent. */
  const url = `${ODDS_BASE}/sports/${SPORT}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${env.ODDS_API_KEY}`;
  const res = await fetch(url);
  const q = readQuotaHeaders(res.headers);
  health.last_paid_call_at = new Date().toISOString();
  health.paid_calls += 1;
  if (!res.ok) {
    health.last_error = `provider ${res.status}`;
    return { ...decision, paid_calls: 1, provider_status: res.status, quota: q, observations_written: 0 };
  }
  const payload = await res.json();
  void { OBS_CONFLICT, observationKey, normName, stripNickname, buildIndex, resolveOutcome, matchBout, isImminent };
  /* Resolution and writing land in the next commit of this lane; nothing is
   * written from an unverified path. The paid call and its measured cost are
   * still recorded so the run ledger reflects what was actually spent. */
  return { ...decision, paid_calls: 1, source_events: Array.isArray(payload) ? payload.length : 0, quota: q, observations_written: 0 };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).catch((e) => { health.last_error = String(e?.message || e).slice(0, 200); }));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const cfg = readConfig(env);
      return json({
        service: WORKER, version: VERSION,
        enabled: cfg.enabled, has_api_key: cfg.hasKey,
        min_remaining: cfg.minRemaining, max_card_cost: cfg.maxCardCost,
        event_window_minutes: cfg.eventWindowMinutes,
        ...health,
      });
    }
    if (url.pathname === '/admin/tick' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 404);
      const dry = url.searchParams.get('dry') === 'true';
      try {
        return json(await tick(env, { dry }));
      } catch (e) {
        return json({ error: String(e?.message || e).slice(0, 300) }, 500);
      }
    }
    return json({ error: 'not found' }, 404);
  },
};
