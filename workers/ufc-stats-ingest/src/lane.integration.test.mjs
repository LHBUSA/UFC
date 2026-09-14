/* Run: node workers/ufc-stats-ingest/src/lane.integration.test.mjs
 *
 * The round-stat lane end to end, offline: the real Worker entry point against
 * an in-memory PostgREST, an in-memory R2 bucket, a stub DNA binding, and UFC
 * Stats pages served from the pinned fixtures (scripts/backfill/fixtures). No
 * network. Scenarios:
 *   1. source disabled      -> final bout enqueued, awaiting_source, 0 fetches
 *   2. source challenged    -> fail closed: awaiting_source, challenge stored, 0 writes
 *   3. Contender-style card -> not on the list, resolved by fighter history,
 *                              validated, written, event + bout linked, DNA asked
 *   4. re-run               -> idempotent: nothing written, row count unchanged
 *   5. duplicate bout row   -> fight id already on another bout -> identity_review
 *   6. archive gap          -> source disabled + complete card + results + no rows:
 *                              round lane degraded, alert once, no UFC Stats fetch,
 *                              quiet on the next run, visible on /health */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { __test } from './index.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'backfill', 'fixtures');
const page = (f) => readFileSync(join(FX, f), 'utf8');
let failures = 0;
const check = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } };

/* ---------------------------------------------------------- mock PostgREST */
function makeDb(seed) {
  const T = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const pk = { ufc_round_stat_queue: ['bout_id'], ufc_bout_round_stats: ['bout_id', 'fighter_id', 'round'], ufc_bout_results: ['bout_id'] };
  let seq = 0;
  const parseFilters = (params) => {
    const f = [];
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict', 'offset'].includes(k)) continue;
      f.push([k, v]);
    }
    return (row) => f.every(([k, v]) => {
      const val = row[k] == null ? null : String(row[k]);
      const inList = (s) => s.replace(/^\(|\)$/g, '').split(',');
      if (v.startsWith('eq.')) return val === v.slice(3);
      if (v.startsWith('in.')) return inList(v.slice(3)).includes(val);
      if (v.startsWith('not.in.')) return !inList(v.slice(7)).includes(val);
      if (v === 'is.null') return val === null;
      if (v.startsWith('gte.')) return val !== null && val >= v.slice(4);
      if (v.startsWith('lte.')) return val !== null && val <= v.slice(4);
      if (v === 'not.is.null') return val !== null;
      throw new Error(`mock: unsupported filter ${k}=${v}`);
    });
  };
  const handle = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const rows = (T[table] ||= []);
    const method = init.method || 'GET';
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const match = parseFilters(u.searchParams);
    if (method === 'GET') {
      let out = rows.filter(match);
      const total = out.length;
      if (h.range) { const [a, b] = h.range.split('-').map(Number); out = out.slice(a, b + 1); }
      const lim = u.searchParams.get('limit'); if (lim) out = out.slice(0, Number(lim));
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-range': `0-${Math.max(0, out.length - 1)}/${total}` } });
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const conflict = (u.searchParams.get('on_conflict') || (pk[table] || ['id']).join(',')).split(',');
      const ignore = String(h.prefer || '').includes('ignore-duplicates');
      const inserted = [];
      for (const r of body) {
        const hit = rows.find((x) => conflict.every((c) => x[c] != null && String(x[c]) === String(r[c])));
        if (hit) { if (!ignore) Object.assign(hit, r); continue; }
        const row = { id: r.id || `row-${++seq}`, attempts: 0, ...r };
        rows.push(row); inserted.push(row);
      }
      return new Response(JSON.stringify(inserted), { status: 201 });
    }
    if (method === 'PATCH') {
      const vals = JSON.parse(init.body);
      const hit = rows.filter(match);
      for (const r of hit) for (const [k, v] of Object.entries(vals)) if (v !== undefined) r[k] = v;
      return new Response(String(h.prefer || '').includes('representation') ? JSON.stringify(hit) : '', { status: 200 });
    }
    throw new Error(`mock: ${method}`);
  };
  return { T, handle };
}

