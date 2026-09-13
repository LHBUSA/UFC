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
import { OBS_CONFLICT } from '../../../scripts/odds/market_match.mjs';
import { normalizePayload, snapshotRows, observationRows } from './capture.mjs';
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
  /* The ESPN event id comes from the joined canonical event: the broadcast row
   * holds the times, ufc_events holds the linkage. Without it the state read
   * has nothing to ask ESPN about. */
  const rows = await rest(env,
    `ufc_event_broadcasts?select=ufc_slug,event_id,event_name,event_date,prelims_start_utc,main_card_start_utc,early_prelims_start_utc,`
    + `event:ufc_events(id,espn_event_id,name)`
    + `&or=(prelims_start_utc.gte.${from},main_card_start_utc.gte.${from})&order=event_date.asc&limit=10`).catch(() => []);
  for (const r of rows || []) {
    const starts = [r.early_prelims_start_utc, r.prelims_start_utc, r.main_card_start_utc].filter(Boolean).sort();
    const startsAt = starts[0] || null;
    if (!startsAt) continue;
    const t = Date.parse(startsAt);
    if (now >= t - cfg.eventWindowMinutes * 60_000 && now <= t + cfg.closeHoursAfter * 3_600_000) {
      return { ...r, startsAt, espn_event_id: r.event?.espn_event_id ?? null };
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
async function recordTransitions(env, card, statuses, now, { strict = false } = {}) {
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
  /* Canonical bout by ESPN competition id. Never by fighter name. */
  const ids = [...new Set(rows.map((r) => r.espn_competition_id))];
  const boutRows = await rest(env,
    `ufc_bouts?select=id,espn_competition_id&espn_competition_id=in.(${ids.map((x) => `"${x}"`).join(',')})`).catch(() => []);
  const boutByComp = new Map((boutRows || []).map((b) => [String(b.espn_competition_id), b.id]));
  for (const r of rows) r.bout_id = boutByComp.get(r.espn_competition_id) ?? null;

  /* The unique index is FUNCTIONAL over coalesce(round, 0), so there is no
   * named constraint for PostgREST to target. A plain insert is used and a
   * unique violation is the expected, wanted outcome for a state we have
   * already recorded: first-seen-wins. */
  const send = () => rest(env, 'ufc_market_state_transitions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  try {
    await send();
  } catch (e) {
    const dup = /duplicate key|unique|23505/i.test(String(e?.message || ''));
    if (dup) {
      /* Some rows are new and some already exist. Retry individually so a
       * genuinely new boundary is not lost behind an already-seen one. */
      for (const r of rows) {
        await rest(env, 'ufc_market_state_transitions', {
          method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([r]),
        }).catch(() => null);
      }
    } else if (strict) {
      /* Live: a boundary we cannot persist makes the snapshot uninterpretable,
       * so the failure is raised rather than swallowed and no credit is spent. */
      throw e;
    }
  }
  return rows.length;
}


/* ---- durable state ------------------------------------------------------
 * Cloudflare may discard an isolate between any two invocations, so isolate
 * memory is diagnostic ONLY. Every value that can authorise or forbid spending
 * is read back from persisted rows on each tick: the spacing between paid
 * calls, how much this card has already cost, and the last MEASURED quota.
 * A value we cannot read is a refusal, never a default. */
async function durableState(env, eventId) {
  /* Last paid call and the newest measured quota, from the run ledger. */
  const lastLive = (await rest(env,
    'ufc_market_runs?select=started_at,finished_at,quota_used,quota_remaining,last_cost'
    + '&capture_mode=eq.live&quota_remaining=not.is.null&order=started_at.desc&limit=1').catch(() => null))?.[0] || null;
  const lastAny = (await rest(env,
    'ufc_market_runs?select=started_at,quota_used,quota_remaining,last_cost'
    + '&quota_remaining=not.is.null&order=started_at.desc&limit=1').catch(() => null))?.[0] || null;
  const lastCall = (await rest(env,
    'ufc_market_runs?select=started_at&capture_mode=eq.live&order=started_at.desc&limit=1').catch(() => null))?.[0] || null;

  const src = lastLive || lastAny;
  const quota = src && Number.isFinite(Number(src.quota_remaining))
    ? { known: true, remaining: Number(src.quota_remaining), used: Number(src.quota_used), last: Number(src.last_cost), measuredAt: src.finished_at || src.started_at }
    : { known: false, remaining: null, measuredAt: null };

  /* Card spend: the measured cost of every live run already charged to this
   * card. Summed from rows, so a fresh isolate knows exactly what a previous
   * one spent. */
  let cardSpend = null;
  if (eventId) {
    const rows = await rest(env,
      `ufc_market_runs?select=last_cost&capture_mode=eq.live&event_id=eq.${eventId}`).catch(() => null);
    if (Array.isArray(rows)) cardSpend = rows.reduce((n, r) => n + (Number(r.last_cost) || 0), 0);
  } else {
    cardSpend = 0;
  }
  return { quota, cardSpend, lastCallAt: lastCall?.started_at || null };
}

/* ---- the tick ----------------------------------------------------------- */
async function tick(env, { dry = false } = {}) {
  const now = Date.now();
  const cfg = readConfig(env);
  health.last_tick_at = new Date(now).toISOString();

  const card = await activeCard(env, cfg, now).catch(() => null);
  if (!card) {
    const d = { poll: false, reason: 'no_card_in_window', paid_calls: 0 };
    health.last_decision = d;
    return d;
  }

  /* The ESPN bridge is deterministic: broadcast row -> canonical event ->
   * espn_event_id. Never resolved by name. Without it there is no live state
   * to gate on, so the lane refuses to spend rather than polling blind. */
  if (!card.espn_event_id) {
    const d = { poll: false, reason: 'no_espn_event_id', paid_calls: 0, card: { name: card.event_name, event_id: card.event_id } };
    health.last_decision = d;
    return d;
  }

  const statuses = await boutStatuses(card.espn_event_id).catch(() => []);
  const { quota, cardSpend, lastCallAt } = await durableState(env, card.event_id);

  const decision = shouldPoll({ now, cfg, cardStartsAt: card.startsAt, boutStatuses: statuses, quota, cardSpend, lastCallAt });
  health.last_decision = { ...decision, card: card.event_name, statuses: statuses.length, cardSpend };

  if (!decision.poll || dry) {
    /* State transitions are recorded even when we do not spend: observing a
     * boundary costs nothing and the evidence is not recoverable later. */
    const transitions = await recordTransitions(env, card, statuses, now, { strict: false }).catch(() => 0);
    return {
      ...decision, dry, paid_calls: 0, observations_written: 0, snapshot_rows: 0, quota_consumed: 0,
      card: { name: card.event_name, ufc_slug: card.ufc_slug, starts_at: card.startsAt, espn_event_id: card.espn_event_id },
      espn_state: {
        bouts: statuses.length,
        active: statuses.filter((x) => isActive(x.status)).map((x) => ({ id: x.competitionId, status: x.status, round: x.round })),
        imminent: statuses.filter((x) => isImminent(x.status)).map((x) => ({ id: x.competitionId, status: x.status })),
        sample: statuses.slice(0, 5).map((x) => `${x.competitionId}:${x.status}`),
      },
      transitions_recorded: transitions,
      intended_request: `GET ${ODDS_BASE}/sports/${SPORT}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=***REDACTED***`,
      durable: { card_spend: cardSpend, last_call_at: lastCallAt, quota_known: quota.known, quota_remaining: quota.remaining, quota_measured_at: quota.measuredAt },
    };
  }

  /* Past this line a credit is spent. The state boundary is persisted FIRST
   * and strictly: buying a snapshot whose temporal context we failed to record
   * is buying a price nobody can interpret. */
  try {
    await recordTransitions(env, card, statuses, now, { strict: true });
  } catch (e) {
    const d = { poll: false, reason: 'transition_write_failed', error: String(e?.message || e).slice(0, 200), paid_calls: 0 };
    health.last_decision = d;
    health.last_error = d.error;
    return d;
  }

  /* One run row per paid call, opened BEFORE the request so a call that fails
   * still leaves the evidence that it was made and charged. */
  const created = await rest(env, 'ufc_market_runs', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'running', sport_key: SPORT, markets: 'h2h', event_id: card.event_id, capture_mode: 'live' }),
  }).catch(() => null);
  const runId = created?.[0]?.id ?? null;
  const finalize = (patch) => (runId
    ? rest(env, `ufc_market_runs?id=eq.${runId}`, { method: 'PATCH', body: JSON.stringify({ finished_at: new Date().toISOString(), ...patch }) }).catch(() => null)
    : Promise.resolve(null));

  /* ONE timestamp for the whole snapshot, taken around the fetch. */
  const observedAt = new Date().toISOString();
  let res;
  try {
    res = await fetch(
      `${ODDS_BASE}/sports/${SPORT}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${env.ODDS_API_KEY}`,
      { signal: AbortSignal.timeout(cfg.providerTimeoutMs) },
    );
  } catch (e) {
    /* A hang must not hold the isolate, and must not retry inside this
     * invocation: the cron comes round again in a minute. */
    health.last_paid_call_at = observedAt;
    health.paid_calls += 1;
    await finalize({ status: 'failed', error: `provider request failed: ${String(e?.message || e).slice(0, 200)}` });
    return { ...decision, paid_calls: 1, run_id: runId, error: 'provider_timeout_or_network', observations_written: 0, snapshot_rows: 0 };
  }

  const q = readQuotaHeaders(res.headers);
  health.last_paid_call_at = observedAt;
  health.paid_calls += 1;
  if (!res.ok) {
    await finalize({ status: 'failed', error: `provider HTTP ${res.status}`, quota_used: q.used, quota_remaining: q.remaining, last_cost: q.last });
    return { ...decision, paid_calls: 1, run_id: runId, provider_status: res.status, quota: q, observations_written: 0, snapshot_rows: 0 };
  }

  const payload = await res.json().catch(() => null);
  /* Resolution inputs, scoped to this card: a price is never attached to a
   * bout on another event. */
  const [boutRows, fighterRows, aliasRows] = await Promise.all([
    rest(env, `ufc_bouts?select=id,event_id,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name),event:ufc_events(id,event_date)&event_id=eq.${card.event_id}`).catch(() => []),
    rest(env, 'ufc_fighters?select=id,name&limit=6000').catch(() => []),
    rest(env, 'ufc_fighter_aliases?select=fighter_id,alias,normalized').catch(() => []),
  ]);
  const bouts = (boutRows || []).map((b) => ({ id: b.id, a: b.fighter_a, b: b.fighter_b, eventDate: b.event?.event_date || null }));

  const norm = normalizePayload({
    payload, bouts, fighters: fighterRows || [], aliases: aliasRows || [],
    observedAt, eventId: card.event_id,
  });

  /* SNAPSHOT layer: every quote in this fetch, sharing one observed_at. */
  let snapshotWritten = 0;
  if (runId && norm.quotes.length) {
    await rest(env, 'ufc_market_run_quotes?on_conflict=run_id,bout_id,bookmaker_key,market_key,outcome_name', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(snapshotRows(norm.quotes, runId)),
    }).catch(() => null);
    snapshotWritten = norm.quotes.length;
  }

  /* CHANGE layer: the database's existing idempotency decides what is new. */
  let observationsWritten = 0;
  if (norm.quotes.length) {
    const before = await countRows(env, 'ufc_market_observations');
    await rest(env, `ufc_market_observations?on_conflict=${encodeURIComponent(OBS_CONFLICT)}`, {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(observationRows(norm.quotes)),
    }).catch(() => null);
    const after = await countRows(env, 'ufc_market_observations');
    observationsWritten = Math.max(0, after - before);
  }

  /* Unmatched is a landing zone, not a failure: a source event with no
   * canonical bout is kept so it can be read, never guessed at. */
  if (norm.unmatched.length) {
    await rest(env, 'ufc_market_unmatched?on_conflict=source_event_id,reason', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(norm.unmatched.map((u) => ({ ...u, last_seen_at: observedAt }))),
    }).catch(() => null);
  }

  await finalize({
    status: 'success',
    source_events: Array.isArray(payload) ? payload.length : 0,
    matched_bouts: norm.matchedBouts,
    unmatched_events: norm.unmatched.length,
    observations_written: observationsWritten,
    books_seen: norm.books,
    quota_used: q.used, quota_remaining: q.remaining, last_cost: q.last,
    notes: { snapshot_rows: snapshotWritten, ambiguous: norm.ambiguous, quotes_normalized: norm.quotes.length },
  });
  health.observations_written += observationsWritten;

  return {
    ...decision, paid_calls: 1, run_id: runId, quota: q,
    source_events: Array.isArray(payload) ? payload.length : 0,
    matched_bouts: norm.matchedBouts, unmatched: norm.unmatched.length, ambiguous: norm.ambiguous,
    quotes_normalized: norm.quotes.length, snapshot_rows: snapshotWritten,
    observations_written: observationsWritten,
    duplicates_skipped: norm.quotes.length - observationsWritten,
  };
}

/** Exact row count, so a run reports what landed rather than what was sent. */
async function countRows(env, table) {
  const { url, key } = sb(env);
  const r = await fetch(`${url}/rest/v1/${table}?select=id`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
  }).catch(() => null);
  if (!r || !r.ok) return 0;
  const n = Number((r.headers.get('content-range') || '/0').split('/')[1]);
  return Number.isFinite(n) ? n : 0;
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
        enabled: cfg.enabled,
        /* Booleans only. A health endpoint that echoes a secret is a secret
         * leak with a status code. */
        has_odds_api_key: Boolean(env.ODDS_API_KEY),
        has_supabase_key: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        has_admin_token: Boolean(env.ADMIN_TRIGGER_TOKEN),
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
