/* The lean, cached fighter index must link exactly what the old full reload
 * linked, and must pick up a roster change once the roster version moves.
 *
 * Parity is checked against the real loadFighterIndex() from
 * scripts/news/lib.mjs (the old per-run full reload), fed every column it
 * selects, while the lean index is fed ONLY the columns its own query names -
 * the fake PostgREST projects each row to the select list, so a consumer that
 * silently needed a dropped column would show up as a mismatch here.
 *
 * Optional: UFC_INDEX_FIXTURE=<path to {f, a, items} JSON> repeats the parity
 * check on a production-sized roster and a real article set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadFighterIndex } from '../../../scripts/news/lib.mjs';
import { linkEntities } from '../../../scripts/news/ingest_news.mjs';
import { getFighterIndex, loadLeanFighterIndex, resetFighterIndexCache, RECONCILE_MS } from './fighter_index.mjs';

const NOW = Date.parse('2026-10-07T12:00:00Z');

const FIGHTERS = [
  { id: 'f01', ufcstats_id: 'u1', espn_athlete_id: 'e1', name: 'Islam Makhachev', nickname: null, dob: '1991-10-27', record_w: 27, record_l: 1, record_d: 0, record_nc: 0, height_in: 70, reach_in: 70, stance: 'Southpaw', weight_lbs: 155, career_slpm: 2.5, source_url: 'x' },
  { id: 'f02', ufcstats_id: 'u2', name: 'Arman Tsarukyan', nickname: 'Ahalkalakets', dob: '1996-10-11', record_w: 22, record_l: 3, record_d: 0, record_nc: 0 },
  { id: 'f03', ufcstats_id: 'u3', name: 'Alex Pereira', nickname: 'Poatan', dob: '1987-07-07', record_w: 12, record_l: 3, record_d: 0, record_nc: 0 },
  /* Two fighters with the same name: an ambiguous exact match must stay unlinked in both. */
  { id: 'f04', ufcstats_id: 'u4', name: 'Bruno Silva', nickname: 'Blindado', dob: '1989-07-13', record_w: 23, record_l: 10, record_d: 0, record_nc: 1 },
  { id: 'f05', ufcstats_id: 'u5', name: 'Bruno Silva', nickname: 'Bulldog', dob: '1990-03-16', record_w: 13, record_l: 6, record_d: 0, record_nc: 0 },
  { id: 'f06', ufcstats_id: 'u6', name: 'Merab Dvalishvili', nickname: 'The Machine', dob: '1991-01-10', record_w: 20, record_l: 4, record_d: 0, record_nc: 0 },
  { id: 'f07', ufcstats_id: 'u7', name: 'Dan Hooker', nickname: 'The Hangman', dob: '1990-02-13', record_w: 24, record_l: 12, record_d: 0, record_nc: 0 },
  { id: 'f08', ufcstats_id: 'u8', name: 'Mateusz Gamrot', nickname: 'Gamer', dob: '1990-12-11', record_w: 25, record_l: 3, record_d: 0, record_nc: 1 },
  { id: 'f09', ufcstats_id: null, name: 'Jose Aldo', nickname: 'Junior', dob: null, record_w: null },
  { id: 'f10', ufcstats_id: 'u10', name: 'Khamzat Chimaev', nickname: 'Borz', dob: '1994-05-01', record_w: 14, record_l: 0, record_d: 0, record_nc: 0 },
];
const ALIASES = [
  { fighter_id: 'f09', alias: 'José Aldo', source: 'espn', normalized: 'jose aldo' },
  { fighter_id: 'f03', alias: 'Alex Poatan Pereira', source: 'news', normalized: 'alex poatan pereira' },
  { fighter_id: 'f10', alias: 'Khamzat Chimaev Borz', source: 'news', normalized: 'khamzat chimaev borz' },
  { fighter_id: 'f02', alias: 'Arman Tsarukian', source: 'sherdog', normalized: 'arman tsarukian' },
];
const CTX = {
  events: [{ id: 'ev1', name: 'UFC 322', event_date: '2026-10-25', keys: ['ufc 322'] }],
  bouts: [
    { id: 'b1', event_id: 'ev1', fighter_a_id: 'f01', fighter_b_id: 'f02', bout_order: 1 },
    { id: 'b2', event_id: 'ev1', fighter_a_id: 'f07', fighter_b_id: 'f08', bout_order: 2 },
  ],
};
const ARTICLES = [
  { title: 'Islam Makhachev vs Arman Tsarukyan rebooked for UFC 322', summary: 'The lightweight title fight is back.' },
  { title: 'Hooker vs. Gamrot set as co-main', summary: '' },
  { title: 'Bruno Silva books next fight', summary: 'Which one? Nobody knows.' },
  { title: 'José Aldo returns at 135', summary: 'Jose Aldo is back.' },
  { title: 'Alex Poatan Pereira and Khamzat Chimaev Borz trade barbs', summary: null },
  { title: 'Arman Tsarukian says he is ready', summary: 'Merab Dvalishvili watches.' },
  { title: 'Ryan Garcia vs Conor Benn preview', summary: 'Boxing.' },
  { title: 'Top 10 knockouts of 2025', summary: '' },
];

