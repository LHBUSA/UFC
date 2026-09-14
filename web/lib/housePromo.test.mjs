/* House promotion: selection, placement ceiling, and SEO isolation.
 * Run: npm run test:house-promo */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./algo.test-hooks.mjs', import.meta.url);
const hp = await import('./housePromo.ts');
const { renderMarkdownBlocks } = await import('./markdown.ts');

const para = (n, w = 60) => Array.from({ length: n }, (_, i) => `Paragraph ${i} ${'word '.repeat(w)}`.trim());
const long = para(16).join('\n\n'); // ~990 words
const short = para(8).join('\n\n'); // ~500 words

test('inline campaign: data stories above the length floor only', () => {
  for (const t of ['fight_preview', 'results', 'rankings']) assert.equal(hp.inlineCampaign(t, long), 'ufc_api', t);
  for (const t of ['external', 'card_change', 'weigh_in', 'line_move']) assert.equal(hp.inlineCampaign(t, long), null, t);
  assert.equal(hp.inlineCampaign('fight_preview', short), null, 'short stories get no inline module');
  assert.equal(hp.INLINE_MIN_WORDS, 700);
});

test('inline slot sits after substantial editorial, after a paragraph, never at the end', () => {
  const blocks = renderMarkdownBlocks(long);
  const i = hp.inlineSlot(blocks);
  assert.ok(i != null);
  const before = blocks.slice(0, i).join(' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  assert.ok(before >= 250 && i >= 4, `slot ${i} after ${before} words`);
  assert.ok(blocks.length - i >= 2);
  assert.match(blocks[i - 1], /^<p>/);
});

test('inline slot never follows a heading and never sits beside a module', () => {
  const md = [...para(4), '## Section', ...para(8)].join('\n\n');
  const blocks = renderMarkdownBlocks(md);
  const free = hp.inlineSlot(blocks);
  assert.doesNotMatch(blocks[free - 1], /^<h/);
  const taken = hp.inlineSlot(blocks, new Set([free]));
  assert.ok(taken == null || Math.abs(taken - free) >= 2);
  assert.equal(hp.inlineSlot(renderMarkdownBlocks(para(3, 200).join('\n\n'))), null, 'no slot with <2 blocks left');
});

test('network module lists only live https network properties, never this site', () => {
  const links = hp.networkLinks();
  assert.ok(links.length >= 3);
  for (const l of links) { assert.match(l.href, /^https:\/\/[a-z]+\.propbetedge\.ai\/$/); assert.notEqual(l.key, 'ufc'); }
});

const WEB = new URL('../', import.meta.url);
const src = (f) => readFileSync(new URL(f, WEB), 'utf8');

test('ceiling: StoryView renders exactly one inline and one end promo, both outside JSON-LD', () => {
  const sv = src('components/StoryView.tsx');
  assert.equal((sv.match(/<HousePromoNetwork /g) || []).length, 1);
  assert.equal((sv.match(/<HousePromoInline /g) || []).length, 1);
  const ld = sv.slice(sv.indexOf('<JsonLd data={{'));
  assert.doesNotMatch(ld, /promo|Promo|ufcApi|PROMO_COPY/);
  // the promo is rendered after the H1, dek and byline
  assert.ok(sv.indexOf('<h1>') < sv.indexOf('promo={inlinePromo}'));
  assert.ok(sv.indexOf('<h1>') < sv.indexOf('{inlinePromo}'));
});

test('no promotional copy in metadata, no vendor script, no tracking parameters', () => {
  const page = src('app/news/[slug]/page.tsx');
  assert.doesNotMatch(page, /housePromo|HousePromo/);
  for (const f of ['components/HousePromo.tsx', 'components/HousePromoLink.tsx', 'lib/housePromo.ts']) {
    const s = src(f);
    assert.doesNotMatch(s, /utm_|gtag|googletagmanager|sponsored|<script/i, f);
  }
  assert.deepEqual(Object.keys(hp.PROMO_COPY), ['ufc_api'], 'PBE Algo is not a campaign until live');
});
