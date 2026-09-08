/* The writer path the Worker actually runs. Run: node --test src/writer_path.test.mjs
 *
 * These tests exist because the previous ones could not have caught the bug
 * they were meant to cover. They exercised workers/ufc-newsroom/src/anthropic.mjs
 * — a helper the writer never called — and proved that IT behaved well when a
 * provider failed. Meanwhile the Worker enabled the writer's own, different
 * Anthropic path by assigning process.argv before the call, which cannot
 * change constants the module computed at import. Every scheduled article was
 * a template, the tests were green, and the two facts were unrelated.
 *
 * So everything below drives phases.runWrite -> scripts/news/write_articles.js
 * for real, against a fake PostgREST and a fake Anthropic. The assertion that
 * matters is not "the helper returned null" but "the row that reached the
 * database is the template" and "a request actually left for the model".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWrite } from './phases.mjs';

const ENV = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

/* A wire item that qualifies for an `external` story: a scored label over the
 * threshold, a confidence over the threshold, and one of our own fighters. */
const NEWS_ITEM = {
  id: 'news-1',
  source_id: 'src-1',
  url: 'https://example.invalid/story',
  title: 'Jane Doe moves up the rankings after her latest win',
  published_at: null,
  summary: 'A short wire summary about the ranking move.',
  /* 'rankings' is one of EXTERNAL_STORY_LABELS and scores above the 0.6 gate;
   * an item that qualifies is the only kind that produces a story at all. */
  taxonomy: { labels: ['rankings'], confidence: 0.9, scores: { rankings: 0.9 } },
  fighter_ids: ['f-1'],
  bout_id: null,
  event_id: null,
  captured_at: null,
};

const FIGHTER = {
  id: 'f-1', ufcstats_id: null, espn_athlete_id: null, name: 'Jane Doe', nickname: null,
  dob: '1995-01-01', record_w: 10, record_l: 2, record_d: 0, record_nc: 0,
  height_in: 66, reach_in: 68, stance: 'Orthodox', weight_lbs: 135,
  career_slpm: 4.1, career_str_acc: 0.45, career_sapm: 3.2, career_str_def: 0.6,
  career_td_avg: 1.5, career_td_acc: 0.4, career_td_def: 0.7, career_sub_avg: 0.5,
  source_url: 'https://example.invalid/jane',
};

/**
 * A PostgREST + Anthropic stand-in.
 *
 * `anthropic` decides what the model does; every article row the writer sends
 * is captured so a test can read what was actually about to be stored, which
 * is the only place the template-vs-rewrite question is finally settled.
 */
function harness({ anthropic = null, existingArticles = [] } = {}) {
  const rows = {
    ufc_fighters: [FIGHTER],
    ufc_fighter_aliases: [],
    ufc_events: [],
    ufc_bouts: [],
    ufc_bout_results: [],
    ufc_bout_round_stats: [],
    ufc_images: [],
    ufc_articles: existingArticles,
    ufc_news_items: [NEWS_ITEM],
    ufc_news_sources: [{ id: 'src-1', name: 'Example Wire', url: 'https://example.invalid/feed' }],
  };
  const written = [];
  const modelCalls = [];
  const real = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';

    if (u.startsWith(ANTHROPIC)) {
      modelCalls.push(JSON.parse(init.body));
      if (!anthropic) throw new Error('no anthropic behaviour configured for this test');
      return anthropic(JSON.parse(init.body));
    }

    if (!u.includes('/rest/v1/')) throw new Error(`unexpected network call: ${u}`);
    const table = u.split('/rest/v1/')[1].split('?')[0];

    if (method === 'GET') {
      const body = JSON.stringify(rows[table] ?? []);
      return {
        ok: true,
        headers: { get: (h) => (h.toLowerCase() === 'content-range' ? `0-0/${(rows[table] ?? []).length}` : null) },
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    }
    if (method === 'POST' || method === 'PATCH') {
      const payload = init.body ? JSON.parse(init.body) : null;
      written.push({ table, method, payload });
      /* Reflect the insert back so the writer's world map stays consistent. */
      const back = JSON.stringify(Array.isArray(payload) ? payload : [payload]);
      return { ok: true, headers: { get: () => null }, text: async () => back, json: async () => JSON.parse(back) };
    }
    throw new Error(`unexpected ${method} ${u}`);
  };

  return {
    written,
    modelCalls,
    restore: () => { globalThis.fetch = real; },
    /** The article rows the writer tried to store. */
    articles: () => written.filter((w) => w.table === 'ufc_articles').flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload])),
  };
}

const anthropicReply = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] }),
});

/* ---- 1. no key: the writer runs, and never reaches for a model ----------- */

