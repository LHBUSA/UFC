import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callOpenAI,
  isConfigured,
  runOpenAIEditorial,
  DEFAULT_MODEL,
} from './openai_editorial.mjs';

function responseFor(payload, model = DEFAULT_MODEL) {
  return {
    ok: true,
    json: async () => ({
      status: 'completed',
      model,
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(payload) }],
      }],
    }),
  };
}

function longBody(words = 190) {
  const token = 'evidence';
  return Array.from({ length: words }, () => token).join(' ');
}

test('OPENAI_API_KEY presence is the only OpenAI configuration signal', () => {
  assert.equal(isConfigured({ OPENAI_API_KEY: 'test-key' }), true);
  assert.equal(isConfigured({ OPENAI_API_KEY: '' }), false);
  assert.equal(isConfigured({}), false);
});

test('Responses API request uses the Worker secret and strict structured output', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init, body: JSON.parse(init.body) };
    return responseFor({
      headline: 'A sufficiently long evidence-led headline',
      dek: 'A sufficiently long evidence-led deck for the structured response test.',
      body_md: longBody(),
    });
  };

  const result = await callOpenAI('test-secret', {
    input: 'source packet',
    fetchImpl,
  });

  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer test-secret');
  assert.equal(seen.body.model, DEFAULT_MODEL);
  assert.equal(seen.body.store, false);
  assert.equal(seen.body.text.format.type, 'json_schema');
  assert.equal(seen.body.text.format.strict, true);
  assert.deepEqual(seen.body.text.format.schema.required.sort(), ['body_md', 'dek', 'headline']);
});

test('OpenAI editorial pass patches only an accepted published article', async () => {
  const patches = [];
  const article = {
    id: 'article-1',
    slug: 'evidence-story',
    headline: 'Existing sufficiently long article headline',
    dek: 'Existing sufficiently long article deck that is already published.',
    body_md: 'existing body without links',
    story_type: 'external',
    status: 'published',
    fact_block: { depth: { short: true } },
    sources: {},
    model_version: 'template-2',
    updated_at: '2026-09-09T18:00:00.000Z',
  };

  const sb = {
    select: async () => [article],
    patch: async (table, filter, body) => { patches.push({ table, filter, body }); },
  };

  const fetchImpl = async () => responseFor({
    headline: 'Evidence-led editorial headline for testing',
    dek: 'Evidence-led editorial deck that clears the deterministic minimum length.',
    body_md: longBody(190),
  });

  const result = await runOpenAIEditorial(
    { OPENAI_API_KEY: 'test-key', UFC_EDITORIAL_OPENAI_MODEL: DEFAULT_MODEL },
    sb,
    {
      now: Date.parse('2026-09-09T19:00:00.000Z'),
      limit: 1,
      recentHours: 24,
      fetchImpl,
    },
  );

  assert.equal(result.status, 'ran');
  assert.equal(result.passed, 1);
  assert.equal(result.held, 0);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].table, 'ufc_articles');
  assert.equal(patches[0].filter, 'id=eq.article-1');
  assert.match(patches[0].body.model_version, /^openai:gpt-5\.6-sol\/editorial-desk-openai-v1$/);
});

test('already OpenAI-polished articles are idempotently skipped', async () => {
  let modelCalls = 0;
  const sb = {
    select: async () => [{
      id: 'article-2',
      slug: 'already-polished',
      headline: 'Already polished article headline here',
      dek: 'Already polished article deck with enough length for the test.',
      body_md: longBody(190),
      story_type: 'external',
      status: 'published',
      fact_block: { depth: { short: true } },
      sources: {},
      model_version: 'openai:gpt-5.6-sol/editorial-desk-openai-v1',
      updated_at: '2026-09-09T18:00:00.000Z',
    }],
    patch: async () => { throw new Error('must not patch'); },
  };

  const result = await runOpenAIEditorial(
    { OPENAI_API_KEY: 'test-key' },
    sb,
    {
      now: Date.parse('2026-09-09T19:00:00.000Z'),
      fetchImpl: async () => { modelCalls += 1; throw new Error('must not call model'); },
    },
  );

  assert.equal(result.skipped, 1);
  assert.equal(result.passed, 0);
  assert.equal(modelCalls, 0);
});

test('provider failure holds the article and never patches it', async () => {
  let patched = false;
  const sb = {
    select: async () => [{
      id: 'article-3',
      slug: 'held-story',
      headline: 'Held story existing headline that is long enough',
      dek: 'Held story existing deck that is long enough for the publication gate.',
      body_md: 'existing body',
      story_type: 'external',
      status: 'published',
      fact_block: { depth: { short: true } },
      sources: {},
      model_version: 'template-2',
      updated_at: '2026-09-09T18:00:00.000Z',
    }],
    patch: async () => { patched = true; },
  };

  await assert.rejects(
    () => runOpenAIEditorial(
      { OPENAI_API_KEY: 'test-key' },
      sb,
      {
        now: Date.parse('2026-09-09T19:00:00.000Z'),
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'provider unavailable' } }),
        }),
      },
    ),
    /every candidate was held/,
  );
  assert.equal(patched, false);
});
