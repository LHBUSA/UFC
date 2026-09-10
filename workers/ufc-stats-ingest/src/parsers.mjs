/* UFC Stats HTML parsers (Worker side). Mirror of scripts/backfill/parsers.py,
 * verified against the same archived fixtures (parsers.test.mjs). cheerio is
 * pure JS and bundles into the Worker.
 *
 * Every parser throws SchemaAssertionError on any unexpected header, column
 * count, flag or enum value. Never guesses, never returns a partial row.
 * Site quirks asserted AS-IS: two-column completed list; per-round Totals
 * table labels Td as "Td %"; spacer rows at the top of list tables.
 */
import * as cheerio from 'cheerio';
import { SchemaAssertionError } from './ufcstats.mjs';
import * as N from './normalizers.mjs';

const HEX16 = /\/(?:event|fight|fighter)-details\/([0-9a-f]{16})/;
const H_EVENT_LIST = ['Name/date', 'Location'];
const H_FIGHTER_LIST = ['First', 'Last', 'Nickname', 'Ht.', 'Wt.', 'Reach', 'Stance', 'W', 'L', 'D', 'Belt'];
const H_EVENT_PAGE = ['W/L', 'Fighter', 'Kd', 'Str', 'Td', 'Sub', 'Weight class', 'Method', 'Round', 'Time'];
const H_TOTALS = ['Fighter', 'KD', 'Sig. str.', 'Sig. str. %', 'Total str.', 'Td', 'Td %', 'Sub. att', 'Rev.', 'Ctrl'];
const H_TOTALS_RND = ['Fighter', 'KD', 'Sig. str.', 'Sig. str. %', 'Total str.', 'Td %', 'Td %', 'Sub. att', 'Rev.', 'Ctrl'];
const H_SIG = ['Fighter', 'Sig. str', 'Sig. str. %', 'Head', 'Body', 'Leg', 'Distance', 'Clinch', 'Ground'];
const H_FIGHTER_HISTORY = ['W/L', 'Fighter', 'Kd', 'Str', 'Td', 'Sub', 'Event', 'Method', 'Round', 'Time'];
const RESULT_FLAG = { win: 'WIN', loss: 'LOSS', draw: 'DRAW', nc: 'NC', next: null };   /* next = upcoming bout */
const PERSON_STATUS = { W: 'WIN', L: 'LOSS', D: 'DRAW', NC: 'NC' };
const CAREER = { SLpM: 'career_slpm', 'Str. Acc.': 'career_str_acc', SApM: 'career_sapm', 'Str. Def': 'career_str_def',
  'TD Avg.': 'career_td_avg', 'TD Acc.': 'career_td_acc', 'TD Def.': 'career_td_def', 'Sub. Avg.': 'career_sub_avg' };

