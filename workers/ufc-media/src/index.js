/* ufc-media — portraits, images, hero assets and their credits.
 *
 * Owns fighter media acquisition. The discovery, identity and rights logic is
 * scripts/images/fetch_fighter_portraits.mjs, reused unchanged: verified
 * Wikidata identity, Commons imageinfo, a license ALLOWLIST (CC0, public
 * domain, CC BY, CC BY-SA and nothing else), a name lock against the stored
 * fighter row, and candidate scoring that rejects group shots and panoramas.
 * This Worker supplies only what differs in workerd — a KV lookup cache,
 * KV-held curated overrides, a Cloudflare-transformation deriver and a run
 * ledger — and changes no gate.
 *
 * WHAT IT REPLACES. `.github/workflows/newsroom.yml`, cron `5 9 * * *`, which
 * ran the portrait pipeline on a GitHub runner. That workflow is already
 * disabled, so this lane has exactly one owner from its first run.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG
 *
 * Missing-only is the DEFAULT, not a flag. A run exists to fill gaps; walking
 * fighters who already have a good portrait spends Wikimedia's bandwidth to
 * rewrite bytes that were already correct.
 *
 * A stored portrait is never replaced by a worse one. `force` re-examines a
 * fighter, and even then mayReplace() has to agree the candidate is strictly
 * better. "Newer" is not "better".
 *
 * Endpoints
 *   GET  /health            unauthenticated, no side effects
 *   GET  /coverage          rights-cleared coverage, upcoming cards called out
 *   POST /admin/run         run now (?dry=true, ?limit=N, ?force=true, ?fighter=UUID)
 *   POST /admin/overrides   replace the curated Commons override map (JSON body)
 */
import { main as fetchPortraits } from '../../../scripts/images/fetch_fighter_portraits.mjs';
import { derive, imageSize } from './derive.mjs';

const WORKER = 'ufc-media';
const VERSION = 'v0.1.0';
const BUCKET = 'ufc-media';
const CACHE_KEY = 'portraits:lookups';
const OVERRIDES_KEY = 'portraits:commons_overrides';

const health = { last_run_at: null, last_status: null, last_result: null, last_error: null };
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), {
  status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i += 1) d |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return d === 0;
}

/* ---- supabase ----------------------------------------------------------- */

async function sb(env, method, path, { body, prefer, range } = {}) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {}),
    ...(range ? { Range: range, 'Range-Unit': 'items' } : {}),
  };
  const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostgREST ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** PostgREST caps at 1000 rows and &limit cannot raise it; page with Range. */