/** Fake PostgREST that projects every row to the select list it was asked for. */
function projectingSb(fighters, aliases, { version = () => ({ f: 'v1', a: 'v1' }) } = {}) {
  const calls = { ufc_fighters: 0, ufc_fighter_aliases: 0, probe: 0 };
  const project = (rows, query) => {
    const cols = (/(?:^|&)select=([^&]*)/.exec(query) || [])[1];
    if (!cols || cols === '*') return rows.map((r) => ({ ...r }));
    const list = cols.split(',');
    return rows.map((r) => Object.fromEntries(list.map((c) => [c, r[c] ?? null])));
  };
  return {
    calls,
    async select(table, query) {
      calls[table] = (calls[table] || 0) + 1;
      if (table === 'ufc_fighters') return project(fighters(), query);
      if (table === 'ufc_fighter_aliases') return project(aliases(), query);
      return [];
    },
    async countAndMax(table) {
      calls.probe += 1;
      const v = version();
      if (v === null) return null;
      return table === 'ufc_fighters'
        ? { count: fighters().length, max: v.f }
        : { count: aliases().length, max: v.a };
    },
  };
}

const norm = (r) => ({ fighter_ids: [...r.fighter_ids].sort(), event_id: r.event_id, bout_id: r.bout_id });

async function assertParity(fighters, aliases, articles, ctx) {
  const full = await loadFighterIndex(projectingSb(() => fighters, () => aliases));
  const lean = await loadLeanFighterIndex(projectingSb(() => fighters, () => aliases));
  let linked = 0;
  for (const a of articles) {
    const old = norm(linkEntities(a, ctx, full, NOW));
    const neu = norm(linkEntities(a, ctx, lean, NOW));
    assert.deepEqual(neu, old, `linking differs for "${a.title}"`);
    if (old.fighter_ids.length) linked += 1;
  }
  return linked;
}

test('lean index links exactly what the full reload linked', async () => {
  const linked = await assertParity(FIGHTERS, ALIASES, ARTICLES, CTX);
  assert.ok(linked >= 5, 'the fixture must actually exercise linking');
  /* And the fixture pins the cases that matter, not just agreement. */
  const lean = await loadLeanFighterIndex(projectingSb(() => FIGHTERS, () => ALIASES));
  const r = (i) => norm(linkEntities(ARTICLES[i], CTX, lean, NOW));
  assert.deepEqual(r(0), { fighter_ids: ['f01', 'f02'], event_id: 'ev1', bout_id: 'b1' });
  assert.equal(r(1).bout_id, 'b2', 'surname-only bout match');
  assert.deepEqual(r(2).fighter_ids, [], 'ambiguous namesakes stay unlinked');
  assert.deepEqual(r(3).fighter_ids, ['f09'], 'alias link');
  assert.deepEqual(r(6).fighter_ids, []);
});

test('lean index parity on a production-sized fixture (UFC_INDEX_FIXTURE)', { skip: !process.env.UFC_INDEX_FIXTURE }, async () => {
  const fx = JSON.parse(fs.readFileSync(process.env.UFC_INDEX_FIXTURE, 'utf8'));
  const linked = await assertParity(fx.f, fx.a, fx.items, { events: [], bouts: [] });
  console.log(`# parity: ${fx.items.length} articles, ${fx.f.length} fighters, ${fx.a.length} aliases, ${linked} with fighter links`);
});