const t = ($, el) => $(el).text().replace(/\s+/g, ' ').trim();
function id(href, url) {
  const m = HEX16.exec(href || '');
  if (!m) throw new SchemaAssertionError(url, `no 16-hex id in href ${JSON.stringify(href)}`);
  return m[1];
}
function assertHeaders($, table, expected, url, label, allowRound = false) {
  let heads = $(table).find('thead th').toArray().map((x) => t($, x));
  if (allowRound) heads = heads.filter((h) => !/^Round \d+$/.test(h));
  if (JSON.stringify(heads) !== JSON.stringify(expected)) throw new SchemaAssertionError(url, `${label} headers ${JSON.stringify(heads)} != ${JSON.stringify(expected)}`);
}
function ps($, td) {
  const p = $(td).find('p').toArray().map((x) => t($, x));
  return p.length ? p : [t($, td)];
}
function boxItems($) {
  const items = {};
  $('ul.b-list__box-list li').each((_, li) => {
    const s = t($, li);
    const i = s.indexOf(':');
    if (i > 0) items[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return items;
}

export function parseEventList(html, url) {
  const $ = cheerio.load(html);
  const table = $('table.b-statistics__table-events').first();
  if (!table.length) throw new SchemaAssertionError(url, 'events table missing');
  assertHeaders($, table, H_EVENT_LIST, url, 'event list');
  const out = [];
  table.find('tbody tr').each((_, tr) => {
    const a = $(tr).find("a[href*='event-details']").first();
    if (!a.length) { if (t($, tr)) throw new SchemaAssertionError(url, `event row without link: ${t($, tr).slice(0, 80)}`); return; }
    const tds = $(tr).find('td');
    if (tds.length !== 2) throw new SchemaAssertionError(url, `event row has ${tds.length} cells`);
    const date = $(tds[0]).find('span.b-statistics__date').first();
    if (!date.length) throw new SchemaAssertionError(url, `event row without date span: ${t($, tds[0])}`);
    out.push({ ufcstats_id: id(a.attr('href'), url), name: t($, a), event_date: N.eventDate(t($, date), url), location_raw: t($, tds[1]) || null });
  });
  if (!out.length) throw new SchemaAssertionError(url, 'event list parsed zero events');
  return out;
}

export function parseFighterList(html, url) {
  const $ = cheerio.load(html);
  const table = $('table.b-statistics__table').first();
  if (!table.length) throw new SchemaAssertionError(url, 'fighters table missing');
  assertHeaders($, table, H_FIGHTER_LIST, url, 'fighter list');
  const out = [];
  table.find('tbody tr').each((_, tr) => {
    const a = $(tr).find("a[href*='fighter-details']").first();
    if (!a.length) { if (t($, tr)) throw new SchemaAssertionError(url, `fighter row without link: ${t($, tr).slice(0, 80)}`); return; }
    const c = $(tr).find('td').toArray().map((x) => t($, x));
    if (c.length !== 11) throw new SchemaAssertionError(url, `fighter row has ${c.length} cells`);
    out.push({ ufcstats_id: id(a.attr('href'), url), first: c[0], last: c[1], nickname: c[2] || null,
      height_in: N.heightIn(c[3], url), weight_lbs: N.weightLbs(c[4], url), reach_in: N.reachIn(c[5], url), stance: N.normStance(c[6], url),
      record_w: N.intOrNull(c[7], url), record_l: N.intOrNull(c[8], url), record_d: N.intOrNull(c[9], url),
      belt: $(tr).find('td').eq(10).find('img').length > 0 });
  });
  return out;
}

export function parseEventPage(html, url) {
  const $ = cheerio.load(html);
  const title = t($, $('h2').first());
  if (!title) throw new SchemaAssertionError(url, 'event title (h2) missing');
  const items = boxItems($);
  if (!items.Date) throw new SchemaAssertionError(url, `event Date item missing: ${Object.keys(items)}`);
  const table = $('table.b-fight-details__table_type_event-details').first();
  if (!table.length) throw new SchemaAssertionError(url, 'event bouts table missing');
  assertHeaders($, table, H_EVENT_PAGE, url, 'event page');
  const rows = table.find('tbody tr').toArray().filter((tr) => $(tr).find('td').length);
  const n = rows.length;
  const bouts = rows.map((tr, i) => {
    const tds = $(tr).find('td');
    if (tds.length !== 10) throw new SchemaAssertionError(url, `bout row has ${tds.length} cells`);
    const link = $(tr).attr('data-link') || $(tds[0]).find('a').attr('href');
    const fighters = $(tds[1]).find("a[href*='fighter-details']").toArray();
    if (fighters.length !== 2) throw new SchemaAssertionError(url, `bout row has ${fighters.length} fighter links`);
    const flags = ps($, tds[0]).filter(Boolean);
    for (const f of flags) if (!(f in RESULT_FLAG)) throw new SchemaAssertionError(url, `unknown W/L flag ${JSON.stringify(f)}`);
    const method = ps($, tds[7]);
    return {
      ufcstats_id: link ? id(link, url) : null,
      fighter_a_ufcstats_id: id($(fighters[0]).attr('href'), url), fighter_a_name: t($, fighters[0]),
      fighter_b_ufcstats_id: id($(fighters[1]).attr('href'), url), fighter_b_name: t($, fighters[1]),
      result_flag_a: flags.length ? RESULT_FLAG[flags[0]] : null,
      weight_class_raw: t($, tds[6]), method_raw: method[0] || null, method_detail: method[1] || null,
      round: N.intOrNull(t($, tds[8]), url), time: t($, tds[9]) || null, bout_order: n - i,
    };
  });
  if (!bouts.length) throw new SchemaAssertionError(url, 'event page parsed zero bouts');
  return { ufcstats_id: id(url, url), name: title, event_date: N.eventDate(items.Date, url), location_raw: items.Location || null, bouts };
}

/* The site nests <thead>Round N</thead> blocks inside <tbody>. An HTML5
 * parser (parse5, which cheerio uses) hoists each one out into its own
 * thead/tbody siblings, so walk the table's theads and rows in document
 * order instead of assuming the nesting lxml preserves. */
function* roundRows($, table, url, label) {
  let rnd = null;
  for (const el of $(table).find('thead, tbody > tr').toArray()) {
    if (el.tagName === 'thead') {
      const s = t($, el);
      const m = /^Round (\d+)$/.exec(s);
      if (m) rnd = Number(m[1]);
      else if (!s.startsWith('Fighter')) throw new SchemaAssertionError(url, `${label}: unexpected inner head ${s}`);
    } else {
      const tds = $(el).find('td').toArray();
      if (!tds.length) continue;
      if (rnd === null) throw new SchemaAssertionError(url, `${label}: row before any Round head`);
      yield [rnd, tds];
    }
  }
}
function pair($, td, url) {
  const p = ps($, td);
  if (p.length !== 2) throw new SchemaAssertionError(url, `stat cell does not stack two fighters: ${JSON.stringify(p)}`);
  return p;
}

/* True when a fight page was captured or fetched before the bout happened.
 *
 * UFC Stats serves the same /fight-details/ URL as a "tale of the tape"
 * matchup preview until a result exists: both corner status flags render
 * empty and no Method item is present. Nothing may be inferred from it - no
 * winner, no method, no round stats - so the caller must treat it as a
 * coverage gap and move on rather than let parseFightPage raise a schema
 * assertion, which would abort the whole run over a known, diagnosable case.
 *
 * Kept identical to scripts/backfill/parsers.py so the scheduled worker and
 * the historical backfill classify the same page the same way. */
export function isPreResultFightPage(html) {
  const $ = cheerio.load(html);
  const persons = $('.b-fight-details__person').toArray();
  if (!persons.length) return false;
  for (const p of persons) {
    if (t($, $(p).find('.b-fight-details__person-status').first()) in PERSON_STATUS) return false;
  }
  let hasMethod = false;
  $('.b-fight-details__text-item, .b-fight-details__text-item_first').each((_, it) => {
    const s = t($, it);
    if (s.includes(':') && s.split(':', 1)[0].trim() === 'Method') hasMethod = true;
  });
  return !hasMethod;
}

export function parseFightPage(html, url) {
  const $ = cheerio.load(html);
  const persons = $('.b-fight-details__person').toArray().map((p) => {
    const a = $(p).find('h3 a').first();
    const status = t($, $(p).find('.b-fight-details__person-status').first());
    if (!a.length || !(status in PERSON_STATUS)) throw new SchemaAssertionError(url, `person block malformed (status ${JSON.stringify(status)})`);
    const nick = t($, $(p).find('.b-fight-details__person-title').first()).replace(/^"|"$/g, '');
    return { ufcstats_id: id(a.attr('href'), url), name: t($, a), flag: PERSON_STATUS[status], nickname: nick || null };
  });
  if (persons.length !== 2) throw new SchemaAssertionError(url, `${persons.length} person blocks`);
  const title = t($, $('.b-fight-details__fight-title').first());
  if (!title) throw new SchemaAssertionError(url, 'fight title missing');
  const items = {};
  $('.b-fight-details__text-item, .b-fight-details__text-item_first').each((_, it) => {
    const s = t($, it); const i = s.indexOf(':');
    if (i > 0) items[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  for (const k of ['Method', 'Round', 'Time', 'Time format', 'Referee']) if (!(k in items)) throw new SchemaAssertionError(url, `result item ${k} missing`);
  let details = '';
  $('.b-fight-details__text').each((_, b) => { const s = t($, b); if (s.startsWith('Details:')) details = s.slice(8).trim(); });
  const flags = new Set(persons.map((p) => p.flag));
  const method = (flags.size === 1 && flags.has('DRAW')) ? 'DRAW' : flags.has('NC') ? 'NC' : N.normMethod(items.Method, url);
  const scorecards = (method.startsWith('DEC') || method === 'DRAW') ? N.scorecards(details) : null;
  const wc = N.normWeightClass(title, url);

  const tables = $('table').toArray();
  const rounds = [];
  if (tables.length) {
    if (tables.length !== 4) throw new SchemaAssertionError(url, `${tables.length} stats tables (expected 4 or 0)`);
    assertHeaders($, tables[0], H_TOTALS, url, 'totals');
    assertHeaders($, tables[1], H_TOTALS_RND, url, 'totals per round', true);
    assertHeaders($, tables[2], H_SIG, url, 'sig strikes');
    assertHeaders($, tables[3], H_SIG, url, 'sig strikes per round', true);
    const byKey = new Map();
    for (const [rnd, tds] of roundRows($, tables[1], url, 'totals per round')) {
      if (tds.length !== 10) throw new SchemaAssertionError(url, `totals round row has ${tds.length} cells`);
      const names = pair($, tds[0], url);
      if (names[0] !== persons[0].name || names[1] !== persons[1].name) throw new SchemaAssertionError(url, `fighter order ${names} != persons`);
      for (const side of [0, 1]) {
        const pick = (i) => pair($, tds[i], url)[side];
        const [sl, sa] = N.xOfY(pick(2), url); const [tl, ta] = N.xOfY(pick(4), url); const [dl, da] = N.xOfY(pick(5), url);
        byKey.set(`${persons[side].ufcstats_id}|${rnd}`, {
          fighter_ufcstats_id: persons[side].ufcstats_id, round: rnd, kd: N.intOrNull(pick(1), url),
          sig_str_landed: sl, sig_str_att: sa, total_str_landed: tl, total_str_att: ta, td_landed: dl, td_att: da,
          sub_att: N.intOrNull(pick(7), url), rev: N.intOrNull(pick(8), url), ctrl_sec: N.mmssToSec(pick(9), url),
        });
      }
    }
    for (const [rnd, tds] of roundRows($, tables[3], url, 'sig per round')) {
      if (tds.length !== 9) throw new SchemaAssertionError(url, `sig round row has ${tds.length} cells`);
      for (const side of [0, 1]) {
        const row = byKey.get(`${persons[side].ufcstats_id}|${rnd}`);
        if (!row) throw new SchemaAssertionError(url, `sig round ${rnd} without totals row`);
        const pick = (i) => pair($, tds[i], url)[side];
        for (const [col, idx] of [['head', 3], ['body', 4], ['leg', 5], ['distance', 6], ['clinch', 7], ['ground', 8]]) {
          const [l, a] = N.xOfY(pick(idx), url); row[`${col}_landed`] = l; row[`${col}_att`] = a;
        }
      }
    }
    const order = persons.map((p) => p.ufcstats_id);
    rounds.push(...[...byKey.values()].sort((a, b) => (a.round - b.round) || (order.indexOf(a.fighter_ufcstats_id) - order.indexOf(b.fighter_ufcstats_id))));
  }
  const winner = persons.find((p) => p.flag === 'WIN');
  return {
    ufcstats_id: id(url, url), fighters: persons, weight_class_raw: title, is_title: wc.is_title, weight_class: wc.weight_class, is_womens: wc.is_womens,
    method, method_raw: items.Method, round: N.intOrNull(items.Round, url), time_sec: N.mmssToSec(items.Time, url),
    time_format: items['Time format'] || null, scheduled_rounds: N.scheduledRounds(items['Time format'], url),
    referee: items.Referee || null, details_raw: details || null, scorecards, finish_detail: scorecards ? null : (details || null),
    winner_ufcstats_id: winner ? winner.ufcstats_id : null, has_stats: rounds.length > 0, rounds,
  };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function historyDate(s, url) {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(String(s || '').trim());
  const mo = m ? MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()] : null;
  if (!m || !mo) throw new SchemaAssertionError(url, `history date ${JSON.stringify(s)} unparseable`);
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/* Fight-history rows with the identifiers needed to resolve a bout WITHOUT the
 * completed-events list: fight id, both fighter ids, event id, name and date.
 * This is how cards the list omits (Contender Series) are reached. Upcoming
 * ("next") rows are skipped. Additive: parseFighterPage is unchanged. */
export function parseFighterHistory(html, url) {
  const $ = cheerio.load(html);
  const table = $('table.b-fight-details__table_type_event-details').first();
  if (!table.length) throw new SchemaAssertionError(url, 'fighter history table missing');
  assertHeaders($, table, H_FIGHTER_HISTORY, url, 'fighter history');
  const self = id(url, url);
  const rows = [];
  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;
    const flag = (ps($, tds[0])[0] || '').trim().toLowerCase();
    if (flag === 'next') return;
    const link = $(tr).attr('data-link');
    if (!link) { if (t($, tr)) throw new SchemaAssertionError(url, `history row without data-link: ${t($, tr).slice(0, 60)}`); return; }
    const fighters = $(tds[1]).find("a[href*='fighter-details']").toArray();
    if (fighters.length !== 2) throw new SchemaAssertionError(url, `history row has ${fighters.length} fighter links`);
    const ids = fighters.map((a) => id($(a).attr('href'), url));
    const opp = ids[0] === self ? 1 : ids[1] === self ? 0 : -1;
    if (opp < 0) throw new SchemaAssertionError(url, 'history row does not include the page fighter');
    const ev = $(tds[6]).find("a[href*='event-details']").first();
    if (!ev.length) throw new SchemaAssertionError(url, 'history row without event link');
    const evText = ps($, tds[6]);
    rows.push({
      fight_id: id(link, url), self_ufcstats_id: self,
      opponent_ufcstats_id: ids[opp], opponent_name: t($, fighters[opp]),
      event_ufcstats_id: id(ev.attr('href'), url), event_name: t($, ev), event_date: historyDate(evText[evText.length - 1], url),
      result_flag: RESULT_FLAG[flag] ?? null,
    });
  });
  return rows;
}

export function parseFighterPage(html, url) {
  const $ = cheerio.load(html);
  const name = t($, $('h2 .b-content__title-highlight').first());
  const rec = t($, $('h2 .b-content__title-record').first());
  if (!name || !rec.startsWith('Record:')) throw new SchemaAssertionError(url, `fighter title/record missing (${name}, ${rec})`);
  const items = boxItems($);
  for (const k of ['Height', 'Weight', 'Reach', 'STANCE', 'DOB']) if (!(k in items)) throw new SchemaAssertionError(url, `fighter detail ${k} missing`);
  const career = {};
  for (const [label, col] of Object.entries(CAREER)) {
    if (!(label in items)) throw new SchemaAssertionError(url, `career stat ${label} missing`);
    career[col] = items[label].endsWith('%') ? N.pctOrNull(items[label], url) : N.numOrNull(items[label], url);
  }
  const table = $('table.b-fight-details__table_type_event-details').first();
  if (!table.length) throw new SchemaAssertionError(url, 'fighter history table missing');
  assertHeaders($, table, H_FIGHTER_HISTORY, url, 'fighter history');
  const history = [];
  let upcoming = 0;
  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;
    const link = $(tr).attr('data-link');
    const flag = (ps($, tds[0])[0] || '').trim().toLowerCase();
    if (flag === 'next') { upcoming += 1; return; }   /* upcoming bout row: no fight-details link yet */
    if (link) history.push(id(link, url));
    else if (t($, tr)) throw new SchemaAssertionError(url, `history row without data-link: ${t($, tr).slice(0, 60)}`);
  });
  return {
    ufcstats_id: id(url, url), name, nickname: t($, $('p.b-content__Nickname').first()) || null, ...N.record(rec, url),
    height_in: N.heightIn(items.Height, url), weight_lbs: N.weightLbs(items.Weight, url), reach_in: N.reachIn(items.Reach, url),
    stance: N.normStance(items.STANCE, url), dob: N.dob(items.DOB, url), ...career,
    fight_history_count: history.length, history_fight_ids: history, upcoming_rows: upcoming,
  };
}
