/* Golden regressions for --relink. node --test scripts/videos/relink_golden.test.mjs
 *
 * Every case is a failure the 2026-09-18 drift audit found in production
 * (docs/evidence/video-relink-drift-2026-09-18.md). The governing rule:
 *
 *   A historical video is resolved in historical context. The date the
 *   maintenance command happens to run never changes what event it belongs to.
 *
 * main() runs end to end against a stubbed PostgREST: GETs are answered from the
 * tables below and every write is recorded, so "zero writes" is measured. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './ingest_youtube.mjs';
import { linkEvent, linkFighters, linkVideo, contextAt, eventKeys, isHostMention, prepText, WINDOW_DAYS } from './lib.mjs';
import { destructiveReasons } from './relink_diff.mjs';

const RUN_DATE = '2026-09-18T15:00:00Z';
const ev = (id, name, event_date, city = null) => ({ id, name, event_date, venue: null, city, region: null, country: 'USA', card_status: 'complete' });
const EVENTS = [
  ev('ev-vegas35', 'UFC Fight Night: Barboza vs. Chikadze', '2021-08-28', 'Las Vegas'),
  ev('ev-gamrot', 'UFC Fight Night: Gamrot vs Salkilld', '2026-08-08', 'Las Vegas'),
  ev('ev-vegas-oct', 'UFC Fight Night: Someone vs Other', '2026-10-10', 'Las Vegas'),
  ev('ev-tuf26', 'The Ultimate Fighter: A New World Champion Finale', '2017-12-01', 'Las Vegas'),
  ev('ev-dwcs10', "Dana White's Contender Series: Season 10, Week 1", '2026-08-11', 'Las Vegas'),
  ev('ev-dwcs10b', "Dana White's Contender Series: Season 10, Week 5", '2026-09-08', 'Las Vegas'),
  ev('ev-2023', 'UFC Fight Night: Holm vs. Bueno Silva', '2023-07-15', 'Las Vegas'),
  ev('ev-333', 'UFC 333: Volkanovski vs. Evloev', '2026-10-24', 'Las Vegas'),
  ev('ev-paris', 'UFC Fight Night: Hooker vs. Parnasse', '2026-09-05', 'Paris'),
];
const F = (id, name, nickname = null) => ({ id, name, nickname, ufcstats_id: null, espn_athlete_id: null, dob: null });
const FIGHTERS = [
  F('f-barboza', 'Edson Barboza'), F('f-chikadze', 'Giga Chikadze'), F('f-omalley', "Sean O'Malley"), F('f-ware', 'Terrion Ware'),
  F('f-montano', 'Nicco Montano'), F('f-modafferi', 'Roxanne Modafferi'), F('f-chelsea', 'Chelsea Chandler'), F('f-michael', 'Michael Chandler'),
  F('f-dumont', 'Norma Dumont'), F('f-bisping', 'Michael Bisping'), F('f-parnasse', 'Salahdine Parnasse'), F('f-hooker', 'Dan Hooker'),
  F('f-volk', 'Alexander Volkanovski'), F('f-evloev', 'Movsar Evloev'), F('f-gamrot', 'Mateusz Gamrot'), F('f-salkilld', 'Quillan Salkilld'),
];
const bout = (id, event_id, a, b) => ({ id, event_id, fighter_a_id: a, fighter_b_id: b, status: 'completed', bout_order: 1 });
const BOUTS = [
  bout('b-vegas35', 'ev-vegas35', 'f-barboza', 'f-chikadze'), bout('b-gamrot', 'ev-gamrot', 'f-gamrot', 'f-salkilld'),
  bout('b-tuf26-main', 'ev-tuf26', 'f-montano', 'f-modafferi'), bout('b-tuf26-om', 'ev-tuf26', 'f-omalley', 'f-ware'),
  bout('b-2023', 'ev-2023', 'f-dumont', 'f-chelsea'), bout('b-333', 'ev-333', 'f-volk', 'f-evloev'), bout('b-paris', 'ev-paris', 'f-hooker', 'f-parnasse'),
];

const video = (id, title, published_at, links = {}, sm = {}, description = '') => ({
  id: `row-${id}`, provider_video_id: id, channel_name: 'UFC', channel_verified_source: true, url: `https://www.youtube.com/watch?v=${id}`,
  title, description, published_at, duration_sec: null, thumbnail_url: null, embeddable: true, live_broadcast_state: null,
  video_type: 'other', fighter_ids: [], event_id: null, bout_id: null, article_id: null, resolver_confidence: 'none', link_status: 'published',
  ...links, source_metadata: { discovery: 'public_playlist_page', language: 'en', ...sm },
});

/** A PostgREST stub. Every non-GET is recorded; the test asserts on that list. */
function stubDb(videos) {
  const writes = [];
  const tables = { ufc_video_channels: [{ provider: 'youtube', channel_id: 'UC-ufc', name: 'UFC', handle: '@ufc', channel_class: 'ufc_official', verified: true, enabled: true }], ufc_fighters: FIGHTERS, ufc_fighter_aliases: [], ufc_events: EVENTS, ufc_bouts: BOUTS, ufc_articles: [], ufc_videos: videos };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const table = String(url).split('/rest/v1/')[1].split('?')[0];
    if ((init.method || 'GET') !== 'GET') { writes.push({ method: init.method, table, body: JSON.parse(init.body || 'null') }); return { ok: true, status: 201, text: async () => init.body || '[]' }; }
    return { ok: true, status: 200, text: async () => JSON.stringify(tables[table] || []) };
  };
  return { writes, restore: () => { globalThis.fetch = real; } };
}
const ENV = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const relink = (videos, options = {}) => quiet(async () => {
  const db = stubDb(videos);
  try { const result = await main(ENV, { relink: true, now: RUN_DATE, ...options }); return { ...db, result }; } catch (error) { return { ...db, error }; } finally { db.restore(); }
});
const proposedFor = (run, id) => run.result.explained.find((e) => e.id === id) || null;