test('cached index is reused while the roster version is unchanged', async () => {
  resetFighterIndexCache();
  const sb = projectingSb(() => FIGHTERS, () => ALIASES);
  const s1 = {}; const s2 = {};
  const a = await getFighterIndex(sb, { now: NOW, stats: s1 });
  const b = await getFighterIndex(sb, { now: NOW + 120_000, stats: s2 });
  assert.equal(a, b);
  assert.equal(s1.index_source, 'loaded');
  assert.equal(s2.index_source, 'cached');
  assert.equal(sb.calls.ufc_fighters, 1);
  assert.equal(sb.calls.ufc_fighter_aliases, 1);
});

test('a new fighter and a new alias are picked up once the version changes', async () => {
  resetFighterIndexCache();
  const fighters = [...FIGHTERS];
  const aliases = [...ALIASES];
  let v = { f: '2026-10-07T06:00:00Z', a: '2026-10-01T00:00:00Z' };
  const sb = projectingSb(() => fighters, () => aliases, { version: () => v });
  const article = { title: 'Newcomer Zed Quillfeather debuts on short notice', summary: '' };

  let idx = await getFighterIndex(sb, { now: NOW });
  assert.deepEqual(linkEntities(article, CTX, idx, NOW).fighter_ids, []);

  /* An insert moves the row count, so it changes the version on its own. */
  fighters.push({ id: 'f11', name: 'Zed Quillfeather' });
  aliases.push({ fighter_id: 'f12', alias: 'KH Harrison' });
  fighters.push({ id: 'f12', name: 'Kayla Harrison' });
  const stats = {};
  idx = await getFighterIndex(sb, { now: NOW + 120_000, stats });
  assert.equal(stats.index_source, 'loaded');
  assert.deepEqual(linkEntities(article, CTX, idx, NOW).fighter_ids.sort(), ['f11']);
  assert.deepEqual(linkEntities({ title: 'KH Harrison and Zed Quillfeather', summary: '' }, CTX, idx, NOW).fighter_ids.sort(), ['f11', 'f12']);

  /* An in-place rename does not move the count. Without an updated_at bump
   * the cache is still served (bounded by RECONCILE_MS); with one, it reloads. */
  fighters[fighters.length - 2] = { id: 'f11', name: 'Zed Quillfeather Junior' };
  const renamed = { title: 'Zed Quillfeather Junior debuts', summary: '' };
  const s2 = {};
  await getFighterIndex(sb, { now: NOW + 180_000, stats: s2 });
  assert.equal(s2.index_source, 'cached');
  v = { f: '2026-10-07T12:01:00Z', a: v.a };
  const s3 = {};
  idx = await getFighterIndex(sb, { now: NOW + 240_000, stats: s3 });
  assert.equal(s3.index_source, 'loaded');
  assert.equal(idx.byId.get('f11').name, 'Zed Quillfeather Junior');
  assert.deepEqual(linkEntities(renamed, CTX, idx, NOW).fighter_ids, ['f11']);

  /* Parity holds on the changed roster too. */
  await assertParity(fighters, aliases, [article, ...ARTICLES], CTX);
});

test('the reconcile interval forces a reload even when the version is unchanged', async () => {
  resetFighterIndexCache();
  const sb = projectingSb(() => FIGHTERS, () => ALIASES);
  await getFighterIndex(sb, { now: NOW });
  const stats = {};
  await getFighterIndex(sb, { now: NOW + RECONCILE_MS, stats });
  assert.equal(stats.index_source, 'loaded');
  assert.equal(sb.calls.ufc_fighters, 2);
});

test('a failed version probe reloads instead of trusting the cache', async () => {
  resetFighterIndexCache();
  let fail = false;
  const sb = projectingSb(() => FIGHTERS, () => ALIASES, { version: () => (fail ? null : { f: 'v', a: 'v' }) });
  await getFighterIndex(sb, { now: NOW });
  fail = true;
  const stats = {};
  await getFighterIndex(sb, { now: NOW + 1000, stats });
  assert.equal(stats.index_source, 'loaded');
});
