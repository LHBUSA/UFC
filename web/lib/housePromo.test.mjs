/* House promotion: one product, deterministic copy, SEO isolation.
 * Run: npm run test:house-promo */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./algo.test-hooks.mjs', import.meta.url);
const hp = await import('./housePromo.ts');

test('one product: the UFC Intelligence API, headline chosen by story type', () => {
  for (const t of ['fight_preview', 'results', 'rankings', 'external', 'card_change', 'weigh_in', 'line_move', 'unknown']) {
    const c = hp.promoFor(t);
    assert.equal(c.href, 'https://ufc.proptechusa.ai');
    assert.equal(c.cta, 'Explore the UFC API');
    assert.ok(c.headline.length <= 60, t);
    assert.ok(c.body.split(/(?<=\.)\s/).length <= 2, `${t}: at most two sentences`);
    assert.doesNotMatch(`${c.headline} ${c.body}`, /algo|pick|bet|odds/i, t);
  }
  assert.notEqual(hp.promoFor('fight_preview').headline, hp.promoFor('external').headline);
  assert.deepEqual(hp.promoFor('external'), hp.promoFor('weigh_in'), 'deterministic default');
});

test('network row lists only live https network properties, never this site', () => {
  const links = hp.networkLinks();
  assert.ok(links.length >= 3);
  for (const l of links) { assert.match(l.href, /^https:\/\/[a-z]+\.propbetedge\.ai\/$/); assert.notEqual(l.key, 'ufc'); }
});

const WEB = new URL('../', import.meta.url);
const src = (f) => readFileSync(new URL(f, WEB), 'utf8');

test('StoryView renders exactly one promo, after the story and outside JSON-LD', () => {
  const sv = src('components/StoryView.tsx');
  assert.equal((sv.match(/<HousePromo /g) || []).length, 1);
  const at = sv.indexOf('<HousePromo ');
  assert.ok(sv.indexOf('<h1>') < at && sv.indexOf('<ArticleBody') < at && sv.indexOf('renderMarkdown(a.body_md)') < at);
  assert.doesNotMatch(sv.slice(sv.indexOf('<JsonLd data={{')), /promo|Promo|ufcApi/);
  assert.doesNotMatch(src('components/plan.tsx'), /promo/i, 'the article body renderer carries no promo');
});

test('no promotional copy in metadata, no vendor script, no tracking parameters', () => {
  assert.doesNotMatch(src('app/news/[slug]/page.tsx'), /housePromo|HousePromo/);
  for (const f of ['components/HousePromo.tsx', 'components/HousePromoLink.tsx', 'lib/housePromo.ts']) {
    assert.doesNotMatch(src(f), /utm_|gtag|googletagmanager|sponsored|<script/i, f);
  }
});