/* ---- the stored rows, as the audit found them ------------------------- */
const VEGAS35 = video('URxf3OfvLGs', 'Barboza vs Chikadze - Strikers Collide | Fight Preview | UFC Vegas 35', '2021-08-24T16:00:00Z', { event_id: 'ev-vegas35', fighter_ids: ['f-barboza', 'f-chikadze'], bout_id: 'b-vegas35', resolver_confidence: 'high' });
const VEGAS35_CITY = video('i5YGuNBfyM8', 'Giga Chikadze Octagon Interview | UFC Vegas 35', '2021-08-29T04:00:00Z', { event_id: 'ev-vegas35', fighter_ids: ['f-chikadze'], resolver_confidence: 'medium' });
const CONTENDER_STORIES = video('2p_a5R40c2c', "Contender Stories: Sean O'Malley", '2017-11-30T18:00:00Z', { fighter_ids: ['f-omalley'], resolver_confidence: 'medium' }, {}, "From Dana White's Contender Series to the Octagon.");
const AFTER_TUF = video('B-s6Qk-lYcU', 'After TUF: Team McGregor vs Team Chandler - Episode 9 | ESPN MMA', '2023-07-26T02:00:00Z');
const TUF_FINALE = video('eFjeoPKi4UU', 'The Ultimate Fighter Finale: Nicco Montano vs Roxanne Modafferi - New Fight, Same Dream', '2017-12-01T17:00:00Z', { event_id: 'ev-tuf26', bout_id: 'b-tuf26-main', fighter_ids: ['f-montano', 'f-modafferi'], resolver_confidence: 'high' });
const TUF_REJECTED = video('Kkeyn5VVO3U', 'The Ultimate Fighter: A New World Champion - Coaches Challenge', '2017-11-22T02:00:00Z', {}, {
  tuf: { season: 'tuf-26', episode: null, kind: 'coach_clip', evidence: { season: { from: 'playlist' } } },
  linking: { event: null, fighters: [], bout: null, article_candidates: 0, event_rejected: { event_id: 'ev-tuf26', name: 'The Ultimate Fighter: A New World Champion Finale', key: 'the ultimate fighter', kind: 'series', in_title: true, method: 'unique_key', supported: false, reason: 'tuf_series_key_without_finale_in_title' } },
});
const OCTAGON_INTERVIEW = video('c44IaeD85Fg', 'Salahdine Parnasse Octagon Interview | UFC Paris', '2026-09-05T22:00:00Z', { event_id: 'ev-paris', fighter_ids: ['f-parnasse'], resolver_confidence: 'medium' }, {}, 'Watch UFC on Paramount Plus\n\nListen to Salahdine Parnasse talk with Michael Bisping after his win at UFC Paris.');
const NO_DATE = video('nodate00001', 'UFC Vegas: Octagon Interview', null, { event_id: 'ev-vegas35', fighter_ids: ['f-chikadze'], resolver_confidence: 'medium' });
const ALL = [VEGAS35, VEGAS35_CITY, CONTENDER_STORIES, AFTER_TUF, TUF_FINALE, TUF_REJECTED, OCTAGON_INTERVIEW, NO_DATE];

