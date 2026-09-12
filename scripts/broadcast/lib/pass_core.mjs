/* The broadcast/start-time pass. Host-injected, so the Worker and `node --test`
 * run the SAME code over the same fixtures.
 *
 * One pass is:
 *   1. decide whether work is due (window.mjs) -- usually it is not
 *   2. fetch https://www.ufc.com/events, once, with a timeout
 *   3. parse it (parse.mjs) and refuse to write if the parse collapsed
 *   4. for each recognised row: normalize, fingerprint, compare, write
 *   5. record the run in ufc_ingest_runs
 *
 * THE RULES THAT MATTER MOST
 * --------------------------
 * A) A failed fetch writes NOTHING to ufc_event_broadcasts. Previous verified
 *    data stays exactly as it was, and only its age changes. The failure lands
 *    in the run ledger, where /health and the API's diagnostics can see it.
 * B) A collapsed parse is treated as a failed fetch. "We understood zero rows"
 *    is a markup change, not an empty schedule, and blanking a card's start
 *    time because a CSS class was renamed is the exact failure this design
 *    exists to prevent.
 * C) One malformed row is dropped and counted. It never aborts the pass and
 *    never touches the other rows.
 * D) Re-running with identical upstream content writes verified_at and nothing
 *    else -- no change rows, no last_changed_at movement. Idempotent.
 */

import {
  EVENTS_URL, PARSER, PARSER_DETAIL, parseEventsPage, parseEventTitle, isAllowedSourceUrl,
} from './parse.mjs';
import { normalizeEvent, fingerprint, diffEvent, matchLocalEvent } from './normalize.mjs';
import { planWindow } from './window.mjs';

export const WORKER = 'ufc-broadcast-schedule';
export const LOCK_ID = 'broadcast-schedule';
export const TABLE = 'ufc_event_broadcasts';
export const CHANGES_TABLE = 'ufc_event_broadcast_changes';

/* At most this many event-detail fetches in one pass, for branded names. Only
 * NEW slugs ever trigger one, so the steady state is zero; the cap bounds the
 * one pass after UFC.com publishes a batch of new cards. */
const MAX_DETAIL_FETCHES = 4;

/* How far the parse may fall before we decide the page, not the schedule,
 * changed. Cards leave the upcoming list ONE AT A TIME, as each one happens —
 * so losing half of them between two passes is a markup change, never a real
 * schedule. Rounded UP: with three known cards a parse must still find two.
 * Below two known cards the rule is not applied, because 1 -> 0 is exactly
 * what a legitimately finished last card looks like. */
const COLLAPSE_RATIO = 0.5;

const SELECT_COLS = [
  'id', 'ufc_slug', 'event_id', 'match_status', 'event_name', 'event_headline', 'event_date',
  'venue', 'city', 'region', 'country', 'location_raw',
  'early_prelims_start_utc', 'prelims_start_utc', 'main_card_start_utc',
  'broadcasts', 'ufc_event_url', 'tickets_url',
  'source', 'source_url', 'source_edition', 'parser', 'content_hash',
  'first_seen_at', 'verified_at', 'last_changed_at',
].join(',');

/** Fetch with a hard timeout and an allow-list check. Never a general proxy. */
async function fetchSource(fetchImpl, url, { timeoutMs = 15000 } = {}) {
  if (!isAllowedSourceUrl(url)) {
    return { ok: false, status: 0, url, error: 'url is not an allowed UFC.com source' };
  }
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { timeoutMs });
    const status = res?.status ?? 0;
    if (!res || !res.ok) {
      return { ok: false, status, url, ms: Date.now() - started, error: `HTTP ${status}` };
    }
    const body = await res.text();
    return { ok: true, status, url, ms: Date.now() - started, body };
  } catch (e) {
    const msg = String(e?.name === 'TimeoutError' || /timeout|aborted/i.test(String(e?.message)) ? 'timeout' : e?.message || e).slice(0, 160);
    return { ok: false, status: 0, url, ms: Date.now() - started, error: msg };
  }
}

/** Postgres-safe timestamp for a JS instant. */
const iso = (ms) => new Date(ms).toISOString();

