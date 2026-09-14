/* PropBetEdge House Promo Engine: eligibility, deterministic rotation,
 * contextual weighting, SEO isolation.  Run: npm run test:house-promo */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./algo.test-hooks.mjs', import.meta.url);
const hp = await import('./housePromo.ts');

const ctx = (over = {}) => ({ storyType: 'external', slug: 'some-story', headline: 'Some story', readerPro: false, algoActive: false, ...over });
const slugs = (n, p = 's') => Array.from({ length: n }, (_, i) => `${p}-${i}-${(i * 2654435761 >>> 0).toString(36)}`);
const tally = (cases) => { const t = {}; for (const c of cases) { const id = hp.selectPromo(c).campaign.id; t[id] = (t[id] || 0) + 1; } return t; };

test('registry: every campaign has copy within the card budget and a verified destination', () => {
  const ids = hp.CAMPAIGNS.map((c) => c.id);
  for (const want of ['ufc_api', 'pro', 'fight_dna', 'fight_week', 'algo', 'round_by_round', 'tuf', 'store', 'network_nfl', 'network_mlb', 'network_nhl', 'network_nba', 'network_wnba']) assert.ok(ids.includes(want), want);
  assert.ok(!ids.includes('network_ufc'));
  for (const c of hp.CAMPAIGNS) {
    assert.match(c.href, /^(\/(pro|learn\/fight-dna|fight-week|algo|round-by-round|tuf|store)|https:\/\/(ufc\.proptechusa\.ai|(mlb|nfl|nhl|nba|wnba)\.propbetedge\.ai\/))$/, c.id);
    assert.ok(c.body.split(/(?<=[.!?])\s+/).length <= 2, `${c.id}: at most two sentences`);
    for (const h of c.headlines) assert.ok(h.length <= 60, `${c.id}: ${h}`);
    assert.doesNotMatch(`${c.headlines.join(' ')} ${c.body}`, /\bbest\b|guarantee|lock of|sure thing|free trial/i, c.id);
  }
});

test('deterministic: same article, same campaign and headline on every call; version re-deals', () => {
  for (const s of slugs(50)) {
    const a = hp.selectPromo(ctx({ slug: s })), b = hp.selectPromo(ctx({ slug: s }));
    assert.equal(a.campaign.id, b.campaign.id); assert.equal(a.headline, b.headline);
  }
  const moved = slugs(200).filter((s) => hp.selectPromo(ctx({ slug: s }), 'v1').campaign.id !== hp.selectPromo(ctx({ slug: s }), 'v2').campaign.id).length;
  assert.ok(moved > 40, `a new rotation version re-deals (${moved}/200 moved)`);
});

test('distribution: 20 representative articles spread across several campaigns', () => {
  const types = ['fight_preview', 'results', 'rankings', 'weigh_in', 'card_change', 'external'];
  const cases = slugs(24, 'art').map((s, i) => ctx({ slug: s, storyType: types[i % types.length] }));
  const t = tally(cases);
  assert.ok(Object.keys(t).length >= 4, JSON.stringify(t));
});

test('contextual weighting follows the story class', () => {
  const share = (over, id, n = 3000) => (tally(slugs(n).map((s) => ctx({ ...over, slug: s })))[id] || 0) / n;
  assert.ok(share({ storyType: 'results' }, 'round_by_round') > 0.3, 'results favour Round-by-Round');
  assert.ok(share({ storyType: 'weigh_in' }, 'fight_week') > 0.35, 'weigh-ins favour Fight Week');
  assert.ok(share({ storyType: 'rankings' }, 'fight_dna') > 0.3, 'rankings favour Fight DNA');
  assert.ok(share({ storyType: 'external', headline: 'The Ultimate Fighter 34 cast announced' }, 'tuf') > 0.4, 'TUF stories favour TUF');
  assert.ok(share({ storyType: 'external', headline: 'The numbers behind a title demand' }, 'ufc_api') > 0.45, 'data stories favour the API');
  assert.equal(share({ storyType: 'results' }, 'tuf'), 0, 'TUF never rides on a results story');
  const net = ['mlb', 'nfl', 'nhl', 'nba', 'wnba'].reduce((a, k) => a + share({ storyType: 'fight_preview' }, `network_${k}`), 0);
  assert.ok(net > 0 && net < 0.08, `cross-network stays occasional (${net})`);
  assert.equal(hp.classifyStory({ storyType: 'weigh_in', slug: 'x', headline: 'Official weigh-in results' }), 'fight_week');
});