test('1. a 2021 "UFC Vegas 35" video stays on the 2021 card, never a 2026 Vegas card', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  assert.equal(run.error, undefined);
  for (const v of [VEGAS35, VEGAS35_CITY]) {
    const d = proposedFor(run, v.provider_video_id);
    assert.ok(!d || !d.fields.includes('event_id'), `${v.provider_video_id} keeps its event`);
    assert.notEqual(d?.proposed.event_id, 'ev-gamrot');
  }
  /* The resolver itself, given the right context, picks 2021 by a name key... */
  const ctx2021 = contextAt({ events: EVENTS, bouts: BOUTS, articles: [] }, new Date(VEGAS35_CITY.published_at), WINDOW_DAYS);
  assert.deepEqual(ctx2021.events.map((e) => e.id), ['ev-vegas35'], 'only the cards around the publish date are visible');
  assert.equal(linkEvent(VEGAS35_CITY.title, VEGAS35_CITY.title, ctx2021, new Date(VEGAS35_CITY.published_at)).event.id, 'ev-vegas35');
});

test('2. nearest_date has a hard limit: a card 1,800 days away is not a match, even if it is the only one visible', () => {
  const asCtx = (events) => ({ events: events.map((e) => ({ ...e, alt_ids: [], ...eventKeys(e) })), bouts: [], cardFighterIds: new Set(), articlesByBout: new Map(), window: {} });
  const twoVegas2026 = asCtx([EVENTS[1], EVENTS[2]]);
  const r = linkEvent('Giga Chikadze Octagon Interview | UFC Vegas 35', 'Giga Chikadze Octagon Interview | UFC Vegas 35', twoVegas2026, new Date('2021-08-29T04:00:00Z'));
  assert.equal(r.event, null, 'the nearest visible event is not chosen');
  assert.equal(r.refused.reason, 'nearest_date_outside_window');
  assert.ok(r.refused.distance_days > 1800 && r.refused.limit_days === WINDOW_DAYS);
  /* Inside the window it still works exactly as before. */
  const near = linkEvent('Octagon Interview | UFC Vegas', 'Octagon Interview | UFC Vegas', twoVegas2026, new Date('2026-08-09T04:00:00Z'));
  assert.deepEqual([near.event.id, near.evidence.method, near.evidence.distance_days <= WINDOW_DAYS], ['ev-gamrot', 'nearest_date', true]);
  /* No publish date: nothing to be nearest to. Never "nearest to today". */
  const undated = linkEvent('Octagon Interview | UFC Vegas', 'Octagon Interview | UFC Vegas', twoVegas2026, null);
  assert.deepEqual([undated.event, undated.refused.reason], [null, 'publish_date_unavailable']);
});

test('3. 2017 "Contender Stories: Sean O\'Malley" is never attached to a 2026 DWCS week', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  const d = proposedFor(run, CONTENDER_STORIES.provider_video_id);
  assert.ok(!['ev-dwcs10', 'ev-dwcs10b'].includes(d?.proposed.event_id));
  assert.ok(!d || !d.destructive.includes('event_outside_window'));
});

test('4. 2023 "Team McGregor vs Team Chandler" does not gain Chelsea Chandler, in the 2023 window or any other', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  const d = proposedFor(run, AFTER_TUF.provider_video_id);
  assert.ok(!d || !d.added_fighters.includes('f-chelsea'), 'no surname-only attachment without a linked event');
  /* Chelsea Chandler IS the only Chandler on a card around July 2023: a window is a weak scope, which is why archive context needs an event. */
  const ctx2023 = contextAt({ events: EVENTS, bouts: BOUTS, articles: [] }, new Date(AFTER_TUF.published_at), WINDOW_DAYS);
  assert.ok(ctx2023.cardFighterIds.has('f-chelsea') && ctx2023.surnameRequiresEvent === true);
  const index = { fighters: FIGHTERS, byId: new Map(FIGHTERS.map((f) => [f.id, f])), aliasesByFighter: new Map() };
  assert.equal(linkFighters(AFTER_TUF.title, AFTER_TUF.title, index, ctx2023, null).fighters.size, 0);
});

