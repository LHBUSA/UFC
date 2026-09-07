/* node --test scripts/videos/lib.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVideo, expandHashtags, eventKeys, linkEvent, linkFighters, linkBout, linkVideo, isoDurationToSec, parseYoutubeFeed } from './lib.mjs';

const events = [
  { id: 'e331', name: 'UFC 331: Van vs. Pantoja 2', event_date: '2026-09-19', city: 'Los Angeles' },
  { id: 'e330', name: 'UFC 330: Makhachev vs. Machado Garry', event_date: '2026-08-15', city: 'Philadelphia' },
  { id: 'enoche', name: 'Noche UFC: Silva vs. Delgado', event_date: '2026-09-12', city: 'Glendale' },
  { id: 'eparis', name: 'UFC Fight Night: Hooker vs. Parnasse', event_date: '2026-09-05', city: 'Paris' },
  { id: 'edwcs5', name: "Dana White's Contender Series: Season 10, Week 5", event_date: '2026-09-08', city: 'Las Vegas' },
  { id: 'edwcs6', name: "Dana White's Contender Series: Season 10, Week 6", event_date: '2026-09-15', city: 'Las Vegas' },
  { id: 'evegas', name: 'UFC Fight Night: Rosas Jr. vs. Barcelos', event_date: '2026-09-26', city: 'Las Vegas' },
].map((e) => ({ ...e, alt_ids: [], ...eventKeys(e) }));

const fighters = [
  { id: 'f_van', name: 'Joshua Van' }, { id: 'f_pantoja', name: 'Alexandre Pantoja' },
  { id: 'f_hooker', name: 'Dan Hooker' }, { id: 'f_parnasse', name: 'Salahdine Parnasse' },
  { id: 'f_silva1', name: 'Bruno Silva' }, { id: 'f_silva2', name: 'Bruno Silva' },
  { id: 'f_taira', name: 'Tatsuro Taira' }, { id: 'f_white', name: 'Alan White' }, { id: 'f_prepolec', name: 'Kyle Prepolec' },
];
const index = { fighters, byId: new Map(fighters.map((f) => [f.id, f])), aliasesByFighter: new Map() };
const bouts = [
  { id: 'b_main331', event_id: 'e331', fighter_a_id: 'f_van', fighter_b_id: 'f_pantoja', bout_order: 12 },
  { id: 'b_paris', event_id: 'eparis', fighter_a_id: 'f_hooker', fighter_b_id: 'f_parnasse', bout_order: 12 },
  { id: 'b_silva', event_id: 'enoche', fighter_a_id: 'f_silva1', fighter_b_id: 'f_white', bout_order: 3 },
  { id: 'b_silva2', event_id: 'evegas', fighter_a_id: 'f_silva2', fighter_b_id: 'f_prepolec', bout_order: 3 },
];
const ctx = { events, bouts, cardFighterIds: new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id])), articlesByBout: new Map(), window: {} };
const at = (s) => new Date(s);

test('classification: title beats description, post-fight beats press conference, boilerplate ignored', () => {
  assert.equal(classifyVideo('UFC 331 Embedded: Vlog Series - Episode 1', '').video_type, 'embedded_episode');
  assert.equal(classifyVideo('UFC 331 Countdown: Van vs Pantoja 2', '').video_type, 'countdown');
  assert.equal(classifyVideo('UFC Paris: Post-Fight Press Conference', '').video_type, 'post_fight');
  assert.equal(classifyVideo('UFC 331: Pre-Fight Press Conference', '').video_type, 'press_conference');
  assert.equal(classifyVideo('UFC 331 Media Day Faceoffs', '').video_type, 'media_day');
  assert.equal(classifyVideo('UFC 331: Official Weigh-in', '').video_type, 'weigh_in');
  assert.equal(classifyVideo('UFC 331 Ceremonial Weigh-In Faceoffs', '').video_type, 'weigh_in');
  assert.equal(classifyVideo('Van vs Pantoja Staredown', '').video_type, 'faceoff');
  assert.equal(classifyVideo('Joshua Van vs Tatsuro Taira | FULL FIGHT | Crypto.com UFC 331', 'UFC Video Archive').video_type, 'full_fight');
  assert.equal(classifyVideo('Free Fight: Pantoja vs Royval', '').video_type, 'full_fight');
  assert.equal(classifyVideo('Every Knockout and Submission From UFC Paris| UFC Highlights', '').video_type, 'highlights');
  assert.equal(classifyVideo('UFC 331 Preview Show', '').video_type, 'fight_preview');
  assert.equal(classifyVideo('UFC Paris Recap', '').video_type, 'analysis');
  assert.equal(classifyVideo('Salahdine Parnasse Octagon Interview | UFC Paris', '').video_type, 'interview');
  assert.equal(classifyVideo('PARNASSE KNOCKS OUT DAN HOOKER #ufcparis', 'Watch UFC on Paramount Plus').video_type, 'other');
  assert.equal(classifyVideo('Encaradas da Pesagem | UFC Paris: Hooker x Parnasse', '').video_type, 'weigh_in');
  assert.equal(classifyVideo('Pos-Show | UFC Paris: Hooker x Parnasse', '').video_type, 'post_fight');
  assert.equal(classifyVideo('TODOS OS NOCAUTES E FINALIZACOES DO UFC PARIS', '').video_type, 'highlights');
  assert.equal(classifyVideo('Entrevista de Octogono com Felipe Lima | UFC Paris', '').video_type, 'interview');
  assert.equal(classifyVideo('#UFCParis Resumen Post Show', '').video_type, 'post_fight');
  assert.equal(classifyVideo('#NocheUFC Evento Completo: Grasso vs. Shevchenko', '').video_type, 'full_fight');
  assert.equal(classifyVideo('#NocheUFC Cartelera Completa', '').video_type, 'fight_preview');
  const d = classifyVideo('Episode 3', 'UFC 331 Embedded follows the fighters through fight week');
  assert.equal(d.video_type, 'embedded_episode');
  assert.equal(d.evidence[0].source, 'description');
});

test('hashtags expand into event words', () => {
  assert.match(expandHashtags('great night #ufcparis #UFC331 #NocheUFC'), /ufc paris .* ufc 331 .* noche ufc/);
});

test('event: number, series, city, headliners, nearest-date and review', () => {
  assert.equal(linkEvent('Joshua Van vs Tatsuro Taira | FULL FIGHT | Crypto.com UFC 331', 'Joshua Van vs Tatsuro Taira | FULL FIGHT | Crypto.com UFC 331', ctx, at('2026-09-06')).event.id, 'e331');
  assert.equal(linkEvent('Greatest Mexican Fighters | Noche UFC', 'Greatest Mexican Fighters | Noche UFC', ctx, at('2026-09-06')).event.id, 'enoche');
  assert.equal(linkEvent('OH MY WHAT A KNOCKOUT #ufcparis', 'OH MY WHAT A KNOCKOUT #ufcparis', ctx, at('2026-09-06')).event.id, 'eparis');
  const hl = linkEvent('Hooker vs Parnasse fight night highlights', 'Hooker vs Parnasse fight night highlights', ctx, at('2026-09-06'));
  assert.equal(hl.event.id, 'eparis');
  const dwcs = linkEvent('Contender Series Week 5 recap #DWCS', 'Contender Series recap #DWCS', ctx, at('2026-09-09'));
  assert.equal(dwcs.event.id, 'edwcs5');
  assert.equal(dwcs.evidence.method, 'nearest_date');
  const tie = linkEvent('Contender Series is back #DWCS', 'Contender Series is back #DWCS', ctx, at('2026-09-11T12:00:00Z'));
  assert.equal(tie.event, null);
  assert.equal(tie.review.reason, 'multiple_events');
  const two = linkEvent('UFC 330 recap and UFC 331 preview', 'UFC 330 recap and UFC 331 preview', ctx, at('2026-09-06'));
  assert.equal(two.event, null);
  assert.equal(two.review.reason, 'multiple_events');
  assert.equal(linkEvent('UFC Vegas this weekend', 'UFC Vegas this weekend', ctx, at('2026-09-24')).event.id, 'evegas');
  assert.equal(linkEvent('a random clip', 'a random clip', ctx, at('2026-09-06')).event, null);
});

test('fighters: full name unique, ambiguous to review, surname only when unique in window, stoplist', () => {
  const a = linkFighters('Salahdine Parnasse Octagon Interview', 'Salahdine Parnasse Octagon Interview', index, ctx, null);
  assert.deepEqual([...a.fighters.keys()], ['f_parnasse']);
  assert.equal(a.fighters.get('f_parnasse').method, 'full_name_window_card');
  const b = linkFighters('Bruno Silva promises a finish', 'Bruno Silva promises a finish', index, ctx, null);
  assert.equal(b.fighters.size, 0);
  assert.equal(b.review[0].reason, 'ambiguous_fighter_name');
  const c = linkFighters('Bruno Silva promises a finish', 'Bruno Silva promises a finish', index, ctx, 'enoche');
  assert.deepEqual([...c.fighters.keys()], ['f_silva1']);
  assert.equal(c.fighters.get('f_silva1').method, 'full_name_event_card');
  const d = linkFighters('PARNASSE KNOCKS OUT HOOKER', 'PARNASSE KNOCKS OUT HOOKER', index, ctx, null);
  assert.deepEqual([...d.fighters.keys()].sort(), ['f_hooker', 'f_parnasse']);
  assert.equal(d.fighters.get('f_hooker').method, 'surname_unique_window');
  const e = linkFighters('Dana White reacts', 'Dana White reacts', index, ctx, null);
  assert.equal(e.fighters.size, 0);
  const f = linkFighters('Taira is back', 'Taira is back', index, ctx, null);
  assert.equal(f.fighters.size, 0, 'surname of a fighter outside the window is never attached');
  const g = linkFighters('Parnasse is back #NocheUFC', 'Parnasse is back #NocheUFC', index, ctx, 'enoche');
  assert.equal(g.fighters.size, 0, 'with an event linked, a surname absent from that card attaches nothing');
  assert.equal(g.review.length, 0);
  const h = linkFighters('Hooker is back', 'Hooker is back', index, ctx, 'eparis');
  assert.equal(h.fighters.get('f_hooker').method, 'surname_unique_event_card');
});

test('bout needs both fighters in the title; confidence tiers', () => {
  const full = linkVideo({ title: 'Joshua Van vs Tatsuro Taira | FULL FIGHT | UFC 331', description: 'Joshua Van faces Alexandre Pantoja in the main event at UFC 331.', published: '2026-09-06' }, index, ctx);
  assert.equal(full.event_id, 'e331');
  assert.equal(full.bout_id, null, 'Pantoja only named in the description');
  assert.ok(full.fighter_ids.includes('f_pantoja') && full.fighter_ids.includes('f_van'));
  assert.equal(full.resolver_confidence, 'medium');
  const co = linkVideo({ title: 'UFC 331 Countdown: Joshua Van vs Alexandre Pantoja', description: '', published: '2026-09-10' }, index, ctx);
  assert.equal(co.bout_id, 'b_main331');
  assert.equal(co.resolver_confidence, 'high');
  assert.equal(co.link_status, 'published');
  const viaBout = linkVideo({ title: 'Hooker vs Parnasse staredown', description: '', published: '2026-09-04' }, index, ctx);
  assert.equal(viaBout.event_id, 'eparis');
  assert.equal(viaBout.bout_id, 'b_paris');
  const low = linkVideo({ title: 'Parnasse made it look easy!', description: '', published: '2026-09-06' }, index, ctx);
  assert.equal(low.resolver_confidence, 'low');
  const none = linkVideo({ title: 'Get this cat in the gym', description: '', published: '2026-09-06' }, index, ctx);
  assert.equal(none.resolver_confidence, 'none');
  assert.equal(none.link_status, 'published');
  const rev = linkVideo({ title: 'Bruno Silva talks camp', description: '', published: '2026-09-06' }, index, ctx);
  assert.equal(rev.link_status, 'review');
  assert.equal(rev.fighter_ids.length, 0);
  assert.equal(linkBout(new Map([['f_van', { in_title: true }], ['f_pantoja', { in_title: false }]]), ctx, 'e331', at('2026-09-06')), null);
});

test('feed parsing and ISO durations', () => {
  const xml = `<feed xmlns:yt="x" xmlns:media="y"><title>UFC</title><yt:channelId>UCabc</yt:channelId><entry><yt:videoId>abc123</yt:videoId><yt:channelId>UCabc</yt:channelId><title>T &amp; U</title><link rel="alternate" href="https://www.youtube.com/shorts/abc123"/><published>2026-09-06T14:15:08+00:00</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/abc123/hqdefault.jpg" width="480" height="360"/><media:description>desc</media:description></media:group></entry></feed>`;
  const p = parseYoutubeFeed(xml);
  assert.equal(p.channel.title, 'UFC');
  assert.equal(p.entries[0].video_id, 'abc123');
  assert.equal(p.entries[0].title, 'T & U');
  assert.equal(p.entries[0].is_short, true);
  assert.equal(p.entries[0].thumbnail_url, 'https://i.ytimg.com/vi/abc123/hqdefault.jpg');
  assert.equal(isoDurationToSec('PT1H2M3S'), 3723);
  assert.equal(isoDurationToSec('PT45S'), 45);
  assert.equal(isoDurationToSec('garbage'), null);
});
