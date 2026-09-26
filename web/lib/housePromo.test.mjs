/* PropBetEdge House Promo Engine: conversion first for free readers, contextual
 * discovery for entitled readers, SEO isolation.  Run: npm run test:house-promo */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./algo.test-hooks.mjs', import.meta.url);
const hp = await import('./housePromo.ts');
const { PRO_OFFER } = await import('./proOffer.ts');

const ctx = (over = {}) => ({ storyType: 'external', slug: 'some-story', headline: 'Some story', readerPro: false, algoActive: false, ...over });
const slugs = (n, p = 's') => Array.from({ length: n }, (_, i) => `${p}-${i}-${(i * 2654435761 >>> 0).toString(36)}`);
const tally = (cases) => { const t = {}; for (const c of cases) { const id = hp.selectPromo(c).campaign.id; t[id] = (t[id] || 0) + 1; } return t; };
const TYPES = ['fight_preview', 'results', 'rankings', 'weigh_in', 'card_change', 'external', 'line_move'];
const HEADLINES = ['Some story', 'The Ultimate Fighter 34 cast announced', 'The numbers behind a title demand'];

/* ================= free readers: always UFC Pro ================= */

test('a reader without UFC Pro always gets UFC Pro, for every story class and slug', () => {
  for (const s of slugs(1500)) for (const storyType of TYPES) for (const headline of HEADLINES) for (const algoActive of [false, true]) {
    const p = hp.selectPromo(ctx({ slug: s, storyType, headline, algoActive }));
    assert.equal(p.campaign.id, 'pro', `${storyType}/${headline}/${s}`);
    assert.equal(p.campaign.href, '/pro');
    assert.equal(p.campaign.cta, 'Get UFC Pro');
    assert.equal(p.campaign.eyebrow, 'From PropBetEdge · UFC Pro');
  }
});

test('no free internal campaign can win the primary slot for a free reader', () => {
  const t = tally(slugs(5000).flatMap((s) => TYPES.map((storyType) => ctx({ slug: s, storyType }))));
  assert.deepEqual(Object.keys(t), ['pro']);
});

test('Pro copy is contextual to the story class', () => {
  const heads = (storyType, headline = 'x') => new Set(slugs(200).map((s) => hp.selectPromo(ctx({ slug: s, storyType, headline })).headline));
  assert.deepEqual([...heads('weigh_in')].sort(), ['Follow fight week with the full intelligence layer', 'Know what changed — and what it means']);
  assert.deepEqual([...heads('card_change')].sort(), ['Follow fight week with the full intelligence layer', 'Know what changed — and what it means']);
  assert.deepEqual([...heads('fight_preview')].sort(), ['Go deeper before the first horn', 'See the matchup beneath the headline']);
  assert.deepEqual([...heads('results')].sort(), ['Go beyond the result', 'See the fight beneath the scorecard']);
  assert.ok(heads('rankings').size >= 1 && ![...heads('rankings')].some((h) => heads('results').has(h)));
  const a = hp.selectPromo(ctx({ slug: 'fixed', storyType: 'results' })), b = hp.selectPromo(ctx({ slug: 'fixed', storyType: 'results' }));
  assert.equal(a.headline, b.headline, 'deterministic per article');
});