test('5. a 2017 TUF finale video keeps its historical event and bout', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  const d = proposedFor(run, TUF_FINALE.provider_video_id);
  assert.ok(!d || (!d.fields.includes('event_id') && !d.fields.includes('bout_id')), JSON.stringify(d?.fields));
  const l = linkVideo({ title: TUF_FINALE.title, description: '', published: TUF_FINALE.published_at }, { fighters: FIGHTERS, byId: new Map(FIGHTERS.map((f) => [f.id, f])), aliasesByFighter: new Map() }, contextAt({ events: EVENTS, bouts: BOUTS, articles: [] }, new Date(TUF_FINALE.published_at), WINDOW_DAYS));
  assert.deepEqual([l.event_id, l.bout_id, l.resolver_confidence], ['ev-tuf26', 'b-tuf26-main', 'high']);
});

test('6. the TUF guard runs on relink: a stored event_rejected is reproduced, not erased', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  const d = proposedFor(run, TUF_REJECTED.provider_video_id);
  assert.ok(!d || d.proposed.event_id === null, 'the rejected event is not re-attached');
  assert.ok(!d || d.proposed.linking.event_rejected?.reason === 'tuf_series_key_without_finale_in_title', 'and the rejection is recorded again');
  assert.ok(!d || !d.fields.includes('event_id'));
});

test('7. an interviewer named only in the description is not a fighter on the video', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  const d = proposedFor(run, OCTAGON_INTERVIEW.provider_video_id);
  assert.ok(!d || !d.added_fighters.includes('f-bisping'));
  assert.equal(isHostMention(prepText('Listen to Axel Sola talk with Michael Bisping after his win at UFC Paris.'), 'michael bisping'), true);
  assert.equal(isHostMention(prepText('Michael Bisping vs Kelvin Gastelum full fight'), 'michael bisping'), false);
  assert.equal(isHostMention(prepText('Interviewed by Hall of Famer Michael Bisping'), 'michael bisping'), true);
  /* Descriptions still attach full names when the person is not introduced as the host... */
  const index = { fighters: FIGHTERS, byId: new Map(FIGHTERS.map((f) => [f.id, f])), aliasesByFighter: new Map() };
  const ctx = contextAt({ events: EVENTS, bouts: BOUTS, articles: [] }, new Date('2026-09-05T22:00:00Z'), WINDOW_DAYS);
  const subj = linkFighters('Octagon Interview | UFC Paris\nSalahdine Parnasse reacts after beating Dan Hooker.', 'Octagon Interview | UFC Paris', index, ctx, 'ev-paris');
  assert.deepEqual([...subj.fighters.keys()].sort(), ['f-hooker', 'f-parnasse']);
  /* ...and a title that names him is about him. */
  const own = linkFighters('Michael Bisping Interview\nSits down with Michael Bisping', 'Michael Bisping Interview', index, ctx, null);
  assert.ok(own.fighters.has('f-bisping'));
});

test('8. no publish date: no temporal guess, stored links preserved, reported as publish_date_unavailable', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  const d = proposedFor(run, NO_DATE.provider_video_id);
  for (const f of ['event_id', 'bout_id', 'fighter_ids', 'article_id', 'link_status', 'resolver_confidence', 'linking']) assert.ok(!d || !d.fields.includes(f), `${f} is preserved`);
  assert.equal(d?.proposed.event_id ?? NO_DATE.event_id, 'ev-vegas35', 'the stored event stands; the cards around the run date are never consulted');
  assert.ok(run.result.held.some((h) => h.id === NO_DATE.provider_video_id && h.publish_date_unavailable));
  assert.equal(run.result.totals.publish_date_unavailable, 1);
});

test('different videos in one run are resolved in different historical contexts', async () => {
  /* Same generic title, two eras: each finds its own Vegas card, in a single relink. */
  const a = video('vegasA000001', 'Octagon Interview | UFC Vegas', '2021-08-29T04:00:00Z');
  const b = video('vegasB000001', 'Octagon Interview | UFC Vegas', '2026-08-09T04:00:00Z');
  const run = await relink([a, b], { dry: true, explain: true });
  assert.equal(proposedFor(run, 'vegasA000001').proposed.event_id, 'ev-vegas35');
  assert.equal(proposedFor(run, 'vegasB000001').proposed.event_id, 'ev-gamrot');
  /* And the run date is irrelevant: the same relink ten years later proposes the same events. */
  const later = await relink([a, b], { dry: true, explain: true, now: '2036-01-01T00:00:00Z' });
  assert.deepEqual(later.result.explained.map((e) => [e.id, e.proposed.event_id]), run.result.explained.map((e) => [e.id, e.proposed.event_id]));
});