test('eligibility beats rotation: Pro readers never see the Pro upsell and still get a campaign', () => {
  for (const s of slugs(2000)) {
    for (const storyType of ['fight_preview', 'results', 'rankings', 'weigh_in', 'external']) {
      const pick = hp.selectPromo(ctx({ slug: s, storyType, readerPro: true }));
      assert.notEqual(pick.campaign.id, 'pro');
      assert.ok(pick.campaign && pick.headline);
    }
  }
  // Non-Pro readers of the same articles do get it somewhere.
  assert.ok(slugs(500).some((s) => hp.selectPromo(ctx({ slug: s, storyType: 'fight_preview' })).campaign.id === 'pro'));
});

test('PBE Algo appears only through product state, and enters rotation automatically when active', () => {
  const previews = slugs(3000).map((s) => ctx({ slug: s, storyType: 'fight_preview' }));
  assert.equal(tally(previews).algo || 0, 0, 'inactive Algo never appears');
  const on = tally(previews.map((c) => ({ ...c, algoActive: true }))).algo || 0;
  assert.ok(on > 450, `active Algo takes its preview weight (${on}/3000)`);
  // Going live only moves articles INTO Algo; every other article keeps its campaign.
  for (const c of previews) {
    const before = hp.selectPromo(c).campaign.id, after = hp.selectPromo({ ...c, algoActive: true }).campaign.id;
    assert.ok(after === before || after === 'algo', `${c.slug}: ${before} -> ${after}`);
  }
});

test('a Pro reader moves only off the Pro campaign; other articles are unchanged', () => {
  for (const s of slugs(3000)) {
    const anon = hp.selectPromo(ctx({ slug: s, storyType: 'fight_preview' })).campaign.id;
    const pro = hp.selectPromo(ctx({ slug: s, storyType: 'fight_preview', readerPro: true })).campaign.id;
    if (anon !== 'pro') assert.equal(pro, anon, s);
  }
});

test('stableFraction stays inside (0, 1) for every key', () => {
  for (const s of slugs(20000)) { const f = hp.stableFraction(s); assert.ok(f > 0 && f < 1, String(f)); }
});

test('real-slug spread: long shared suffixes do not bias the draw', () => {
  const real = Array.from({ length: 400 }, (_, i) => `fighter-${i}-vs-opponent-${(i * 7919) % 997}-preview-2026-09-19`);
  const t = tally(real.map((s) => ctx({ slug: s, storyType: 'fight_preview' })));
  const net = ['mlb', 'nfl', 'nhl', 'nba', 'wnba'].reduce((a, k) => a + (t[`network_${k}`] || 0), 0) / 400;
  assert.ok(net < 0.12, `network share ${net}`);
  assert.ok((t.pro || 0) / 400 > 0.18, `pro share ${(t.pro || 0) / 400}`);
});

test('secondary row never duplicates the primary cross-sport destination', () => {
  const nfl = slugs(20000).map((s) => hp.selectPromo(ctx({ slug: s, storyType: 'fight_preview' }))).find((p) => p.campaign.id === 'network_nfl');
  assert.ok(nfl, 'an NFL campaign exists in rotation');
  assert.ok(!nfl.network.some((n) => n.key === 'nfl'));
  assert.equal(nfl.network.length, 4);
  const house = hp.selectPromo(ctx({ slug: 'x', storyType: 'results' }));
  assert.equal(house.network.length, 5);
});

const WEB = new URL('../', import.meta.url);
const src = (f) => readFileSync(new URL(f, WEB), 'utf8');

test('SEO isolation: one promo, after the story, outside JSON-LD and metadata; no vendor or tracking params', () => {
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
