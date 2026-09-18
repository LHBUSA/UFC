/* node --test scripts/videos/playlist_public.test.mjs
 *
 * Keyless playlist discovery: the public playlist page, its continuation
 * batches and the watch page. Fixtures are the minimal shapes YouTube served
 * on 2026-09-14 (ids and titles are real, everything else trimmed). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPageJson, parsePlaylistPage, parsePlaylistContinuation, parseWatchPage } from './lib.mjs';
import { mergePlaylistEntries } from './ingest_youtube.mjs';

const UFC = 'UCvgfXK4nTYKudb0rFR6noLA';
const lockup = (id, title, channel = UFC, badge = '1:33') => ({
  lockupViewModel: {
    contentId: id,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: badge } }] } }] } },
    metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'UFC', commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: channel } } } }] } }] }] } } } },
  },
});
const page = (items, { continuation = null, alerts = null, count = null } = {}) => {
  const data = {
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
      ...items,
      ...(continuation ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: continuation } } } }] : []),
    ] } }] } } } }] } },
    header: { pageHeaderRenderer: { pageTitle: 'The Ultimate Fighter 22: Team McGregor vs Team Faber', content: { text: count ? `${count} videos` : '' } } },
    microformat: { microformatDataRenderer: { title: 'The Ultimate Fighter 22: Team McGregor vs Team Faber' } },
    ...(alerts ? { alerts: [{ alertWithButtonRenderer: { text: { simpleText: alerts } } }] } : {}),
    /* a recommendation shelf outside the playlist tab must not be read as an item */
    sidebar: { playlistSidebarRenderer: { items: [lockup('zzzzzzzzzzz', 'Not in the playlist')] } },
  };
  if (count) data.header.pageHeaderRenderer.content = { stats: [`"${count} videos"`] };
  return `<script>var ytcfg={"INNERTUBE_API_KEY":"pagekey","INNERTUBE_CLIENT_VERSION":"2.20260911.08.00"};</script><script nonce="x">var ytInitialData = ${JSON.stringify(data)};</script>`;
};

test('extractPageJson survives "};" inside strings', () => {
  const html = '<script>var ytInitialData = {"title":"a};b","n":{"x":"\\"}"}};var other = 1;</script>';
  assert.deepEqual(extractPageJson(html, 'ytInitialData'), { title: 'a};b', n: { x: '"}' } });
  assert.equal(extractPageJson('<html></html>', 'ytInitialData'), null);
});

test('playlist page: items from the playlist tab only, with channel ids, hidden count and the page key', () => {
  const p = parsePlaylistPage(page([lockup('lgHKPqXSu40', 'The Ultimate Fighter 22 Finale: Ryan Hall Octagon Interview'), lockup('abcdefghijk', 'Someone else', 'UCsomeoneelse000000000')], { alerts: '22 unavailable videos are hidden' }));
  assert.equal(p.title, 'The Ultimate Fighter 22: Team McGregor vs Team Faber');
  assert.deepEqual(p.items.map((i) => i.video_id), ['lgHKPqXSu40', 'abcdefghijk']);
  assert.equal(p.items[0].channel_id, UFC);
  assert.equal(p.items[1].channel_id, 'UCsomeoneelse000000000');
  assert.equal(p.hidden_unavailable, 22);
  assert.equal(p.continuation, null);
  assert.deepEqual(p.innertube, { key: 'pagekey', client_version: '2.20260911.08.00' });
});

test('playlist page: a continuation token is surfaced, and the continuation batch parses the same way', () => {
  const p = parsePlaylistPage(page([lockup('aaaaaaaaaaa', 'one')], { continuation: 'TOKEN1' }));
  assert.equal(p.continuation, 'TOKEN1');
  const next = parsePlaylistContinuation({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [lockup('bbbbbbbbbbb', 'two'), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN2' } } } }] } }] });
  assert.deepEqual(next.items.map((i) => i.video_id), ['bbbbbbbbbbb']);
  assert.equal(next.continuation, 'TOKEN2');
  assert.equal(parsePlaylistContinuation({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [lockup('ccccccccccc', 'last')] } }] }).continuation, null);
});

test('playlist page: the legacy playlistVideoRenderer shape is read too', () => {
  const html = `<script>var ytInitialData = ${JSON.stringify({ contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { playlistVideoListRenderer: { contents: [{ playlistVideoRenderer: { videoId: 'MnpC_bfZybc', title: { runs: [{ text: 'The Ultimate Fighter 19: Season Preview' }] }, shortBylineText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: UFC } } }] }, lengthText: { simpleText: '1:05' } } }] } } } }] } } })};</script>`;
  const p = parsePlaylistPage(html);
  assert.deepEqual(p.items, [{ video_id: 'MnpC_bfZybc', title: 'The Ultimate Fighter 19: Season Preview', channel_id: UFC, length_text: '1:05' }]);
});