test('--dry-run and --explain write nothing; --explain is refused without --dry-run', async () => {
  const run = await relink(ALL, { dry: true, explain: true });
  assert.deepEqual(run.writes, []);
  const refused = await relink(ALL, { explain: true, dry: false });
  assert.match(String(refused.error?.message), /requires --dry-run/);
  assert.deepEqual(refused.writes, []);
});

test('a destructive full relink fails closed: nothing is written, not even the safe rows', async () => {
  /* One stored link the resolver can no longer support (a fighter it would drop) beside a harmless row. */
  const wouldLoseFighter = video('losef0000001', 'Volk preparing for Evloev', '2026-09-02T12:00:00Z', { fighter_ids: ['f-evloev'], resolver_confidence: 'low' }, { linking: { event: null, fighters: [{ fighter_id: 'f-evloev', method: 'surname_unique_window', alias: 'evloev', in_title: true }], bout: null, article_candidates: 0 } });
  const harmless = video('harmless0001', 'Octagon Interview | UFC Vegas', '2026-08-09T04:00:00Z');
  const run = await relink([wouldLoseFighter, harmless]);
  assert.match(String(run.error?.message), /full relink refused: 1 destructive change/);
  assert.deepEqual(run.error.blocked.map((b) => [b.id, b.reasons]), [['losef0000001', ['fighter_lost']]]);
  assert.deepEqual(run.writes, [], 'all or nothing');
  /* The reviewed path still works: naming the row applies it, and only it. */
  const targeted = await relink([wouldLoseFighter, harmless], { ids: new Set(['harmless0001']) });
  assert.equal(targeted.error, undefined);
  assert.deepEqual(targeted.writes.map((w) => w.body.map((r) => r.provider_video_id)), [['harmless0001']]);
  /* With nothing destructive in the plan, a full relink is allowed to write. */
  const clean = await relink([harmless]);
  assert.equal(clean.error, undefined);
  assert.equal(clean.writes.length, 1);
});

test('the guard names every destructive move and lets additive ones through', () => {
  const row = (o = {}, linking = {}) => ({ event_id: 'e1', bout_id: 'b1', fighter_ids: ['f1'], link_status: 'published', ...o, source_metadata: { linking } });
  assert.deepEqual(destructiveReasons(row(), row({ event_id: null, bout_id: null })), ['event_lost', 'bout_lost']);
  assert.deepEqual(destructiveReasons(row(), row({ event_id: null, bout_id: null }, { event_rejected: { reason: 'x' } })), [], 'a recorded guard refusal is evidence, not a lost window');
  assert.deepEqual(destructiveReasons(row(), row({ event_id: 'e2' }, { event: { method: 'nearest_date', distance_days: 1805 } })), ['event_changed', 'event_outside_window']);
  assert.deepEqual(destructiveReasons(row(), row({ bout_id: 'b2' })), ['bout_changed']);
  assert.deepEqual(destructiveReasons(row(), row({ fighter_ids: ['f2'] })), ['fighter_replaced']);
  assert.deepEqual(destructiveReasons(row(), row({ fighter_ids: [] })), ['fighter_lost']);
  assert.deepEqual(destructiveReasons(row(), row({ link_status: 'review' })), ['status_flip']);
  assert.deepEqual(destructiveReasons(row({ link_status: 'review' }), row()), ['status_flip']);
  assert.deepEqual(destructiveReasons(row({ event_id: null, bout_id: null }), row()), [], 'gaining a link is not destructive');
  assert.deepEqual(destructiveReasons(row(), row({ fighter_ids: ['f1', 'f2'] })), []);
});

test('article links and status flips are held on relink unless asked for by name', async () => {
  const withArticle = { ...video('article00001', 'Octagon Interview | UFC Vegas', '2026-08-09T04:00:00Z', { event_id: 'ev-gamrot', article_id: 'art-old', resolver_confidence: 'medium' }) };
  const run = await relink([withArticle], { dry: true, explain: true });
  const d = proposedFor(run, 'article00001');
  assert.ok(!d || !d.fields.includes('article_id'), 'the article link is not a planned change');
  assert.equal(d?.proposed.article_id ?? 'art-old', 'art-old');
  assert.deepEqual(run.result.held.map((h) => [h.id, h.article_id]), [['article00001', { stored: 'art-old', proposed: null }]]);
  const opted = await relink([withArticle], { dry: true, explain: true, allowArticleChange: true });
  assert.deepEqual(proposedFor(opted, 'article00001').fields.includes('article_id'), true);
});