/**
 * Run one pass.
 *
 * @param {{sb, log}} host       PostgREST client and a logger
 * @param {object}    opts
 *   write       actually persist (false = a full dry run, parse and diff only)
 *   force       ignore the cadence gate
 *   now         injectable clock
 *   fetchImpl   (url, {timeoutMs}) => Response-like
 *   trigger     free text for the ledger ("cron", "manual", "backfill")
 */
export async function runBroadcastPass({ sb, log = console }, {
  write = false, force = false, now = Date.now(), fetchImpl, trigger = 'unknown',
} = {}) {
  const startedAt = now;
  const counters = {
    parsed: 0, recognised: 0, unrecognised: 0, malformed: 0,
    inserted: 0, changed: 0, unchanged: 0, detail_fetches: 0, change_rows: 0,
  };

  /* ---- 1. is work due? ------------------------------------------------- */
  const stored = await sb.select(TABLE, `select=${SELECT_COLS}&order=main_card_start_utc.asc`);
  const byslug = new Map(stored.map((r) => [r.ufc_slug, r]));

  const lastRun = (await sb.select(
    'ufc_ingest_runs',
    `select=started_at,status&worker=eq.${WORKER}&status=eq.success&order=started_at.desc&limit=1`,
  ))[0] ?? null;

  /* The soonest card that has not run past its polling tail. */
  const futureish = stored
    .filter((r) => r.main_card_start_utc)
    .sort((a, b) => Date.parse(a.main_card_start_utc) - Date.parse(b.main_card_start_utc))
    .find((r) => Date.parse(r.main_card_start_utc) + 5 * 3600e3 > now) ?? null;

  const plan = planWindow({
    nextStartIso: futureish ? (futureish.early_prelims_start_utc || futureish.prelims_start_utc || futureish.main_card_start_utc) : null,
    mainCardIso: futureish ? futureish.main_card_start_utc : null,
    now,
    lastRunAt: force ? null : lastRun?.started_at ?? null,
  });

  if (plan.skip && !force) {
    return { status: 'skipped', plan, counters, duration_ms: Date.now() - startedAt };
  }

  /* ---- 2. fetch ------------------------------------------------------- */
  const fetched = await fetchSource(fetchImpl, EVENTS_URL);
  const diagnostics = {
    source_url: fetched.url,
    http_status: fetched.status,
    fetch_ms: fetched.ms ?? null,
    parser: PARSER,
  };

  if (!fetched.ok) {
    /* RULE A. Nothing is written to the schedule. Previous verified rows are
     * untouched and keep serving; only their age moves. */
    log.error?.(`[${WORKER}] upstream unavailable: ${fetched.error} (${fetched.url})`);
    const result = {
      status: 'upstream_failed',
      plan,
      counters,
      diagnostics: { ...diagnostics, error: fetched.error },
      preserved_rows: stored.length,
      duration_ms: Date.now() - startedAt,
    };
    if (write) await recordRun(sb, { startedAt, result, trigger, status: 'failed' });
    return result;
  }

  /* ---- 3. parse ------------------------------------------------------- */
  const parsed = parseEventsPage(fetched.body, { now });
  counters.parsed = parsed.rows;
  counters.recognised = parsed.recognised;
  counters.unrecognised = parsed.unrecognised;
  diagnostics.rows = parsed.rows;
  diagnostics.recognised = parsed.recognised;
  diagnostics.unrecognised = parsed.unrecognised;
  diagnostics.upcoming = parsed.upcoming;

  const knownUpcoming = stored.filter((r) => r.main_card_start_utc && Date.parse(r.main_card_start_utc) > now).length;
  const collapsed = !parsed.ok
    || (knownUpcoming >= 2 && parsed.upcoming < Math.ceil(knownUpcoming * COLLAPSE_RATIO));

  if (collapsed) {
    /* RULE B. Fail closed. */
    const reason = parsed.ok
      ? `parse collapsed: recognised ${parsed.upcoming} upcoming card(s), previously ${knownUpcoming}`
      : parsed.reason;
    log.error?.(`[${WORKER}] ${reason}`);
    const result = {
      status: 'parser_unrecognised',
      plan,
      counters,
      diagnostics: { ...diagnostics, error: reason },
      preserved_rows: stored.length,
      duration_ms: Date.now() - startedAt,
    };
    if (write) await recordRun(sb, { startedAt, result, trigger, status: 'failed' });
    return result;
  }

  /* ---- 4. normalize, compare, write ----------------------------------- */
  /* Our own events on the dates UFC.com just published, for the id match. One
   * query, not one per event. */
  const dates = [...new Set(parsed.events.map((e) => e.main_card_start_utc).filter(Boolean).map((s) => s.slice(0, 10)))];
  let candidates = [];
  if (dates.length) {
    const lo = dates.reduce((a, b) => (a < b ? a : b));
    const hi = dates.reduce((a, b) => (a > b ? a : b));
    /* +/- a day, because a card's UTC date and its Eastern date differ. */
    candidates = await sb.select(
      'ufc_events',
      `select=id,name,event_date&event_date=gte.${shiftDate(lo, -1)}&event_date=lte.${shiftDate(hi, 1)}`,
    ).catch(() => []);
  }

  const changesToLog = [];
  const results = [];

  for (const raw of parsed.events) {
    let rec = null;
    try {
      const previous = byslug.get(raw.ufc_slug) ?? null;

      /* The branded name costs one extra fetch and only for a slug we have
       * never seen (or whose stored name is still just the headline). */
      let brandedName = previous?.event_name ?? null;
      const needsBrand = !brandedName || brandedName === raw.event_headline;
      if (needsBrand && counters.detail_fetches < MAX_DETAIL_FETCHES) {
        counters.detail_fetches += 1;
        const detail = await fetchSource(fetchImpl, raw.ufc_event_url, { timeoutMs: 12000 });
        if (detail.ok) {
          const title = parseEventTitle(detail.body);
          if (title) brandedName = title;
        }
        /* A failed detail fetch is not a failed pass. The headline is a real
         * UFC.com string and serves perfectly well until the next run. */
      }

      rec = normalizeEvent(raw, {
        brandedName,
        sourceUrl: fetched.url,
        parser: brandedName && brandedName !== raw.event_headline ? `${PARSER}+${PARSER_DETAIL}` : PARSER,
      });
      if (!rec) { counters.malformed += 1; continue; }

      const hash = fingerprint(rec);
      const match = matchLocalEvent(rec, candidates);

      if (!previous) {
        counters.inserted += 1;
        results.push({ slug: rec.ufc_slug, state: 'new', rec, hash, match });
        changesToLog.push({ ufc_slug: rec.ufc_slug, kind: 'new', field: 'event', before_value: null, after_value: rec.event_name });
        continue;
      }

      const changes = diffEvent(previous, rec);
      if (changes.length === 0 && previous.content_hash === hash) {
        counters.unchanged += 1;
        results.push({ slug: rec.ufc_slug, state: 'unchanged', rec, hash, match, previous });
        continue;
      }
      counters.changed += 1;
      results.push({ slug: rec.ufc_slug, state: 'changed', rec, hash, match, previous, changes });
      for (const c of changes) {
        changesToLog.push({
          ufc_slug: rec.ufc_slug, kind: c.kind, field: c.field,
          before_value: c.before == null ? null : String(c.before).slice(0, 500),
          after_value: c.after == null ? null : String(c.after).slice(0, 500),
        });
      }
    } catch (e) {
      /* RULE C. This row only. */
      counters.malformed += 1;
      log.error?.(`[${WORKER}] row ${raw?.ufc_slug ?? '?'} failed to normalize: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  const verifiedAt = iso(now);

  if (write) {
    /* Unchanged rows: a single bulk PATCH of verified_at. That is the common
     * path and it must be one round trip, not one per card. */
    const unchangedSlugs = results.filter((r) => r.state === 'unchanged').map((r) => r.slug);
    if (unchangedSlugs.length) {
      await sb.patch(TABLE, `ufc_slug=in.(${unchangedSlugs.map(quoteIn).join(',')})`, { verified_at: verifiedAt, updated_at: verifiedAt });
    }

    /* New and changed rows go through upsert on the natural key. on_conflict is
     * spelled explicitly: PostgREST resolves an unspecified conflict target to
     * the PRIMARY KEY, which here is the surrogate id and would make the second
     * run die on the ufc_slug unique index. */
    const writes = results.filter((r) => r.state !== 'unchanged').map((r) => ({
      ufc_slug: r.rec.ufc_slug,
      event_id: r.match.event_id,
      match_status: r.match.match_status,
      event_name: r.rec.event_name,
      event_headline: r.rec.event_headline,
      event_date: r.rec.event_date,
      venue: r.rec.venue,
      city: r.rec.city,
      region: r.rec.region,
      country: r.rec.country,
      location_raw: r.rec.location_raw,
      early_prelims_start_utc: r.rec.early_prelims_start_utc,
      prelims_start_utc: r.rec.prelims_start_utc,
      main_card_start_utc: r.rec.main_card_start_utc,
      broadcasts: r.rec.broadcasts,
      ufc_event_url: r.rec.ufc_event_url,
      tickets_url: r.rec.tickets_url,
      source: r.rec.source,
      source_url: r.rec.source_url,
      source_edition: r.rec.source_edition,
      parser: r.rec.parser,
      content_hash: r.hash,
      first_seen_at: r.previous?.first_seen_at ?? verifiedAt,
      verified_at: verifiedAt,
      last_changed_at: verifiedAt,
      updated_at: verifiedAt,
    }));
    if (writes.length) {
      await sb.upsert(TABLE, writes, { onConflict: 'ufc_slug' });
    }

    /* Rows whose event_id match improved but whose content did not change. A
     * match is our bookkeeping, not UFC.com's content, so it must not move
     * last_changed_at. */
    for (const r of results) {
      if (r.state !== 'unchanged') continue;
      if (r.previous.event_id === r.match.event_id && r.previous.match_status === r.match.match_status) continue;
      if (!r.match.event_id && r.previous.event_id) continue; // never downgrade a good link
      await sb.patch(TABLE, `ufc_slug=eq.${encodeURIComponent(r.slug)}`, {
        event_id: r.match.event_id, match_status: r.match.match_status, updated_at: verifiedAt,
      });
    }

    if (changesToLog.length) {
      await sb.insert(CHANGES_TABLE, changesToLog.map((c) => ({ ...c, changed_at: verifiedAt })), { returning: false });
      counters.change_rows = changesToLog.length;
    }
  } else {
    counters.change_rows = changesToLog.length;
  }

  const result = {
    status: 'ok',
    plan,
    counters,
    diagnostics,
    verified_at: verifiedAt,
    changed: results.filter((r) => r.state === 'changed').map((r) => ({ slug: r.slug, fields: r.changes.map((c) => c.field) })),
    events: results.map((r) => ({ slug: r.slug, state: r.state, match: r.match.match_status })),
    write,
    duration_ms: Date.now() - startedAt,
  };
  if (write) await recordRun(sb, { startedAt, result, trigger, status: counters.malformed > 0 ? 'partial' : 'success' });
  return result;
}

function quoteIn(s) {
  return `"${String(s).replace(/"/g, '')}"`;
}

function shiftDate(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function recordRun(sb, { startedAt, result, trigger, status }) {
  try {
    await sb.insert('ufc_ingest_runs', [{
      worker: WORKER,
      started_at: iso(startedAt),
      finished_at: new Date().toISOString(),
      events_new: result.counters?.inserted ?? 0,
      status,
      notes: {
        trigger,
        mode: result.plan?.mode ?? null,
        reason: result.plan?.reason ?? null,
        result_status: result.status,
        counters: result.counters,
        diagnostics: result.diagnostics ?? null,
        changed: result.changed ?? [],
      },
    }], { returning: false });
  } catch (e) {
    /* The ledger is diagnostics. Losing a ledger row must not fail a pass that
     * has already written good schedule data. */
    console.error(`[${WORKER}] ledger write failed: ${String(e?.message || e).slice(0, 160)}`);
  }
}
