/* Run: node workers/ufc-stats-ingest/src/parsers.test.mjs (from repo root).
 * Same fixtures and expectations as scripts/backfill/test_parsers.py. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './parsers.mjs';
import { SchemaAssertionError } from './ufcstats.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'backfill', 'fixtures');
const load = (n) => readFileSync(join(FX, n), 'utf8');
let failures = 0;
const check = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ev = P.parseEventList(load('completed_list_20260216.html'), 'http://ufcstats.com/statistics/events/completed?page=all');
check(ev.length === 762, `completed count ${ev.length}`);
check(eq(ev[0], { ufcstats_id: '79ab17db3b40831a', name: 'UFC Fight Night: Strickland vs. Hernandez', event_date: '2026-02-21', location_raw: 'Houston, Texas, USA' }), `first ${JSON.stringify(ev[0])}`);
check(ev[761].name === 'UFC 2: No Way Out' && ev[761].event_date === '1994-03-11', 'last event');

const fl = P.parseFighterList(load('fighters_a_20260219.html'), 'http://ufcstats.com/statistics/fighters?char=a&page=all');
check(fl.length === 230, `fighter list ${fl.length}`);
const ab = fl.find((f) => f.last === 'Abbadi');
check(ab.ufcstats_id === '15df64c02b6b0fde' && ab.nickname === 'The Assassin' && ab.height_in === 71 && ab.weight_lbs === 155 && ab.reach_in === null && ab.stance === 'ORTHODOX' && ab.record_w === 4 && ab.record_l === 6, `Abbadi ${JSON.stringify(ab)}`);

const e = P.parseEventPage(load('event_c337c3c85b1871e0.html'), 'http://ufcstats.com/event-details/c337c3c85b1871e0');
check(e.name === 'UFC Fight Night: Bautista vs. Oliveira' && e.event_date === '2026-02-07' && e.location_raw === 'Las Vegas, Nevada, USA' && e.bouts.length === 13, `event ${e.name} ${e.bouts.length}`);
const b0 = e.bouts[0];
check(b0.ufcstats_id === 'fb4b1754d510b0d0' && b0.bout_order === 13 && b0.fighter_a_ufcstats_id === 'bc711b6dd95c1af6' && b0.result_flag_a === 'WIN' && b0.method_raw === 'SUB' && b0.method_detail === 'Rear Naked Choke' && b0.round === 2 && b0.time === '4:46', `main event ${JSON.stringify(b0)}`);

const f = P.parseFightPage(load('fight_fb4b1754d510b0d0.html'), 'http://ufcstats.com/fight-details/fb4b1754d510b0d0');
check(eq(f.fighters[0], { ufcstats_id: 'bc711b6dd95c1af6', name: 'Mario Bautista', flag: 'WIN', nickname: null }) && f.fighters[1].nickname === 'LokDog', `persons ${JSON.stringify(f.fighters)}`);
check(f.method === 'SUB' && f.round === 2 && f.time_sec === 286 && f.scheduled_rounds === 5 && f.referee === 'Herb Dean' && f.finish_detail === 'Rear Naked Choke' && f.scorecards === null && f.weight_class === 'BANTAMWEIGHT' && f.winner_ufcstats_id === 'bc711b6dd95c1af6', `result ${JSON.stringify([f.method, f.round, f.time_sec, f.finish_detail])}`);
check(f.has_stats && f.rounds.length === 4, `rounds ${f.rounds.length}`);
const a1 = f.rounds.find((r) => r.fighter_ufcstats_id === 'bc711b6dd95c1af6' && r.round === 1);
check(eq([a1.kd, a1.sig_str_landed, a1.sig_str_att, a1.total_str_landed, a1.total_str_att, a1.td_landed, a1.td_att, a1.sub_att, a1.rev, a1.ctrl_sec], [0, 3, 9, 22, 29, 1, 2, 0, 0, 138]), `Bautista R1 ${JSON.stringify(a1)}`);
check(eq([a1.head_landed, a1.head_att, a1.body_landed, a1.body_att, a1.leg_landed, a1.leg_att, a1.distance_landed, a1.distance_att, a1.clinch_landed, a1.clinch_att, a1.ground_landed, a1.ground_att], [1, 7, 2, 2, 0, 0, 1, 4, 0, 0, 2, 5]), `Bautista R1 sig ${JSON.stringify(a1)}`);
const b2 = f.rounds.find((r) => r.fighter_ufcstats_id === '18d01f7f8338ae72' && r.round === 2);
check(eq([b2.sig_str_landed, b2.sig_str_att, b2.td_landed, b2.td_att, b2.ctrl_sec, b2.ground_landed], [6, 13, 0, 1, 0, 0]), `Oliveira R2 ${JSON.stringify(b2)}`);

const o = P.parseFightPage(load('fight_00835554f95fa911_ufc2.html'), 'http://ufcstats.com/fight-details/00835554f95fa911');
check(o.method === 'KO_TKO' && o.time_format === 'No Time Limit' && o.scheduled_rounds === null && o.time_sec === 77 && o.referee === 'John McCarthy' && o.finish_detail === 'Punches to Head From Mount Submission to Strikes' && o.is_title === true && o.weight_class === null, `ufc2 ${JSON.stringify([o.method, o.scheduled_rounds, o.weight_class, o.is_title])}`);
check(o.has_stats && o.rounds.length === 2 && o.rounds[0].ctrl_sec === null && o.rounds[0].sig_str_landed === 4, 'ufc2 rounds');

const oe = P.parseEventPage(load('event_a6a9ab5a824e8f66_ufc2.html'), 'http://ufcstats.com/event-details/a6a9ab5a824e8f66');
check(oe.name === 'UFC 2: No Way Out' && oe.bouts.length === 15 && oe.bouts[0].weight_class_raw === 'Open Weight', 'ufc2 event');

const vo = P.parseFighterPage(load('fighter_18d01f7f8338ae72.html'), 'http://ufcstats.com/fighter-details/18d01f7f8338ae72');
check(vo.name === 'Vinicius Oliveira' && vo.nickname === 'LokDog' && vo.record_w === 23 && vo.record_l === 4 && vo.height_in === 69 && vo.reach_in === 70 && vo.stance === 'SWITCH' && vo.dob === '1995-11-30' && vo.career_slpm === 4.73 && vo.career_str_acc === 43 && vo.career_sub_avg === 0.2 && vo.fight_history_count === 6 && vo.history_fight_ids[0] === 'fb4b1754d510b0d0', `Oliveira ${JSON.stringify(vo)}`);
const ta = P.parseFighterPage(load('fighter_93fe7332d16c6ad9.html'), 'http://ufcstats.com/fighter-details/93fe7332d16c6ad9');
check(ta.name === 'Tom Aaron' && ta.nickname === null && ta.height_in === null && ta.stance === null && ta.dob === '1978-07-13' && ta.fight_history_count === 2, `Aaron ${JSON.stringify(ta)}`);

try { P.parseFightPage(load('fight_fb4b1754d510b0d0.html').replace('Sub. att', 'Submission attempts'), 'test://mutated'); check(false, 'mutated header did not throw'); } catch (e2) { check(e2 instanceof SchemaAssertionError, `wrong error ${e2}`); }

console.log('parsers.mjs:', failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
