/* Editorial spend policy (owner rule 2026-09-29, Newsroom V4).
 *
 * Premium prose is bought once per genuinely new editorial input. These are
 * the acceptance cases the owner set, driven through the real desk
 * (runOpenAIEditorial), the real writer (write_articles) and the real Worker
 * admin route, with the OpenAI and PostgREST transports faked.
 *
 *   A  untouched published article across cron passes     -> 0 calls
 *   B  same digest that previously failed/held             -> 0 calls next run
 *   C  material fact change -> new digest                  -> at most 1 call
 *   D  next cron with that same new digest                 -> 0 calls
 *   E  explicit admin re-edit                              -> may call
 *   F  telemetry carries the API's actual token usage
 *   +  no automatic corrective retry; no automatic Anthropic fallback
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runOpenAIEditorial, pipelineEventSink, nominalStandardCost } from '../../ufc-newsroom/src/openai_editorial.mjs';
import {
  stampEditorialInput, editorialDigest, automaticEligibility, decisionFor, DIGEST_VERSION,
} from '../../../scripts/news/editorial_digest.mjs';
import { main as writeArticles } from '../../../scripts/news/write_articles.mjs';
import worker from '../src/index.js';

const ENV = { OPENAI_API_KEY: 'test-key', UFC_EDITORIAL_OPENAI_MODEL: 'gpt-5.6-sol' };
const NOW = Date.parse('2026-09-29T12:00:00Z');
const USAGE = {
  input_tokens: 5000,
  input_tokens_details: { cached_tokens: 1200 },
  output_tokens: 3000,
  output_tokens_details: { reasoning_tokens: 1800 },
  total_tokens: 8000,
};

const words = (n) => Array.from({ length: n }, () => 'evidence').join(' ');

function draft(id, facts = { wins: 10 }) {
  const art = {
    id, slug: `${id}-slug`, story_type: 'card_change', status: 'published',
    headline: 'A deterministic card change headline for tests',
    dek: 'A deterministic deck for the card change, long enough for the gate.',
    body_md: `Template prose. ${words(40)}`,
    fact_block: { story_class: 'card_change', facts, generated_at: '2026-09-29T00:00:00Z', source: { updated_at: 'earlier' } },
    model_version: 'template-2',
    updated_at: '2026-09-29T11:00:00Z',
  };
  return { ...art, sources: stampEditorialInput([{ kind: 'fact_block', hash: 'h1', version: 2 }], art).sources };
}

/** A PostgREST stand-in that applies the desk's patches, so decisions persist
 * between passes exactly as they would in the table. */
function store(rows) {
  const byId = new Map(rows.map((r) => [r.id, structuredClone(r)]));
  const events = [];
  return {
    events,
    row: (id) => byId.get(id),
    select: async () => [...byId.values()].filter((r) => r.status === 'published').map((r) => structuredClone(r)),
    patch: async (_t, filter, body) => { const id = filter.replace('id=eq.', ''); byId.set(id, { ...byId.get(id), ...structuredClone(body) }); },
    insert: async (table, rs) => { if (table === 'ufc_news_pipeline_events') events.push(...rs); return rs; },
  };
}

function openai({ pass = true } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const payload = pass
      ? { headline: 'An evidence-led card change headline, polished', dek: 'A polished deck that clears the deterministic minimum length easily.', body_md: words(500) }
      : { headline: 'short', dek: 'short', body_md: 'x' };
    return {
      ok: true,
      json: async () => ({
        id: `resp_${calls.length}`, status: 'completed', model: 'gpt-5.6-sol-2026-09-01', usage: USAGE,
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
      }),
    };
  };
  return { calls, fetchImpl };
}

const pass = (sb, fetchImpl, opts = {}) => runOpenAIEditorial(ENV, sb, {
  now: NOW, limit: 12, recentHours: 72, maxPolish: 1, storyTypes: ['card_change'], fetchImpl, worker: 'ufc-event-editorial', ...opts,
}).catch((e) => { if (e.deskResult) return e.deskResult; throw e; });