test('pricing comes from PRO_OFFER, never a literal', () => {
  const body = hp.selectPromo(ctx({ storyType: 'results' })).campaign.body;
  assert.ok(body.includes(`${PRO_OFFER.plans.monthly.display}/month or ${PRO_OFFER.plans.weekly.display}/week · cancel anytime`), body);
  const src = readFileSync(new URL('./housePromo.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /\$\d+\.\d\d/, 'no hard-coded price in the promo engine');
  assert.ok(body.split(/(?<=\.)\s+(?=[A-Z$])/).length <= 2, 'at most two sentences');
});

test('the Pro card names PBE Algo only while it is issuing official calls', () => {
  assert.doesNotMatch(hp.selectPromo(ctx({ storyType: 'weigh_in', algoActive: false })).campaign.body, /Algo/);
  assert.match(hp.selectPromo(ctx({ storyType: 'weigh_in', algoActive: true })).campaign.body, /PBE Algo calls/);
});

/* ================= entitled readers: contextual discovery ================= */

const pro = (over = {}) => ctx({ readerPro: true, ...over });

test('a Pro or owner reader never gets the Pro upsell and always gets a campaign', () => {
  /* The owner resolves to access.pro === true (lib/accessDecision), so this is the owner case too. */
  for (const s of slugs(2000)) for (const storyType of TYPES) {
    const p = hp.selectPromo(pro({ slug: s, storyType }));
    assert.notEqual(p.campaign.id, 'pro');
    assert.ok(p.campaign && p.headline);
  }
  const sv = readFileSync(new URL('../components/StoryView.tsx', import.meta.url), 'utf8');
  assert.match(sv, /readerPro: access\.pro/, 'entitlement comes from the server access decision (owner included)');
});

test('entitled rotation is deterministic, spread and contextual', () => {
  for (const s of slugs(50)) assert.equal(hp.selectPromo(pro({ slug: s })).campaign.id, hp.selectPromo(pro({ slug: s })).campaign.id);
  const share = (over, id, n = 3000) => (tally(slugs(n).map((s) => pro({ ...over, slug: s })))[id] || 0) / n;
  assert.ok(Object.keys(tally(slugs(24, 'art').map((s, i) => pro({ slug: s, storyType: TYPES[i % TYPES.length] })))).length >= 4);
  assert.ok(share({ storyType: 'results' }, 'round_by_round') > 0.3);
  assert.ok(share({ storyType: 'weigh_in' }, 'fight_week') > 0.35);
  assert.ok(share({ storyType: 'external', headline: 'The Ultimate Fighter 34 cast announced' }, 'tuf') > 0.4);
  assert.ok(share({ storyType: 'external', headline: 'The numbers behind a title demand' }, 'ufc_api') > 0.45);
  const moved = slugs(200).filter((s) => hp.selectPromo(pro({ slug: s }), 'v1').campaign.id !== hp.selectPromo(pro({ slug: s }), 'v2').campaign.id).length;
  assert.ok(moved > 40, 'a new rotation version re-deals');
});

test('PBE Algo cannot appear unless active, and enters entitled rotation through product state', () => {
  const previews = slugs(3000).map((s) => pro({ slug: s, storyType: 'fight_preview' }));
  assert.equal(tally(previews).algo || 0, 0);
  assert.equal(tally(slugs(3000).map((s) => ctx({ slug: s, storyType: 'fight_preview', algoActive: true }))).algo || 0, 0, 'a free reader still gets Pro');
  assert.ok((tally(previews.map((c) => ({ ...c, algoActive: true }))).algo || 0) > 450);
  for (const c of previews) {
    const before = hp.selectPromo(c).campaign.id, after = hp.selectPromo({ ...c, algoActive: true }).campaign.id;
    assert.ok(after === before || after === 'algo');
  }
});

test('stableFraction stays inside (0, 1)', () => {
  for (const s of slugs(20000)) { const f = hp.stableFraction(s); assert.ok(f > 0 && f < 1); }
});

/* ================= shared card rules ================= */

test('the secondary network row remains, and never duplicates a cross-sport primary', () => {
  assert.equal(hp.selectPromo(ctx()).network.length, 6, 'free reader keeps the Also from PropBetEdge row');
  assert.ok(hp.selectPromo(ctx()).network.some((n) => n.key === 'tennis' && n.label === 'Tennis' && n.href === 'https://tennis.propbetedge.ai/'), 'Tennis is in the network row');
  assert.ok(!hp.CAMPAIGNS.some((c) => c.id === 'network_tennis'), 'no Tennis guest campaign');
  const nfl = slugs(20000).map((s) => hp.selectPromo(pro({ slug: s, storyType: 'fight_preview' }))).find((p) => p.campaign.id === 'network_nfl');
  assert.ok(nfl);
  assert.ok(!nfl.network.some((n) => n.key === 'nfl'));
  assert.equal(nfl.network.length, 5);
});

test('registry destinations are verified live routes only', () => {
  for (const c of hp.CAMPAIGNS) {
    assert.match(c.href, /^(\/(pro|learn\/fight-dna|fight-week|algo|round-by-round|tuf|store)|https:\/\/(ufc\.proptechusa\.ai|(mlb|nfl|nhl|nba|wnba)\.propbetedge\.ai\/))$/, c.id);
    for (const h of c.headlines) assert.ok(h.length <= 60, `${c.id}: ${h}`);
  }
});

const WEB = new URL('../', import.meta.url);
const src = (f) => readFileSync(new URL(f, WEB), 'utf8');

test('one primary promo only, after the story, outside JSON-LD and metadata; no vendor or tracking params', () => {
  const sv = src('components/StoryView.tsx');
  assert.equal((sv.match(/<HousePromo /g) || []).length, 1);
  const at = sv.indexOf('<HousePromo ');
  assert.ok(sv.indexOf('<h1>') < at && sv.indexOf('<ArticleBody') < at);
  assert.doesNotMatch(sv.slice(sv.indexOf('<JsonLd data={{')), /promo|Promo|campaign/);
  assert.doesNotMatch(src('app/news/[slug]/page.tsx'), /housePromo|HousePromo/);
  for (const f of ['components/HousePromo.tsx', 'components/HousePromoLink.tsx', 'lib/housePromo.ts', 'app/api/ufc/house-promo/route.ts']) {
    assert.doesNotMatch(src(f), /utm_|gtag|googletagmanager|sponsored|<script|document\.cookie|cookies\(/i, f);
  }
});
