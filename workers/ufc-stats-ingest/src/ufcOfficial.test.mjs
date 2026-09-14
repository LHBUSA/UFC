/* Official UFC statistics feed adapter. Run: node --test src/ufcOfficial.test.mjs
 *
 * Fixture: the real official document for Noche UFC (2026-09-12) bout
 * Waldo Cortes Acosta vs Curtis Blaydes, as published after the card. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseOfficialFight, parseOfficialEvent, officialReadiness, sameOfficialEvent, mapOfficialFighters,
  validateOfficialFight, officialRoundRows, fightIdsFromUfcComPage, mmssToSeconds, ROUND_COLUMNS, contenderSeasonWeek,
} from './ufcOfficial.mjs';

const fx = (f) => JSON.parse(readFileSync(new URL(`../test-fixtures/official/${f}`, import.meta.url), 'utf8'));
const FIGHT = fx('fight_12975.json');
const EVENT = fx('event_1331_trimmed.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const WALDO = { id: 'fw', name: 'Waldo Cortes Acosta' };
const BLAYDES = { id: 'fb', name: 'Curtis Blaydes' };
const RESULT = { winner_id: 'fb', round: 3, time_sec: 300 };

test('parses per-round rows straight from the feed, both corners, every column', () => {
  const p = parseOfficialFight(FIGHT);
  assert.equal(p.status, 'Final');
  assert.equal(p.official, true);
  assert.deepEqual(p.result, { method: 'Decision - Unanimous', round: 3, time_sec: 300 });
  assert.equal(p.rounds.length, 6, '3 rounds x 2 corners');
  assert.deepEqual(p.shape_problems, []);
  const raw = FIGHT.LiveFightDetail.RoundStats.find((b) => b.FighterId === 2764).Rounds.find((r) => r.RoundNumber === 2);
  const row = p.rounds.find((r) => r.official_fighter_id === '2764' && r.round === 2);
  for (const [col, key, kind] of ROUND_COLUMNS) {
    assert.equal(row[col], kind === 'mmss' ? mmssToSeconds(raw[key]) : raw[key], `${col} is copied from ${key}, not derived`);
  }
  assert.deepEqual([row.sig_str_landed, row.sig_str_att, row.total_str_landed, row.td_landed, row.ctrl_sec], [9, 24, 16, 2, 87]);
});

test('the rows written are the feed rows: one per round per corner, nothing summed or spread', () => {
  const p = parseOfficialFight(FIGHT);
  const m = mapOfficialFighters(p, WALDO, BLAYDES);
  const rows = officialRoundRows(p, m, 'bout-1', 'https://feed/fight/12975.json', '2026-09-14T00:00:00Z');
  assert.equal(rows.length, 6);
  assert.deepEqual([...new Set(rows.map((r) => r.fighter_id))].sort(), ['fb', 'fw']);
  assert.deepEqual([...new Set(rows.map((r) => r.round))], [1, 2, 3]);
  assert.ok(rows.every((r) => r.source_url === 'https://feed/fight/12975.json' && r.bout_id === 'bout-1'));
  const totalSig = FIGHT.LiveFightDetail.FightStats.find((s) => s.FighterId === 2764).SigStrikesLanded;
  assert.equal(rows.filter((r) => r.fighter_id === 'fb').reduce((a, r) => a + r.sig_str_landed, 0), totalSig, 'rounds reconcile to the published total');
});

test('valid when identity and result agree', () => {
  const p = parseOfficialFight(FIGHT);
  assert.deepEqual(validateOfficialFight({ parsed: p, mapping: mapOfficialFighters(p, WALDO, BLAYDES), result: RESULT }), []);
  assert.deepEqual(officialReadiness(p), { ready: true });
});

test('identity is exact: canonical name, stored alias, or family-name-first; never a near miss', () => {
  const p = parseOfficialFight(FIGHT);
  assert.ok(mapOfficialFighters(p, BLAYDES, WALDO).map, 'corner order does not matter');
  const near = mapOfficialFighters(p, { id: 'fw', name: 'Waldo Cortes-Acosta Jr' }, BLAYDES);
  assert.ok(!near.map && /matches 0/.test(near.problem));
  const viaAlias = mapOfficialFighters(p, { id: 'fw', name: 'W. Acosta' }, BLAYDES, new Map([['fw', ['Waldo Cortes Acosta']]]));
  assert.ok(viaAlias.map);
  assert.equal(viaAlias.via.find((v) => v.fighter_id === 'fw').via, 'alias');
  const reversed = clone(FIGHT);
  reversed.LiveFightDetail.Fighters[1].Name = { FirstName: 'Blaydes', LastName: 'Curtis' };
  const rp = parseOfficialFight(reversed);
  assert.equal(mapOfficialFighters(rp, WALDO, BLAYDES).via.find((v) => v.fighter_id === 'fb').via, 'family_name_first');
  const wrongBout = mapOfficialFighters(p, WALDO, { id: 'x', name: 'Jean Silva' });
  assert.ok(!wrongBout.map, 'a fight with only one of our corners is not our fight');
});

test('any result disagreement blocks the write', () => {
  const p = parseOfficialFight(FIGHT);
  const m = mapOfficialFighters(p, WALDO, BLAYDES);
  assert.match(validateOfficialFight({ parsed: p, mapping: m, result: { ...RESULT, winner_id: 'fw' } }).join(), /winner disagreement/);
  assert.match(validateOfficialFight({ parsed: p, mapping: m, result: { ...RESULT, round: 2 } }).join(), /finish round disagreement/);
  assert.match(validateOfficialFight({ parsed: p, mapping: m, result: { ...RESULT, time_sec: 299 } }).join(), /finish time disagreement/);
  assert.match(validateOfficialFight({ parsed: p, mapping: m, result: null }).join(), /no stored result/);
});

test('incomplete or unofficial round detail is never written', () => {
  const live = clone(FIGHT); live.LiveFightDetail.Status = 'Live';
  assert.equal(officialReadiness(parseOfficialFight(live)).ready, false);
  const unofficial = clone(FIGHT); unofficial.LiveFightDetail.OfficialStats = false;
  assert.equal(officialReadiness(parseOfficialFight(unofficial)).ready, false);
  const empty = clone(FIGHT); empty.LiveFightDetail.RoundStats = [];
  assert.equal(officialReadiness(parseOfficialFight(empty)).ready, false);

  const m = (doc) => { const p = parseOfficialFight(doc); return validateOfficialFight({ parsed: p, mapping: mapOfficialFighters(p, WALDO, BLAYDES), result: RESULT }); };
  const oneCorner = clone(FIGHT); oneCorner.LiveFightDetail.RoundStats[0].Rounds.pop();
  assert.match(m(oneCorner).join(), /round 3 has 1 corner/);
  const gap = clone(FIGHT); for (const b of gap.LiveFightDetail.RoundStats) b.Rounds = b.Rounds.filter((r) => r.RoundNumber !== 2);
  assert.match(m(gap).join(), /not contiguous/);
  const short = clone(FIGHT); for (const b of short.LiveFightDetail.RoundStats) b.Rounds = b.Rounds.filter((r) => r.RoundNumber !== 3);
  assert.match(m(short).join(), /stop at 2 before the finish round 3/);
  const junk = clone(FIGHT); junk.LiveFightDetail.RoundStats[0].Rounds[0].SigStrikesLanded = -1;
  assert.match(m(junk).join(), /not a valid count/);
});

test('event identity: same card by name and date, never another card', () => {
  const ev = parseOfficialEvent(EVENT);
  assert.equal(ev.fightIds.length, 13);
  assert.ok(sameOfficialEvent(ev, { name: 'Noche UFC: Silva vs. Delgado', event_date: '2026-09-12' }));
  assert.ok(!sameOfficialEvent(ev, { name: 'UFC 331: Van vs. Pantoja 2', event_date: '2026-09-19' }));
  assert.ok(!sameOfficialEvent(ev, { name: 'Noche UFC: Silva vs. Delgado', event_date: '2026-09-15' }), 'same name, wrong date');
  assert.ok(!sameOfficialEvent({ name: 'UFC 330', date: '2026-09-12' }, { name: 'UFC 331', event_date: '2026-09-12' }), 'different numbered event');
  assert.deepEqual(fightIdsFromUfcComPage('<div data-fmid="12975"></div><div data-fmid="12975"></div><a data-fmid="13119">'), ['12975', '13119']);
});

test('Contender Series cards match by season AND week AND date, never by a near name', () => {
  assert.deepEqual(contenderSeasonWeek('DWCS 10.1'), { season: 10, week: 1 });
  assert.deepEqual(contenderSeasonWeek("Dana White's Contender Series: Season 10, Week 1"), { season: 10, week: 1 });
  assert.deepEqual(contenderSeasonWeek("Dana White's Contender Series 2026: Season 10, Week 5"), { season: 10, week: 5 });
  assert.equal(contenderSeasonWeek('UFC Fight Night: Hooker vs. Parnasse'), null);
  const w1 = { name: "Dana White's Contender Series: Season 10, Week 1", event_date: '2026-08-11' };
  assert.ok(sameOfficialEvent({ name: 'DWCS 10.1', date: '2026-08-11' }, w1));
  assert.ok(!sameOfficialEvent({ name: 'DWCS 10.2', date: '2026-08-11' }, w1), 'different week');
  assert.ok(!sameOfficialEvent({ name: 'DWCS 9.1', date: '2026-08-11' }, w1), 'different season');
  assert.ok(!sameOfficialEvent({ name: 'DWCS 10.1', date: '2026-08-18' }, w1), 'right number, wrong date');
  assert.ok(!sameOfficialEvent({ name: 'UFC Fight Night: X vs. Y', date: '2026-08-11' }, w1), 'a UFC card on the same date is not the DWCS card');
  assert.ok(!sameOfficialEvent({ name: 'DWCS 10.1', date: '2026-08-11' }, { name: 'UFC Fight Night: X vs. Y', event_date: '2026-08-11' }));
});