test('new story: exactly one call, and the decision is stored against its digest', async () => {
  const row = draft('new');
  const sb = store([row]);
  const o = openai();
  const r = await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 1);
  assert.equal(r.model_calls, 1);
  const d = decisionFor(sb.row('new').sources, automaticEligibility(row).digest);
  assert.equal(d.outcome, 'passed');
  assert.match(sb.row('new').model_version, /editorial-desk-openai-v1$/);
});

test('A: an untouched published article across several cron passes costs 0 calls after its one edit', async () => {
  const sb = store([draft('a')]);
  const o = openai();
  await pass(sb, o.fetchImpl);
  for (let i = 0; i < 5; i += 1) await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 1, 'only the first-ever pass bought prose');
});

test('A (legacy): rows without a writer digest are never bought automatically', async () => {
  const legacyTemplate = { ...draft('lt'), sources: [{ kind: 'fact_block', hash: 'h1', version: 2 }] };
  const legacyDesk = { ...draft('ld'), model_version: 'openai:gpt-5.6-sol/editorial-desk-openai-v1', sources: [{ kind: 'fact_block', hash: 'h1', version: 2 }] };
  const sb = store([legacyTemplate, legacyDesk]);
  const o = openai();
  for (let i = 0; i < 3; i += 1) {
    const r = await pass(sb, o.fetchImpl);
    assert.equal(r.skip_reasons.no_digest, 2);
  }
  assert.equal(o.calls.length, 0);
});

test('B: a held digest is spent -- one attempt, no corrective retry, 0 calls on the next run', async () => {
  const sb = store([draft('b')]);
  const o = openai({ pass: false });
  const r1 = await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 1, 'automatic runs never make the corrective second rewrite');
  assert.equal(r1.max_attempts, 1);
  assert.equal(sb.row('b').model_version, 'template-2', 'held prose is not published');
  const r2 = await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 1, 'no automatic retry of the held digest');
  assert.equal(r2.skip_reasons.digest_held, 1);
});

test('B: a provider failure also spends the digest', async () => {
  const sb = store([draft('bf')]);
  let n = 0;
  const failing = async () => { n += 1; return { ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) }; };
  await pass(sb, failing);
  await pass(sb, failing);
  assert.equal(n, 1);
  assert.equal(sb.row('bf').sources.find((s) => s.kind === 'editorial_desk').decisions[0].outcome, 'failed');
});

test('C + D: a material fact change buys exactly one new edit, then 0 again', async () => {
  const sb = store([draft('c')]);
  const o = openai();
  await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 1);

  /* The writer refreshes the row with new facts: template prose back, the
   * desk's history carried forward, a new digest stamped. */
  const polished = sb.row('c');
  const fresh = draft('c', { wins: 11 });
  const restamped = stampEditorialInput(fresh.sources, fresh, polished.sources);
  await sb.patch('ufc_articles', 'id=eq.c', { ...fresh, sources: restamped.sources });
  assert.notEqual(restamped.digest, automaticEligibility(draft('c')).digest, 'material change -> new digest');

  await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 2, 'C: one call for the new facts');
  for (let i = 0; i < 3; i += 1) await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 2, 'D: the same new digest costs nothing more');
});

test('volatile fields do not change the digest', () => {
  const a = draft('v');
  const b = { ...a, fact_block: { ...a.fact_block, generated_at: '2027-01-01T00:00:00Z', source: { updated_at: 'later', fetched_at: 'x' } }, updated_at: 'later' };
  assert.equal(editorialDigest(a), editorialDigest(b));
  const c = { ...a, fact_block: { ...a.fact_block, facts: { wins: 12 } } };
  assert.notEqual(editorialDigest(a), editorialDigest(c));
});

