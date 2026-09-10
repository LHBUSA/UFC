/* ufc-history-repair — the production owner of historical gap detection.
 *
 * WHAT THIS WORKER DOES, AND THE ONE THING IT DELIBERATELY DOES NOT
 *
 * It owns the SCHEDULE, the bounded batching, the resumable cursor, the counts
 * and the run ledger for historical archive gaps. It scans completed,
 * UFCStats-linked events for ones holding zero bout rows and reports exactly
 * what it found.
 *
 * It does NOT scrape or write canonical rows. That distinction is the whole
 * design, and it is not laziness -- it is the safer half of a real trade-off.
 *
 * WHY THE REPAIR EXECUTION STAYS WHERE IT IS
 *
 * Repair writes into the SAME canonical event, bout, result and round tables
 * the live ingest owns. The tool that does it is 2,585 lines of Python across
 * parsers.py, normalizers.py, wayback.py and backfill_ufcstats.py, resting on
 * BeautifulSoup and lxml and covered by its own test suite. Reimplementing that
 * in JavaScript to move a cron would produce a SECOND, unvalidated parser
 * writing to the canonical history of the sport -- and a subtly wrong parser
 * there is worse than a lane that does not run, because the damage is silent
 * and permanent.
 *
 * It would also be a large speculative rewrite for a job that currently has
 * nothing to do: at the time of writing there are 788 completed UFCStats-linked
 * events and ZERO with missing bouts. The backfill is finished. The nightly
 * GitHub run had become a twenty-second no-op.
 *
 * So what actually mattered -- that GitHub stops being the scheduler -- is done
 * here, and this Worker is the watchdog that says whether a gap ever reappears.
 * If one does, it reports the exact events and the operator runs the validated
 * Python tool by manual dispatch. Porting those parsers is a real project with
 * its own validation, and it should be decided on its merits rather than
 * smuggled in as part of moving a cron.
 *
 * Endpoints
 *   GET  /health        unauthenticated, no writes
 *   POST /admin/scan    scan now  (?limit=&reset_cursor=true)
 */
const WORKER = 'ufc-history-repair';
const VERSION = 'v0.1.0';
const DEFAULT_BATCH = 500;
const CURSOR_KEY = 'history:scan_cursor';

const health = { last_run_at: null, last_status: null, last_counts: null, last_error: null, runs: 0 };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