/* ------------------------------------------------------- fixtures as world */
const OLIVEIRA = '18d01f7f8338ae72';   // fixture fighter page; history row 0 = fight fb4b1754d510b0d0 v Bautista
const BAUTISTA = 'bc711b6dd95c1af6';
const FIGHT = 'fb4b1754d510b0d0';
function world({ eventName = "Dana White's Contender Series 2026: Week 1", eventUsId = null, extraBout = null } = {}) {
  return {
    ufc_fighters: [
      { id: 'fa', name: 'Vinicius Oliveira', ufcstats_id: OLIVEIRA, espn_athlete_id: '1', dob: '1995-11-30', record_w: 23, record_l: 4, record_d: 0 },
      { id: 'fb', name: 'Mario Bautista', ufcstats_id: BAUTISTA, espn_athlete_id: '2', dob: '1993-06-30', record_w: 16, record_l: 2, record_d: 0 },
    ],
    ufc_fighter_aliases: [],
    ufc_events: [{ id: 'ev1', name: eventName, event_date: '2026-02-08', ufcstats_id: eventUsId, espn_event_id: 'e1', card_status: 'complete' }],
    ufc_bouts: [
      { id: 'b1', event_id: 'ev1', fighter_a_id: 'fa', fighter_b_id: 'fb', ufcstats_id: null, espn_competition_id: 'c1', status: 'complete', weight_class: 'BANTAMWEIGHT', scheduled_rounds: 5 },
      ...(extraBout ? [extraBout] : []),
    ],
    ufc_bout_results: [{ bout_id: 'b1', winner_id: 'fb', method: 'SUB', round: 2, has_stats: false, stats_captured_at: null }],
    ufc_bout_round_stats: [], ufc_round_stat_queue: [], ufc_ingest_runs: [], ufc_alias_review_queue: [],
  };
}
const CHALLENGE = `<!doctype html><html><head><title>Loading…</title></head><body><p>Checking your browser…</p><noscript>This site requires JavaScript.</noscript><script>
var nonce="12d5deed8718b760",
    target=new Array(2+1).join('0');
var xhr=new XMLHttpRequest();
xhr.open('POST',"/__c",true);
xhr.send('nonce='+encodeURIComponent(nonce)+'&n='+n);
</script></body></html>`;