test('E: an explicit admin re-edit may call again, up to 2 attempts', async () => {
  const sb = store([draft('e')]);
  const o = openai({ pass: false });
  await pass(sb, o.fetchImpl);
  assert.equal(o.calls.length, 1);
  const r = await pass(sb, o.fetchImpl, { force: true });
  assert.equal(r.trigger, 'admin_reedit');
  assert.equal(o.calls.length, 3, 'admin force bypasses the spent digest and may use the corrective attempt');
  const c = await pass(sb, o.fetchImpl, { force: true, trigger: 'canary', maxAttempts: 1 });
  assert.equal(c.trigger, 'canary');
  assert.equal(o.calls.length, 4);
});

test('F: one telemetry row per request, carrying the API usage verbatim', async () => {
  const sb = store([draft('f')]);
  const o = openai({ pass: false });
  await pass(sb, o.fetchImpl, { force: true, maxAttempts: 2 });
  assert.equal(sb.events.length, 2, 'written per call, not per pass');
  const [e1, e2] = sb.events;
  assert.equal(e1.stage, 'editorial');
  assert.equal(e1.status, 'held');
  assert.equal(e1.news_item_id, null);
  assert.equal(e1.article_id, 'f');
  assert.equal(e1.worker, 'ufc-event-editorial');
  const d = e1.detail;
  for (const k of ['sport', 'worker', 'story_id', 'article_id', 'slug', 'story_class', 'routing_lane', 'routing_reason', 'model', 'pool',
    'trigger', 'attempt', 'editorial_digest', 'response_id', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens',
    'latency_ms', 'status', 'nominal_standard_cost_usd', 'timestamp']) assert.ok(k in d, `detail.${k}`);
  assert.equal(d.kind, 'model_call');
  assert.equal(d.sport, 'ufc');
  assert.equal(d.routing_lane, 'STANDARD_EDITORIAL');
  assert.equal(d.pool, 'premium');
  assert.equal(d.model, 'gpt-5.6-sol-2026-09-01', 'the RESPONSE model, not the requested alias');
  assert.equal(d.response_id, 'resp_1');
  assert.equal(d.input_tokens, 5000);
  assert.equal(d.cached_input_tokens, 1200);
  assert.equal(d.output_tokens, 3000);
  assert.equal(d.reasoning_tokens, 1800);
  assert.equal(d.digest_version, DIGEST_VERSION);
  assert.equal(d.editorial_digest, automaticEligibility(draft('f')).digest);
  assert.equal(d.nominal_standard_cost_usd, nominalStandardCost(USAGE));
  assert.equal(d.nominal_standard_cost_usd, (3800 * 1.25 + 1200 * 0.125 + 3000 * 10) / 1e6);
  assert.match(d.cost_basis, /NOMINAL/);
  assert.match(d.cost_basis, /never billed/);
  assert.equal(e2.detail.attempt, 2);
  assert.equal(e2.detail.response_id, 'resp_2');
});

test('the digest and decision entries are never shown to the model', async () => {
  const sb = store([draft('p')]);
  const o = openai();
  await pass(sb, o.fetchImpl);
  const input = o.calls[0].input;
  assert.ok(!input.includes('editorial_input'), 'no digest in the packet: its hex digits would widen the numbers gate');
  assert.ok(!input.includes('editorial_desk'));
});

/* ---- the writer: a refresh no longer erases the desk's decision ---------- */