const watch = (over = {}) => {
  const pr = {
    playabilityStatus: { status: 'OK', playableInEmbed: true },
    videoDetails: { videoId: 'XpMB690IcNg', title: 'UFC Special Announcement Press Conference', lengthSeconds: '8322', channelId: UFC, shortDescription: 'Dana White announces the coaches.', isLiveContent: true, author: 'UFC', isPrivate: false, thumbnail: { thumbnails: [{ url: 'small' }, { url: 'https://i.ytimg.com/vi/XpMB690IcNg/maxresdefault.jpg' }] } },
    microformat: { playerMicroformatRenderer: { publishDate: '2014-04-29T18:14:19-07:00', uploadDate: '2014-04-29T18:14:19-07:00', externalChannelId: UFC, isUnlisted: false, availableCountries: ['CA', 'US'], liveBroadcastDetails: { isLiveNow: false, startTimestamp: '2014-04-29T20:02:07+00:00', endTimestamp: '2014-04-29T23:40:14+00:00' } } },
    ...over,
  };
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify(pr)};var meta = document.createElement('meta');</script>`;
};

test('watch page: exact publish time, uploading channel, duration, live state and embed answer', () => {
  const w = parseWatchPage(watch());
  assert.equal(w.video_id, 'XpMB690IcNg');
  assert.equal(w.channel_id, UFC);
  assert.equal(w.published, '2014-04-29T18:14:19-07:00');
  assert.equal(w.duration_sec, 8322);
  assert.equal(w.live_broadcast_state, 'completed');
  assert.equal(w.privacy_status, 'public');
  assert.equal(w.playable_in_embed, true);
  assert.equal(w.available_in_us, true);
  assert.equal(w.thumbnail_url, 'https://i.ytimg.com/vi/XpMB690IcNg/maxresdefault.jpg');
});

test('watch page: embedding refused and US missing are reported, never assumed away', () => {
  const w = parseWatchPage(watch({ playabilityStatus: { status: 'OK', playableInEmbed: false }, microformat: { playerMicroformatRenderer: { publishDate: '2020-01-01', availableCountries: ['BR'] } } }));
  assert.equal(w.playable_in_embed, false);
  assert.equal(w.available_in_us, false);
  assert.equal(parseWatchPage('<html>no player</html>'), null);
});

test('one row per video across playlists; a playlist season is kept only when the playlists agree', () => {
  const e = (id, pl, title) => ({ video_id: id, channel_id: UFC, title: 'clip', playlist_id: pl, playlist_title: title });
  const merged = mergePlaylistEntries([
    e('v1', 'P22', 'The Ultimate Fighter 22: Team McGregor vs Team Faber'),
    e('v1', 'PNEW', 'The Ultimate Fighter - New Episodes Every Week'),
    e('v2', 'P22', 'The Ultimate Fighter 22: Team McGregor vs Team Faber'),
    e('v2', 'P21', 'The Ultimate Fighter 21: ATT vs Blackzilians'),
    e('v3', 'P19', 'The Ultimate Fighter 19: Team Edgar vs Team Penn'),
    e('v3', 'P19', 'The Ultimate Fighter 19: Team Edgar vs Team Penn'),
  ]);
  assert.equal(merged.length, 3, 'deduped by provider_video_id');
  const v1 = merged.find((m) => m.video_id === 'v1');
  assert.equal(v1.playlist_title, 'The Ultimate Fighter 22: Team McGregor vs Team Faber', 'the one season-naming playlist wins over a generic one');
  assert.equal(v1.playlists.length, 2);
  const v2 = merged.find((m) => m.video_id === 'v2');
  assert.equal(v2.playlist_title, null, 'two playlists naming different seasons give no playlist season');
  assert.deepEqual(v2.playlist_season_conflict.sort(), ['tuf-21', 'tuf-22']);
  const v3 = merged.find((m) => m.video_id === 'v3');
  assert.equal(v3.playlists, undefined, 'a repeated membership is one membership');
});

test('archive linking: a video is decided among the cards around its own publish date', async () => {
  const { contextAt, linkVideo } = await import('./lib.mjs');
  const archive = {
    events: [
      { id: 'vegas35', name: 'UFC Fight Night: Barboza vs. Chikadze', event_date: '2021-08-28', city: 'Las Vegas' },
      { id: 'vegas2026', name: 'UFC Fight Night: Gamrot vs. Salkilld', event_date: '2026-09-20', city: 'Las Vegas' },
    ],
    bouts: [
      { id: 'b35', event_id: 'vegas35', fighter_a_id: 'f_barboza', fighter_b_id: 'f_chikadze', status: 'complete', bout_order: 12 },
      { id: 'b26', event_id: 'vegas2026', fighter_a_id: 'f_gamrot', fighter_b_id: 'f_cchandler', status: 'scheduled', bout_order: 3 },
    ],
    articles: [],
  };
  const fighters = [
    { id: 'f_barboza', name: 'Edson Barboza' }, { id: 'f_chikadze', name: 'Giga Chikadze' },
    { id: 'f_gamrot', name: 'Mateusz Gamrot' }, { id: 'f_cchandler', name: 'Chelsea Chandler' }, { id: 'f_mchandler', name: 'Michael Chandler' },
    { id: 'f_taira', name: 'Tatsuro Taira', nickname: 'The Best' },
  ];
  const index = { fighters, byId: new Map(fighters.map((f) => [f.id, f])), aliasesByFighter: new Map([['f_taira', ['The Best']]]) };

  const chikadze = { title: 'Giga Chikadze Octagon Interview | UFC Vegas 35', description: 'An impressive TKO win over Edson Barboza.', published: '2021-08-28T22:40:42-07:00' };
  const l = linkVideo(chikadze, index, contextAt(archive, new Date(chikadze.published)));
  assert.equal(l.event_id, 'vegas35', 'the 2021 Vegas card, not this month\'s');
  assert.equal(l.bout_id, null, 'Barboza is only in the description, so no bout from the title');
  assert.deepEqual(l.fighter_ids.sort(), ['f_barboza', 'f_chikadze']);

  const chandler = { title: "At Home With UFC's Michael Chandler", description: '', published: '2023-05-31T13:00:21-07:00' };
  const c = linkVideo(chandler, index, contextAt(archive, new Date(chandler.published)));
  assert.deepEqual(c.fighter_ids, ['f_mchandler'], 'no surname hit on a 2026 card fighter');

  const best = { title: 'Coach Conor brought in one of the best for his team!', description: '', published: '2023-06-20T19:32:14-07:00' };
  assert.deepEqual(linkVideo(best, index, contextAt(archive, new Date(best.published))).fighter_ids, [], 'a nickname phrase is not a name');
  assert.equal(contextAt(archive, null).events.length, 0, 'no publish date, no card context');
});

test('a TUF video keeps a series-key event only with a title bout or a stated finale of the same season', async () => {
  const { tufSeriesEventSupported } = await import('./lib.mjs');
  const series = (extra = {}) => ({ event_id: 'e', bout_id: null, linking: { event: { key: 'the ultimate fighter', kind: 'series', method: 'nearest_date' } }, ...extra });
  assert.equal(tufSeriesEventSupported(series(), { title: 'The Ultimate Fighter Brazil 3: The Final Days' }).supported, false);
  assert.equal(tufSeriesEventSupported(series(), { title: 'The Ultimate Fighter 18: Wootten vs Hill Pre-fight Interviews', videoSeason: 'tuf-18', eventSeason: 'tuf-18' }).supported, false, 'a house fight is not on the finale card');
  assert.equal(tufSeriesEventSupported(series(), { title: 'The Ultimate Fighter 18 Finale: Nate Diaz Pre-fight Interview', videoSeason: 'tuf-18', eventSeason: 'tuf-18' }).supported, true);
  assert.equal(tufSeriesEventSupported(series(), { title: 'The Ultimate Fighter Nations Finale: Meet the Fighters', videoSeason: 'tuf-nations-1', eventSeason: 'tuf-18' }).supported, false);
  assert.equal(tufSeriesEventSupported(series({ bout_id: 'b' }), { title: 'Montano vs Modafferi' }).supported, true);
  assert.equal(tufSeriesEventSupported({ event_id: 'e', linking: { event: { kind: 'number' } } }, { title: 'UFC 194 and The Ultimate Fighter 22: Press Conference' }).supported, true);
});

test('surname hits: never a card-mate of a full-name hit, and archive needs a linked event', async () => {
  const { linkFighters } = await import('./lib.mjs');
  const fighters = [{ id: 'mc', name: 'Michael Chandler' }, { id: 'cc', name: 'Chelsea Chandler' }, { id: 'ht', name: 'Brady Hiestand' }];
  const index = { fighters, byId: new Map(fighters.map((f) => [f.id, f])), aliasesByFighter: new Map() };
  const live = { events: [], bouts: [{ id: 'b', event_id: 'e', fighter_a_id: 'cc', fighter_b_id: 'ht' }], cardFighterIds: new Set(['cc', 'ht']) };
  assert.deepEqual([...linkFighters("At Home With UFC's Michael Chandler", "At Home With UFC's Michael Chandler", index, live, null).fighters.keys()], ['mc']);
  assert.deepEqual([...linkFighters('McGregor vs Chandler coaches challenge', 'McGregor vs Chandler coaches challenge', index, live, null).fighters.keys()], [], 'live feed too: the only Chandler on this month\'s cards is not the Chandler in the title');
  assert.deepEqual([...linkFighters('McGregor vs Chandler coaches challenge', 'McGregor vs Chandler coaches challenge', index, { ...live, surnameRequiresEvent: true }, null).fighters.keys()], []);
  assert.deepEqual([...linkFighters('Turcios vs Hiestand | Fight Preview', 'Turcios vs Hiestand | Fight Preview', index, { ...live, surnameRequiresEvent: true }, 'e').fighters.keys()], ['ht'], 'scoped to a linked card it still attaches');
});