test('Worker llm:false — the template is written and no model is called', async () => {
  const h = harness();
  try {
    const result = await runWrite(ENV, fakeSb(h), { now: Date.parse('2026-09-08T12:00:00Z') });
    const arts = h.articles();
    assert.ok(arts.length >= 1, 'the writer must produce an article from the fixture');
    assert.equal(arts[0].model_version, 'template-2', 'with no key the stored body is the template');
    assert.equal(h.modelCalls.length, 0, 'and nothing was sent to Anthropic');
    assert.equal(result.enhancement, 'deterministic only');
  } finally { h.restore(); }
});

/* ---- 2. key present: the REAL writer path calls the model ---------------- */

test('Worker llm:true — the writer itself calls Anthropic, and the rewrite is stored', async () => {
  /* This is the regression. Under the old process.argv approach the writer's
   * LLM constant was already false by the time the Worker set the flag, so
   * modelCalls stayed empty and model_version stayed 'template-2' — with
   * every existing test still passing. */
  let draft = null;
  const h = harness({
    anthropic: (body) => {
      draft = String(body.messages[0].content).split('DRAFT:\n')[1];
      /* A rewrite that changes only wording passes the writer's gate: same
       * headings, same links, same numbers, similar length. */
      return anthropicReply(draft.replace('This is a report from', 'This is a dispatch from'));
    },
  });
  try {
    const result = await runWrite({ ...ENV, ANTHROPIC_API_KEY: 'test-key' }, fakeSb(h), { now: Date.parse('2026-09-08T12:00:00Z') });
    assert.equal(h.modelCalls.length > 0, true, 'the writer must actually reach Anthropic when a key is configured');
    assert.equal(result.enhancement, 'anthropic offered');

    const call = h.modelCalls[0];
    assert.match(String(call.messages[0].content), /FACT BLOCK:/, 'the writer sends its own fact-block prompt, not a generic one');
    assert.equal(call.model, 'claude-sonnet-5');
    assert.deepEqual(call.thinking, { type: 'adaptive' }, 'the writer’s own call shape, not the deleted helper’s');
  } finally { h.restore(); }
});

/* ---- 3. the provider fails: the article still publishes ------------------ */

test('provider failure — every kind — leaves the deterministic article intact', async () => {
  const failures = {
    'http 500': () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    refusal: () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'refusal', content: [] }) }),
    truncated: () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'half a' }] }) }),
    empty: () => anthropicReply(''),
    thrown: () => { throw new Error('connection reset'); },
  };

  for (const [name, behaviour] of Object.entries(failures)) {
    const h = harness({ anthropic: behaviour });
    try {
      await runWrite({ ...ENV, ANTHROPIC_API_KEY: 'test-key' }, fakeSb(h), { now: Date.parse('2026-09-08T12:00:00Z') });
      const arts = h.articles();
      assert.ok(arts.length >= 1, `${name}: an article must still be written`);
      assert.equal(arts[0].model_version, 'template-2', `${name}: the template is what gets stored`);
      assert.ok(arts[0].body_md.length > 0, `${name}: with a real body`);
    } finally { h.restore(); }
  }
});

/* ---- 4. the model answers, and the gate refuses it ----------------------- */

test('a rewrite that breaks the editorial rules is discarded, not published', async () => {
  /* Each mutation must violate its rule for ANY draft this fixture produces,
   * so they add rather than edit: a short external story may carry no heading
   * or link to change, and a mutation that silently no-ops would sail through
   * the gate and leave the test asserting nothing. */
  const cases = {
    'invented number': (d) => `${d}\n\nJane Doe has won 47 straight.`,
    'structure changed': (d) => `${d}\n- an added list line`,
    'link added': (d) => `${d}\n\n[an invented link](/fighters/someone-else)`,
    'length drift': (d) => d.split(' ').slice(0, 5).join(' '),
  };

  for (const [name, mutate] of Object.entries(cases)) {
    const h = harness({
      anthropic: (body) => anthropicReply(mutate(String(body.messages[0].content).split('DRAFT:\n')[1])),
    });
    try {
      await runWrite({ ...ENV, ANTHROPIC_API_KEY: 'test-key' }, fakeSb(h), { now: Date.parse('2026-09-08T12:00:00Z') });
      const arts = h.articles();
      assert.ok(arts.length >= 1, `${name}: an article must still be written`);
      assert.equal(arts[0].model_version, 'template-2', `${name}: a rejected rewrite must leave the template in place`);
      assert.ok(!/47 straight/.test(arts[0].body_md), `${name}: no rejected text may reach the row`);
    } finally { h.restore(); }
  }
});

/** The Supabase wrapper the phase uses for its own counters — same fake fetch. */
function fakeSb(h) {
  return {
    async count(table) {
      const res = await globalThis.fetch(`https://db.invalid/rest/v1/${table}?select=id`, { method: 'GET' });
      const n = Number((res.headers.get('content-range') || '/0').split('/')[1]);
      return Number.isFinite(n) ? n : 0;
    },
  };
}