function writerHarness(existingArticles, fighterWins = 10) {
  const F = (id, name, w) => ({ id, ufcstats_id: null, espn_athlete_id: null, name, nickname: null, dob: '1995-01-01', record_w: w, record_l: 2, record_d: 0, record_nc: 0, height_in: 66, reach_in: 68, stance: 'Orthodox', weight_lbs: 135, career_slpm: 4.1, career_str_acc: 0.45, career_sapm: 3.2, career_str_def: 0.6, career_td_avg: 1.0, career_td_acc: 0.35, career_td_def: 0.7, career_sub_avg: 0.2, source_url: 'https://example.invalid/x' });
  const rows = {
    ufc_fighters: [F('f-1', 'Jane Doe', fighterWins), F('f-2', 'Rita Roe', 9)],
    ufc_fighter_aliases: [],
    ufc_events: [{ id: 'event-1', name: 'UFC Test Night', event_date: '2026-10-12', venue: 'Test Arena', city: 'Las Vegas', region: 'NV', country: 'USA', card_status: 'scheduled' }],
    ufc_bouts: [{ id: 'bout-1', event_id: 'event-1', fighter_a_id: 'f-1', fighter_b_id: 'f-2', weight_class: 'BW', weight_class_raw: 'Bantamweight', is_womens: true, is_title: false, scheduled_rounds: 3, card_position: 'main', bout_order: 1, status: 'announced', replaced_bout_id: null, short_notice_days: null }],
    ufc_bout_results: [], ufc_bout_round_stats: [], ufc_images: [], ufc_articles: existingArticles, ufc_news_items: [], ufc_news_sources: [],
  };
  const written = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) throw new Error(`unexpected network call: ${u}`);
    const table = u.split('/rest/v1/')[1].split('?')[0];
    const method = init.method || 'GET';
    if (method === 'GET') {
      const body = JSON.stringify(u.includes('status=eq.review') ? [] : (rows[table] ?? []));
      return { ok: true, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
    }
    const payload = init.body ? JSON.parse(init.body) : null;
    written.push({ table, method, payload });
    const back = JSON.stringify(Array.isArray(payload) ? payload : [payload]);
    return { ok: true, headers: { get: () => null }, text: async () => back, json: async () => JSON.parse(back) };
  };
  return { written, restore: () => { globalThis.fetch = real; } };
}

const WENV = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' };

async function createdRow() {
  const h = writerHarness([]);
  try {
    await writeArticles(WENV, { now: Date.parse('2026-09-29T12:00:00Z'), types: 'preview' });
    return h.written.find((w) => w.table === 'ufc_articles' && w.method === 'POST').payload[0];
  } finally { h.restore(); }
}

test('writer: a new article is stamped with its editorial digest', async () => {
  const row = await createdRow();
  const input = row.sources.find((s) => s.kind === 'editorial_input');
  assert.equal(input.version, DIGEST_VERSION);
  assert.equal(input.digest, editorialDigest(row), 'the stamp is the digest of exactly what was stored');
  assert.equal(automaticEligibility(row).eligible, true);
});

function polishedExisting(row, oldHash = 'stale-hash') {
  const digest = row.sources.find((s) => s.kind === 'editorial_input').digest;
  const sources = row.sources.map((s) => (s.kind === 'fact_block' ? { ...s, hash: oldHash } : s));
  return {
    ...row, id: 'art-1', status: 'published',
    headline: 'Desk headline', dek: 'Desk deck', body_md: `Desk prose ${words(600)}`,
    model_version: 'openai:gpt-5.6-sol/editorial-desk-openai-v1',
    sources: [...sources, { kind: 'editorial_desk', version: DIGEST_VERSION, decisions: [{ digest, outcome: 'passed', trigger: 'new_story', attempts: 1, at: 'x' }] }],
  };
}

test('writer: a fact-hash refresh with an unchanged editorial digest keeps the desk prose (no re-buy)', async () => {
  const existing = polishedExisting(await createdRow());
  const h = writerHarness([existing]);
  try {
    await writeArticles(WENV, { now: Date.parse('2026-09-29T12:00:00Z'), types: 'preview' });
    const p = h.written.find((w) => w.table === 'ufc_articles' && w.method === 'PATCH').payload;
    assert.ok(!('body_md' in p) && !('headline' in p) && !('model_version' in p), 'desk prose left standing');
    assert.ok(p.sources.find((s) => s.kind === 'editorial_desk'), 'decision carried forward');
    const after = { ...existing, ...p };
    const e = automaticEligibility(after);
    assert.equal(e.eligible, false);
    assert.equal(e.reason, 'digest_passed', 'and the desk makes 0 calls on it');
  } finally { h.restore(); }
});

