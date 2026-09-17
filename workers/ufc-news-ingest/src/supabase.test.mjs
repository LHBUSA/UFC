import test from 'node:test';
import assert from 'node:assert/strict';
import { Supabase } from './supabase.mjs';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('a URL duplicate in one row cannot abort unrelated new rows in the same batch', async () => {
  const calls = [];
  let countCalls = 0;
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });

    if ((init.method || 'GET') === 'GET' && u.includes('/rest/v1/ufc_news_items?select=id')) {
      countCalls += 1;
      const total = countCalls === 1 ? 10 : 11;
      return new Response('[]', { status: 200, headers: { 'content-range': `0-0/${total}` } });
    }

    if (init.method === 'POST' && u.includes('/rest/v1/ufc_news_items?on_conflict=fingerprint')) {
      const rows = JSON.parse(init.body || '[]');

      /* The fast-path bulk statement is atomic. One row reuses an existing URL
       * with an edited headline/fingerprint, so PostgreSQL rejects the WHOLE
       * statement on the secondary URL unique constraint. */
      if (rows.length === 2) {
        return jsonResponse({ code: '23505', message: 'duplicate key value violates unique constraint "ufc_news_items_url_key"' }, 409);
      }

      /* Row one is the edited existing story: still a duplicate. Row two is
       * genuinely new and must be allowed to land. */
      if (rows[0]?.url === 'https://publisher.test/existing') {
        return jsonResponse({ code: '23505', message: 'duplicate key value violates unique constraint "ufc_news_items_url_key"' }, 409);
      }
      if (rows[0]?.url === 'https://publisher.test/new') return new Response(null, { status: 201 });
    }

    throw new Error(`unexpected request ${init.method || 'GET'} ${u}`);
  };

  try {
    const sb = new Supabase(ENV);
    const inserted = await sb.insertIgnoringDuplicates('ufc_news_items', [
      { fingerprint: 'edited-headline-fp', url: 'https://publisher.test/existing', title: 'Edited headline' },
      { fingerprint: 'brand-new-fp', url: 'https://publisher.test/new', title: 'Brand new story' },
    ]);

    assert.equal(inserted, 1);
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 3, 'one failed bulk attempt plus two isolated row attempts');
    assert.equal(posts[0].body.length, 2);
    assert.equal(posts[1].body[0].url, 'https://publisher.test/existing');
    assert.equal(posts[2].body[0].url, 'https://publisher.test/new');
  } finally {
    globalThis.fetch = original;
  }
});

test('non-duplicate database failures still fail closed and are never replayed row by row', async () => {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET' });
    if ((init.method || 'GET') === 'GET') {
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/10' } });
    }
    return jsonResponse({ message: 'database unavailable' }, 503);
  };

  try {
    const sb = new Supabase(ENV);
    await assert.rejects(
      sb.insertIgnoringDuplicates('ufc_news_items', [
        { fingerprint: 'a', url: 'https://publisher.test/a' },
        { fingerprint: 'b', url: 'https://publisher.test/b' },
      ]),
      /503:.*database unavailable/,
    );
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'real database errors must not be masked by replay');
  } finally {
    globalThis.fetch = original;
  }
});