async function run(seed, { enabled = 'true', challenged = false, shared = null, discordPosts = null } = {}) {
  const db = shared?.db || makeDb(seed);
  const r2 = shared?.r2 || new Map();
  const ufcstatsHits = [];
  const dna = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('http://sb.test/rest/v1/')) return db.handle(url, init);
    if (url.startsWith('http://discord.test/') && discordPosts) { discordPosts.push(JSON.parse(init.body).content); return new Response(null, { status: 204 }); }
    if (url.startsWith('http://ufcstats.test/')) {
      ufcstatsHits.push(url);
      if (challenged) return new Response(CHALLENGE, { status: 200 });
      if (url.endsWith(`/fighter-details/${OLIVEIRA}`)) return new Response(page('fighter_18d01f7f8338ae72.html'));
      if (url.endsWith(`/fight-details/${FIGHT}`)) return new Response(page('fight_fb4b1754d510b0d0.html'));
      if (url.endsWith('/event-details/c337c3c85b1871e0')) return new Response(page('event_c337c3c85b1871e0.html'));
      return new Response('not found', { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = {
    SUPABASE_URL: 'http://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test', UFCSTATS_BASE: 'http://ufcstats.test',
    UFCSTATS_ENABLED: enabled, UFCSTATS_FORWARD_DAYS: '3650',
    RAW: {
      get: async (k) => (r2.has(k) ? { json: async () => JSON.parse(r2.get(k)), text: async () => r2.get(k) } : null),
      put: async (k, v) => { r2.set(k, typeof v === 'string' ? v : String(v)); },
    },
    INTELLIGENCE: { refreshFightDna: async (a) => { dna.push(a); return { status: 'ok', snapshots: 2 }; } },
    ...(discordPosts ? { DISCORD_WEBHOOK_URL: 'http://discord.test/hook' } : {}),
  };
  const res = await __test.runIngest(env, { invoked: 'test', skipEspn: true });
  return { res, db, r2, ufcstatsHits, dna, env };
}
const q = (db) => db.T.ufc_round_stat_queue.find((x) => x.bout_id === 'b1');

/* 1. source disabled */
{
  const { res, db, ufcstatsHits } = await run(world(), { enabled: 'false' });
  check(res.status === 'success', `disabled run ok ${res.status}`);
  check(q(db)?.state === 'awaiting_source' && q(db).last_reason === 'UFCSTATS_ENABLED=false', `disabled: queued awaiting_source ${JSON.stringify(q(db))}`);
  check(ufcstatsHits.length === 0 && db.T.ufc_bout_round_stats.length === 0, 'disabled: nothing fetched, nothing written');
}

/* 2. challenged */
{
  const { res, db, r2, ufcstatsHits } = await run(world(), { challenged: true });
  check(res.status === 'failed' && res.assertion_failures.some((a) => a.class === 'AccessGateError'), 'challenged: run fails closed');
  check(ufcstatsHits.length === 1, `challenged: exactly one request, no retry (${ufcstatsHits.length})`);
  check(q(db)?.state === 'awaiting_source' && /challenged/.test(q(db).last_reason), `challenged: bout awaits source ${JSON.stringify(q(db))}`);
  check(JSON.parse(r2.get('ufc-raw/_state/source_health.json')).status === 'challenged', 'challenged: state stored for backoff');
  check(db.T.ufc_bout_round_stats.length === 0, 'challenged: no rows');
}

/* 3. Contender-style card via fighter history, then 4. idempotent re-run */
{
  const seed = world();
  const first = await run(seed);
  const { res, db, dna, ufcstatsHits } = first;
  check(res.status === 'success', `history run ok ${res.status} ${JSON.stringify(res.assertion_failures)}`);
  check(q(db)?.state === 'written' && q(db).identity_method === 'fighter_history' && q(db).ufcstats_fight_id === FIGHT, `history: written ${JSON.stringify(q(db))}`);
  check(q(db).identity_evidence?.date_delta_days === 1, 'history: one-day date offset accepted and recorded');
  check(db.T.ufc_bout_round_stats.length === 4 && db.T.ufc_bout_round_stats.every((r) => ['fa', 'fb'].includes(r.fighter_id)), `history: 2 rounds x 2 corners (${db.T.ufc_bout_round_stats.length})`);
  check(db.T.ufc_bouts[0].ufcstats_id === FIGHT && db.T.ufc_events[0].ufcstats_id === 'c337c3c85b1871e0', 'history: bout and event linked');
  check(db.T.ufc_bout_results[0].has_stats === true && db.T.ufc_bout_results[0].stats_source_url.endsWith(FIGHT), 'history: result marked enriched');
  check(!ufcstatsHits.some((u) => u.includes('/statistics/events/completed')), 'history: completed list never requested');
  check(dna.length === 1 && res.notes.dna_trigger?.status === 'ok', 'history: Fight DNA owner asked once');

  const again = await run({ ...db.T });
  check(again.res.status === 'success' && again.db.T.ufc_bout_round_stats.length === 4 && again.ufcstatsHits.length === 0, 'rerun: idempotent, no fetch, same rows');
  check((again.res.notes.round_rows_written || 0) === 0 && again.dna.length === 0, 'rerun: nothing written, DNA not asked');
}

/* 5. the fight id already sits on another bout (a duplicate bout row) */
{
  const dup = { id: 'b-dup', event_id: 'ev1', fighter_a_id: 'fa', fighter_b_id: 'fb', ufcstats_id: FIGHT, espn_competition_id: null, status: 'complete' };
  const seed = world({ extraBout: dup });
  seed.ufc_bout_round_stats = [{ bout_id: 'b-dup', fighter_id: 'fa', round: 1 }];
  const { res, db } = await run(seed);
  check(res.status === 'success' && q(db)?.state === 'identity_review' && /duplicate bout row/.test(q(db).last_reason), `duplicate: review not overwrite ${JSON.stringify(q(db))}`);
  check(db.T.ufc_bout_round_stats.filter((r) => r.bout_id === 'b1').length === 0 && db.T.ufc_bouts[0].ufcstats_id === null, 'duplicate: nothing written to b1');
}

/* 6. the silent outage of 2026-09-13: disabled source, complete card, results, no rows */
{
  const posts = [];
  const first = await run(world({ eventName: 'Noche UFC: Silva vs. Delgado' }), { enabled: 'false', discordPosts: posts });
  const ra = first.res.notes.round_archive;
  check(first.res.status === 'success', `gap: run itself succeeds (ESPN lane unaffected) ${first.res.status}`);
  check(first.ufcstatsHits.length === 0 && first.db.T.ufc_bout_round_stats.length === 0, 'gap: no UFC Stats fetch, no rows invented');
  check(q(first.db)?.state === 'awaiting_source' && q(first.db).last_reason === 'UFCSTATS_ENABLED=false', `gap: queue stays fail-closed ${JSON.stringify(q(first.db))}`);
  check(ra?.round_lane_status === 'degraded', `gap: round lane degraded ${JSON.stringify(ra)}`);
  check(ra?.gaps?.[0]?.cause === 'source disabled' && ra.gaps[0].completed_bouts === 1 && ra.gaps[0].with_round_rows === 0, `gap: facts ${JSON.stringify(ra?.gaps?.[0])}`);
  check(ra?.alert?.kind === 'new' && ra.alert.delivered === 'discord', `gap: alert generated ${JSON.stringify(ra?.alert)}`);
  const gapPosts = () => posts.filter((m) => m.includes('ROUND ARCHIVE GAP'));
  check(gapPosts().length === 1 && gapPosts()[0].includes('ROUND ARCHIVE GAP · Noche UFC: Silva vs. Delgado · 1 completed bouts · 0 with round rows · source disabled'), `gap: one factual alert ${JSON.stringify(gapPosts())}`);
  check(!gapPosts()[0].includes('UFCSTATS_ENABLED'), 'gap: alert states the cause in words, not the flag');

  const second = await run(null, { enabled: 'false', discordPosts: posts, shared: { db: first.db, r2: first.r2 } });
  check(second.res.notes.round_archive?.alert?.kind === 'none' && gapPosts().length === 1, `gap: no repeat alert on the next run ${JSON.stringify(second.res.notes.round_archive?.alert)}`);

  const health = await (await worker.fetch(new Request('http://worker.test/health'), second.env)).json();
  check(health.round_lane_status === 'degraded' && health.round_archive_gaps?.length === 1 && health.ufcstats_enabled === false, `gap: /health reports degraded ${JSON.stringify({ s: health.round_lane_status, g: health.round_archive_gaps?.length })}`);
  check(health.round_archive_alert?.last_alert?.kind === 'new', 'gap: /health shows the last alert');
}

console.log('lane integration:', failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