async function sbAll(env, path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await sb(env, 'GET', path, { range: `${from}-${from + 999}` });
    if (!rows?.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/* ---- coverage: the number this lane exists to move ---------------------- */

/**
 * Rights-cleared media coverage, with upcoming-card fighters called out.
 *
 * "Rights-cleared" means a ufc_images row with a COMPLETE credit triple:
 * author, license and source_url. A row missing any of them is unusable —
 * web/lib/db.ts drops an incomplete credit rather than publish an uncredited
 * image — so counting it would overstate the very thing this lane is meant to
 * improve.
 */
export async function coverage(env, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const [images, bouts] = await Promise.all([
    sbAll(env, 'ufc_images?select=fighter_id,license,author,source_url&fighter_id=not.is.null'),
    sbAll(env, `ufc_bouts?select=fighter_a_id,fighter_b_id,ufc_events!inner(event_date)&ufc_events.event_date=gte.${today}&status=neq.cancelled`),
  ]);
  const cleared = new Set();
  const incomplete = new Set();
  for (const i of images) {
    if (i.license && i.author && i.source_url) cleared.add(i.fighter_id);
    else incomplete.add(i.fighter_id);
  }
  const upcoming = new Set();
  for (const b of bouts) {
    if (b.fighter_a_id) upcoming.add(b.fighter_a_id);
    if (b.fighter_b_id) upcoming.add(b.fighter_b_id);
  }
  const upcomingCleared = [...upcoming].filter((id) => cleared.has(id)).length;
  return {
    as_of: today,
    fighters_with_rights_cleared_media: cleared.size,
    fighters_with_incomplete_credit: incomplete.size,
    upcoming_card_fighters: upcoming.size,
    upcoming_with_rights_cleared_media: upcomingCleared,
    upcoming_coverage_pct: upcoming.size ? Math.round((upcomingCleared / upcoming.size) * 100) : null,
    missing_on_upcoming_cards: upcoming.size - upcomingCleared,
  };
}

/* ---- run ledger --------------------------------------------------------- */

async function openRun(env, lane, invoked) {
  const rows = await sb(env, 'POST', 'ufc_ingest_runs', {
    body: [{ worker: WORKER, status: 'running', notes: { lane, invoked } }], prefer: 'return=representation',
  });
  return rows?.[0]?.id || null;
}
async function closeRun(env, id, status, notes) {
  if (!id) return;
  try {
    await sb(env, 'PATCH', `ufc_ingest_runs?id=eq.${id}`,
      { body: { status, finished_at: new Date().toISOString(), notes }, prefer: 'return=minimal' });
  } catch (e) {
    console.error(`[${WORKER}] failed to close run ${id}: ${String(e.message).slice(0, 200)}`);
  }
}

/* ---- the replacement gate ----------------------------------------------- */

/**
 * May this candidate replace what is already stored?
 *
 * The instruction is "do not replace a good portrait with a worse one", and the
 * trap is that a pipeline naturally treats its newest answer as its best one.
 * It is not: Wikidata gets edited, a category gains a badly-cropped file, a
 * good image is superseded by a group shot that happens to score adequately. So
 * a replacement must CLEAR A BAR rather than merely arrive.
 *
 * A stored row with a complete credit is left alone unless the candidate is
 * meaningfully larger on the short edge — 15% is enough to be visible and small
 * enough not to churn on rounding. An incomplete stored credit is not "good",
 * so anything license-clean beats it.
 */
export function mayReplace(existing, candidate) {
  if (!existing) return { replace: true, why: 'no stored image' };
  const complete = Boolean(existing.license && existing.author && existing.source_url);
  if (!complete) return { replace: true, why: 'stored row has an incomplete credit and cannot be published as-is' };
  if (!candidate?.width || !existing.source_short_edge) {
    return { replace: false, why: 'stored image is already rights-cleared and the candidate is not measurably better' };
  }
  const candEdge = Math.min(candidate.width, candidate.height);
  if (candEdge >= existing.source_short_edge * 1.15) {
    return { replace: true, why: `candidate short edge ${candEdge} beats stored ${existing.source_short_edge} by more than 15%` };
  }
  return { replace: false, why: `candidate short edge ${candEdge} does not beat stored ${existing.source_short_edge} by 15%` };
}

/* ---- the run ------------------------------------------------------------ */

async function runPortraits(env, { dry = false, limit = 25, force = false, onlyFighter = null, invoked = 'cron', cron = null } = {}) {
  health.last_run_at = new Date().toISOString();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    health.last_status = 'misconfigured';
    return { status: 'misconfigured', error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' };
  }
  if (!env.UFC_MEDIA_KV) {
    health.last_status = 'misconfigured';
    return { status: 'misconfigured', error: 'UFC_MEDIA_KV is not bound; the lookup cache has nowhere to live' };
  }

  const before = await coverage(env);

  let runId = null;
  if (!dry) {
    try { runId = await openRun(env, 'portraits', invoked); }
    catch (e) {
      health.last_status = 'ledger_open_failed';
      health.last_error = String(e.message).slice(0, 200);
      return { status: 'ledger_open_failed', error: health.last_error };
    }
  }

  /* KV holds the 30-day "we already asked Wikidata about this fighter" memory
   * and the curated override map. Both were files; neither exists in workerd.
   *
   * The cache is written ONCE at the end. The CLI rewrote a JSON file after
   * every fighter, which is free on a local disk and a KV write per fighter
   * here. */
  const cacheState = { data: null };
  const cache = {
    load: async () => {
      if (!cacheState.data) {
        try { cacheState.data = JSON.parse(await env.UFC_MEDIA_KV.get(CACHE_KEY) || '{}'); }
        catch { cacheState.data = {}; }
      }
      return cacheState.data;
    },
    save: async () => {},
  };

  let overrides = {};
  try { overrides = JSON.parse(await env.UFC_MEDIA_KV.get(OVERRIDES_KEY) || '{}'); } catch { overrides = {}; }

  const derived = [];
  try {
    const result = await fetchPortraits(env, {
      dry,
      force,
      limit,
      onlyFighter,
      /* Missing-only unless a fighter was named or force was asked for. */
      missingOnly: !force && !onlyFighter,
      priority: true,
      overrides,
      cache,
      /* The one runtime-specific step. Dimensions are verified from the
       * returned bytes because an unavailable transformer returns the ORIGINAL
       * silently — see derive.mjs. */
      /* Consulted before anything is written. Only the host knows what is
       * already stored, and the source dimensions of a previous acquisition
       * live in KV because ufc_images has no width/height column. A row we
       * have no recorded dimensions for is therefore never replaced: absent
       * evidence that the candidate is better, the safe answer is to keep
       * what is already correct. */
      gate: async ({ fighter, info }) => {
        const rows = await sb(env, 'GET',
          `ufc_images?select=license,author,source_url&fighter_id=eq.${fighter.id}&limit=1`);
        const existing = rows?.[0] || null;
        if (!existing) return { allow: true };
        let shortEdge = null;
        try {
          const d = JSON.parse(await env.UFC_MEDIA_KV.get(`portraits:dims:${fighter.id}`) || 'null');
          if (d) shortEdge = Math.min(d.w, d.h);
        } catch { /* no recorded dimensions */ }
        const verdict = mayReplace({ ...existing, source_short_edge: shortEdge }, info);
        return { allow: verdict.replace, why: verdict.why };
      },
      derive: async ({ srcUrl, storageUpload, prefix }) => {

        const card = await derive(srcUrl, { width: 800, height: 1000 });
        if (!card.ok) throw new Error(`card derive failed: ${card.reason}`);
        const thumb = await derive(srcUrl, { width: 320, height: 400 });
        if (!thumb.ok) throw new Error(`thumb derive failed: ${thumb.reason}`);
        /* portrait keeps the original composition — the lossless source for
         * article heroes and any later reframing — so it is bounded rather than
         * cropped, and a cover-crop card is an acceptable stand-in if the
         * bounded transform is refused. */
        const portrait = await derive(srcUrl, { width: 1200, height: 1200, fit: 'scale-down', requireExact: false });
        const portraitBytes = portrait.ok ? portrait.bytes : card.bytes;
        await storageUpload(`${prefix}/portrait.jpg`, portraitBytes, 'image/jpeg');
        await storageUpload(`${prefix}/card.jpg`, card.bytes, 'image/jpeg');
        await storageUpload(`${prefix}/thumb.jpg`, thumb.bytes, 'image/jpeg');
        derived.push({ prefix, card: `${card.width}x${card.height}`, thumb: `${thumb.width}x${thumb.height}` });
        /* Remember what we accepted, so the next candidate has something to
         * beat. Without this every future run would see 'no recorded
         * dimensions' and refuse every upgrade forever. */
        const fid = prefix.split('/')[1];
        if (portrait.ok) {
          await env.UFC_MEDIA_KV.put(`portraits:dims:${fid}`,
            JSON.stringify({ w: portrait.width, h: portrait.height, at: new Date().toISOString() }));
        }
        return [portraitBytes.length, card.bytes.length, thumb.bytes.length]
          .map((n) => `${Math.round(n / 1024)}k`).join('/');
      },
    });

    if (!dry && cacheState.data) {
      await env.UFC_MEDIA_KV.put(CACHE_KEY, JSON.stringify(cacheState.data), { expirationTtl: 60 * 60 * 24 * 45 });
    }

    const after = await coverage(env);
    const delta = {
      rights_cleared: after.fighters_with_rights_cleared_media - before.fighters_with_rights_cleared_media,
      upcoming_rights_cleared: after.upcoming_with_rights_cleared_media - before.upcoming_with_rights_cleared_media,
    };
    health.last_status = 'success';
    health.last_result = { ...result, delta };
    health.last_error = null;
    console.log(`[${WORKER}] portraits ${dry ? 'DRY ' : ''}ok selected=${result.selected} processed=${result.processed} `
      + `ok=${result.counts.ok} rejected=${result.counts.license_rejected} `
      + `upcoming coverage ${before.upcoming_with_rights_cleared_media}->${after.upcoming_with_rights_cleared_media} of ${after.upcoming_card_fighters}`);
    await closeRun(env, runId, 'success', { lane: 'portraits', invoked, cron, ...result, before, after, delta, derived: derived.slice(0, 20) });
    return { status: 'success', dry, result, coverage: { before, after, delta }, derived: derived.slice(0, 20) };
  } catch (e) {
    const detail = String(e?.message || e).slice(0, 400);
    health.last_status = 'failed';
    health.last_error = detail;
    console.error(`[${WORKER}] portraits FAILED: ${detail}`);
    await closeRun(env, runId, 'failed', { lane: 'portraits', invoked, cron, error: detail });
    return { status: 'failed', error: detail };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({
        service: WORKER, version: VERSION, ...health,
        lanes: ['portraits'],
        replaces: 'newsroom.yml cron "5 9 * * *" (fighter portraits), previously on a GitHub runner',
        cron: '40 9 * * *',
        rights: {
          allowlist: 'CC0, Public domain, CC BY x.x, CC BY-SA x.x — unchanged from the Node pipeline',
          credit_required: 'author + license + source_url; an incomplete credit is never published',
          identity_lock: 'verified Wikidata entity, name-locked against the stored fighter row',
        },
        defaults: { missing_only: true, replace_policy: 'only when strictly better on the short edge by >15%' },
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN),
          UFC_MEDIA_KV: Boolean(env.UFC_MEDIA_KV),
        },
        writes: `${BUCKET} storage (fighters/*), ufc_images, ufc_ingest_runs. Nothing else.`,
      });
    }

    if (url.pathname === '/coverage') {
      try { return json({ service: WORKER, coverage: await coverage(env) }); }
      catch (e) { return json({ error: String(e.message).slice(0, 200) }, 500); }
    }

    if (req.method !== 'POST' || !authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/run') {
      const dry = url.searchParams.get('dry') === 'true';
      const force = url.searchParams.get('force') === 'true';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 25));
      const onlyFighter = url.searchParams.get('fighter') || null;
      return json({ service: WORKER, version: VERSION, ...(await runPortraits(env, { dry, force, limit, onlyFighter, invoked: 'manual' })) });
    }

    if (url.pathname === '/admin/overrides') {
      /* The curated Commons override map, moved off local disk. An override
       * picks a CANDIDATE; every one is still license-checked and name-locked
       * at runtime, so this endpoint cannot smuggle an unlicensed image in. */
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'expected a JSON object' }, 400);
      await env.UFC_MEDIA_KV.put(OVERRIDES_KEY, JSON.stringify(body));
      return json({ service: WORKER, stored_overrides: Object.keys(body).length });
    }

    if (url.pathname === '/admin/probe-resize') {
      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'url required' }, 400);
      const original = await fetch(target, { headers: { 'User-Agent': 'PropBetEdgeUFC/1.1' } });
      const origBytes = original.ok ? new Uint8Array(await original.arrayBuffer()) : null;
      const card = await derive(target, { width: 800, height: 1000 });
      return json({
        original: { http: original.status, size: origBytes ? imageSize(origBytes) : null },
        card: { ok: card.ok, width: card.width, height: card.height, reason: card.reason ?? null },
      });
    }

    return json({ error: 'not_found', service: WORKER, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPortraits(env, { invoked: 'cron', cron: event.cron, limit: 40 }));
  },
};