test('writer: a material fact change puts the template back and makes the new digest eligible once', async () => {
  const existing = polishedExisting(await createdRow());
  const h = writerHarness([existing], 11);
  try {
    await writeArticles(WENV, { now: Date.parse('2026-09-29T12:00:00Z'), types: 'preview' });
    const p = h.written.find((w) => w.table === 'ufc_articles' && w.method === 'PATCH').payload;
    assert.equal(p.model_version, 'template-2', 'changed facts do not keep stale desk prose');
    assert.ok(p.sources.find((s) => s.kind === 'editorial_desk'), 'history carried forward');
    const e = automaticEligibility({ ...existing, ...p });
    assert.equal(e.eligible, true);
    assert.equal(e.reason, 'new_editorial_digest');
  } finally { h.restore(); }
});

test('writer: refreshing a LEGACY row (no digest yet) records a baseline -- a generator change buys nothing', async () => {
  const row = await createdRow();
  const legacy = {
    ...row, id: 'art-legacy', status: 'published',
    headline: 'Desk headline', dek: 'Desk deck', body_md: `Desk prose ${words(600)}`,
    model_version: 'openai:gpt-5.6-sol/editorial-desk-openai-v1',
    sources: row.sources.filter((s) => s.kind !== 'editorial_input').map((s) => (s.kind === 'fact_block' ? { ...s, hash: 'pre-digest-generator' } : s)),
  };
  const h = writerHarness([legacy]);
  try {
    await writeArticles(WENV, { now: Date.parse('2026-09-29T12:00:00Z'), types: 'preview' });
    const p = h.written.find((w) => w.table === 'ufc_articles' && w.method === 'PATCH').payload;
    const after = { ...legacy, ...p };
    const e = automaticEligibility(after);
    assert.equal(e.eligible, false);
    assert.equal(e.reason, 'digest_legacy_baseline', 'legacy upgrade = 0 automatic calls');
    const sb = store([after]);
    const o = openai();
    await pass(sb, o.fetchImpl);
    assert.equal(o.calls.length, 0);
  } finally { h.restore(); }
});

/* ---- the Worker: no automatic Anthropic fallback ------------------------- */

test('Worker: an OpenAI outage never falls through to the Anthropic desk', async () => {
  const real = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    hosts.push(new URL(u).host);
    if (u.startsWith('https://api.openai.com/')) return { ok: false, status: 503, json: async () => ({ error: 'down' }) };
    if (u.includes('/rest/v1/ufc_articles') && (init.method || 'GET') === 'GET') {
      const body = JSON.stringify([draft('w')]);
      return { ok: true, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
    }
    return { ok: true, headers: { get: () => null }, text: async () => '[]', json: async () => [] };
  };
  try {
    const env = { ...WENV, OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', ADMIN_TRIGGER_TOKEN: 'tok' };
    const res = await worker.fetch(new Request('https://x/admin/polish', { method: 'POST', headers: { 'x-pbe-admin-token': 'tok' } }), env);
    const body = await res.json();
    assert.equal(body.desk, 'openai');
    assert.equal(body.model_calls, 1);
    assert.ok(!hosts.includes('api.anthropic.com'), 'no automatic Anthropic call');
    const health = await (await worker.fetch(new Request('https://x/health'), env)).json();
    assert.equal(health.editorial_policy.automatic_max_attempts, 1);
    assert.equal(health.editorial_policy.digest_version, DIGEST_VERSION);
  } finally { globalThis.fetch = real; }
});

test('the automatic path cannot be talked into a second attempt', async () => {
  const sb = store([draft('m')]);
  const o = openai({ pass: false });
  await pass(sb, o.fetchImpl, { maxAttempts: 2 });
  assert.equal(o.calls.length, 1);
});

test('pipelineEventSink never throws', async () => {
  const sink = pipelineEventSink({ insert: async () => { throw new Error('db down'); } }, 'w');
  await sink({ status: 'ok', latency_ms: 1, article_id: 'x' });
});

test('writer: the current generator (no market_watch.status) publishes rather than holding for review', async () => {
  const row = await createdRow();
  assert.equal(row.fact_block.market_watch.status, undefined);
  assert.equal(row.status, 'published', String(row.fact_block.review_reason || ''));
});