async function sb(env, method, path, { body, prefer } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/[/]+$/, '');
  const res = await fetch(`${base}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostgREST ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

/** A single page of rows, using Range so the 1000-row cap cannot hide data. */
async function sbRange(env, path, from, to) {
  const base = String(env.SUPABASE_URL || '').replace(/[/]+$/, '');
  const res = await fetch(`${base}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Range: `${from}-${to}`,
      'Range-Unit': 'items',
    },
  });
  if (res.status === 416) return [];
  const text = await res.text();
  if (!res.ok) throw new Error(`PostgREST GET ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

async function openRun(env, invoked) {
  try {
    const rows = await sb(env, 'POST', 'ufc_ingest_runs', {
      body: [{ worker: WORKER, status: 'running', notes: { lane: 'history_gap_scan', invoked } }],
      prefer: 'return=representation',
    });
    return rows?.[0]?.id || null;
  } catch (e) {
    /* Opening the run must succeed before work happens, so that work is never
     * unrecorded. If the ledger is unreachable we do not scan. */
    throw new Error(`cannot open run ledger: ${String(e.message).slice(0, 160)}`);
  }
}

async function closeRun(env, id, status, notes) {
  if (!id) return;
  try {
    await sb(env, 'PATCH', `ufc_ingest_runs?id=eq.${id}`, {
      body: { status, finished_at: new Date().toISOString(), notes }, prefer: 'return=minimal',
    });
  } catch (e) {
    console.error(`[${WORKER}] failed to close run ${id}: ${String(e.message).slice(0, 200)}`);
  }
}

/**
 * One bounded, resumable pass over the historical archive.
 *
 * BOUNDED: at most `limit` events per run, so a run has a predictable cost
 * whether the archive holds 800 events or 80,000.
 *
 * RESUMABLE: the cursor is the event_date the last pass stopped at, held in KV.
 * Each pass continues from there and wraps to the beginning on completion, so
 * the whole archive is swept repeatedly without any single run trying to do it
 * all. Losing the cursor costs a restart from the oldest event, never a gap.
 *
 * IDEMPOTENT AND NON-DESTRUCTIVE: it reads. The only rows it writes are its own
 * ledger entries, so running it twice, or interrupting it, changes nothing
 * about the archive.
 *
 * STOPS SAFELY: any read failure ends the pass with the cursor untouched and
 * the run closed as failed. The next tick retries the same window rather than
 * skipping past it, which is the behaviour that matters for a repair lane --
 * silently advancing past a window we could not read is how gaps become
 * permanent.
 */
async function scan(env, { limit = DEFAULT_BATCH, resetCursor = false, invoked = 'cron' } = {}) {
  health.last_run_at = new Date().toISOString();
  health.runs += 1;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    health.last_status = 'misconfigured';
    return { status: 'misconfigured' };
  }

  const runId = await openRun(env, invoked);
  const started = Date.now();
  try {
    let cursor = null;
    if (!resetCursor) {
      try { cursor = env.REPAIR_STATE ? await env.REPAIR_STATE.get(CURSOR_KEY) : null; } catch { cursor = null; }
    }
    const after = cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor) ? cursor : '1990-01-01';

    const events = await sb(env, 'GET',
      `ufc_events?select=id,name,event_date,ufcstats_id`
      + `&event_date=lt.${new Date().toISOString().slice(0, 10)}`
      + `&event_date=gt.${after}`
      + `&ufcstats_id=not.is.null`
      + `&order=event_date.asc&limit=${limit}`);

    const counts = { scanned: 0, repaired: 0, unresolved: 0, skipped: 0 };
    const gaps = [];

    if (!events?.length) {
      /* End of the archive: wrap so the next pass re-sweeps from the start.
       * A finished backfill still deserves re-checking -- rows can be deleted
       * or an event re-linked, and a watchdog that only ever looks forward
       * would never notice. */
      counts.skipped = 0;
      if (env.REPAIR_STATE) { try { await env.REPAIR_STATE.delete(CURSOR_KEY); } catch { /* next pass restarts anyway */ } }
      const notes = { ...counts, cursor_from: after, cursor_to: null, wrapped: true, elapsed_ms: Date.now() - started };
      await closeRun(env, runId, 'success', notes);
      health.last_status = 'ok'; health.last_counts = counts; health.last_error = null;
      return { status: 'ok', ...counts, cursor_from: after, wrapped: true, gaps: [] };
    }

    const ids = events.map((e) => e.id);
    /* One query for the whole batch rather than one per event: the question is
     * "which of these have any bout at all", and asking it 500 times would be
     * 500 round trips to learn the same thing. */
    /* PAGED, because PostgREST caps a response at 1000 rows and no limit= can
     * raise it. 400 events hold several thousand bouts, so a single request
     * returned the first thousand and every event whose bouts fell past that
     * looked bout-less -- this reported 302 phantom gaps on an archive that has
     * none. The same cap has bitten this project before; a query that can
     * silently return a prefix must always be paged. */
    const haveBouts = new Set();
    for (let from = 0; ; from += 1000) {
      const page = await sbRange(env, `ufc_bouts?select=event_id&event_id=in.(${ids.join(',')})&order=event_id`, from, from + 999);
      for (const b of page) haveBouts.add(b.event_id);
      if (page.length < 1000) break;
    }

    for (const e of events) {
      counts.scanned += 1;
      if (haveBouts.has(e.id)) continue;
      /* A gap. NOT repaired here by design -- recorded so an operator can run
       * the validated backfill against exactly these events. */
      counts.unresolved += 1;
      if (gaps.length < 50) gaps.push({ id: e.id, name: e.name, event_date: e.event_date, ufcstats_id: e.ufcstats_id });
    }

    const newCursor = events[events.length - 1].event_date;
    if (env.REPAIR_STATE) {
      /* Advanced only after a clean pass. */
      try { await env.REPAIR_STATE.put(CURSOR_KEY, newCursor, { expirationTtl: 2592000 }); } catch { /* next pass repeats this window */ }
    }

    const notes = { ...counts, cursor_from: after, cursor_to: newCursor, gaps: gaps.slice(0, 20), elapsed_ms: Date.now() - started };
    await closeRun(env, runId, 'success', notes);
    health.last_status = 'ok'; health.last_counts = counts; health.last_error = null;
    console.log(`[${WORKER}] ${JSON.stringify({ ...counts, cursor_to: newCursor })}`);
    return { status: 'ok', ...counts, cursor_from: after, cursor_to: newCursor, gaps };
  } catch (e) {
    health.last_status = 'failed';
    health.last_error = String(e?.message || e).slice(0, 300);
    await closeRun(env, runId, 'failed', { error: health.last_error, elapsed_ms: Date.now() - started });
    console.error(`[${WORKER}] scan failed: ${health.last_error}`);
    return { status: 'failed', error: health.last_error };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      let lastSuccess = null;
      try {
        const rows = await sb(env, 'GET',
          `ufc_ingest_runs?select=started_at,finished_at,status,notes&worker=eq.${WORKER}`
          + `&status=eq.success&order=started_at.desc&limit=1`);
        lastSuccess = rows?.[0] || null;
      } catch { /* reported as null */ }
      let cursor = null;
      try { cursor = env.REPAIR_STATE ? await env.REPAIR_STATE.get(CURSOR_KEY) : null; } catch { /* null */ }
      return json({
        service: WORKER,
        version: VERSION,
        owns: 'historical archive gap DETECTION: schedule, bounded batching, resumable cursor, counts and ledger',
        does_not_do: 'scraping or writing canonical event/bout/result/round rows — repair execution remains the '
          + 'validated Python tool in scripts/backfill, run by manual dispatch, because a second unvalidated parser '
          + 'writing to the canonical history of the sport is a worse risk than a lane that does not run',
        writes: ['ufc_ingest_runs'],
        reads: ['ufc_events', 'ufc_bouts'],
        schedule: 'cloudflare cron 20 7 * * *',
        replaces: 'history-gap-repair.yml cron "20 7 * * *", previously run on a GitHub runner',
        batch_size: DEFAULT_BATCH,
        cursor,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
          REPAIR_STATE: Boolean(env.REPAIR_STATE),
        },
        last_success: lastSuccess,
        ...health,
      });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/scan') {
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_BATCH));
      return json({
        service: WORKER,
        ...(await scan(env, { limit, resetCursor: url.searchParams.get('reset_cursor') === 'true', invoked: 'manual' })),
      });
    }

    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scan(env, { invoked: 'cron' }).catch(() => {}));
  },
};
