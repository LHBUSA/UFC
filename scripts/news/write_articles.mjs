#!/usr/bin/env node
/* Generate ufc_articles from our own tables.
 *
 * Every story is built in two steps: a JSON fact block assembled from
 * ufc_events / ufc_bouts / ufc_bout_results / ufc_bout_round_stats /
 * ufc_fighters (stored in ufc_articles.fact_block), then prose written ONLY
 * from that block. No odds, no picks, no probabilities, no predictions.
 *
 * Story generators
 *   fight_preview  one per bout on the next 2 upcoming UFC cards
 *   results        one per completed event with results (latest 4)
 *   external       short attributed items from ufc_news_items (last 48h, cap 6)
 *   card_change    bouts with status cancelled/replaced on an upcoming card
 *
 * Idempotent: a slug is never created twice. results / fight_preview are
 * refreshed only when the fact block hash changes (hash kept in `sources`).
 *
 *   node scripts/news/write_articles.mjs [--dry-run] [--types preview,results,external,card_change]
 *                                        [--limit N] [--llm] [--print] [--event <name substring>]
 *
 * --llm rewrites the template draft for flow with Claude (needs
 * ANTHROPIC_API_KEY in .env). The rewrite may not add facts, must keep every
 * number and must keep the funnel hook verbatim; output that fails those
 * checks is discarded and the template draft is stored instead.
 */
import { normalize } from '../../shared/alias_resolver.mjs';
import {
  Supabase, loadEnv, SITE_URL, slugify, eventSlug, matchupSlug, factHash, pick, wordCount,
  recordString, ageOn, heightString, mmss, weightClassLabel, METHOD_LABEL, eventShortName,
  isContenderSeries, formatDate, shortDate, dedupeEvents, loadFighterIndex, EXTERNAL_STORY_LABELS, titleCase,
} from './lib.mjs';

/* --------------------------------------------------------------- args */
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const DRY = flag('--dry-run');
const LLM = flag('--llm');
const PRINT = flag('--print');   /* dump every generated article body to stdout */
const LIMIT = Number(opt('--limit', 0)) || 0;
const EVENT_FILTER = opt('--event', '').toLowerCase();   /* results only: restrict to events whose name contains this */
const TYPE_ALIASES = { preview: 'fight_preview', previews: 'fight_preview', fight_preview: 'fight_preview', results: 'results', result: 'results', external: 'external', card_change: 'card_change', cardchange: 'card_change' };
const TYPES = new Set(opt('--types', 'preview,results,external,card_change').split(',').map((t) => TYPE_ALIASES[t.trim()]).filter(Boolean));

const HOOK = '*Algo lean: locked. PropBetEdge model pricing for this bout ships with UFC Pro; no pick is shown until the model has produced one.*';
const TEMPLATE_VERSION = 'template-1';
const LLM_MODEL = 'claude-sonnet-5';
const TODAY = new Date().toISOString().slice(0, 10);

/* --------------------------------------------------------------- data */

async function loadWorld(sb) {
  const [index, events, bouts, results, statRows, images, articles] = await Promise.all([
    loadFighterIndex(sb),
    sb.select('ufc_events', 'select=id,name,event_date,venue,city,region,country,card_status'),
    sb.select('ufc_bouts', 'select=id,event_id,fighter_a_id,fighter_b_id,weight_class,weight_class_raw,is_womens,is_title,scheduled_rounds,card_position,bout_order,status,replaced_bout_id,short_notice_days'),
    sb.select('ufc_bout_results', 'select=bout_id,winner_id,method,method_raw,round,time_sec,time_format,referee,scorecards,finish_detail,has_stats'),
    sb.select('ufc_bout_round_stats', 'select=bout_id,fighter_id,round,kd,sig_str_landed,sig_str_att,total_str_landed,total_str_att,td_landed,td_att,sub_att,ctrl_sec'),
    sb.select('ufc_images', 'select=id,kind,r2_key,license,author,source_url,fighter_id&kind=eq.wikimedia'),
    sb.select('ufc_articles', 'select=id,slug,story_type,status,sources,needs_human'),
  ]);

  const boutsByEvent = new Map();
  for (const b of bouts) { if (!boutsByEvent.has(b.event_id)) boutsByEvent.set(b.event_id, []); boutsByEvent.get(b.event_id).push(b); }
  const resultsByBout = new Map(results.map((r) => [r.bout_id, r]));
  const statsByBout = new Map();
  for (const s of statRows) { if (!statsByBout.has(s.bout_id)) statsByBout.set(s.bout_id, []); statsByBout.get(s.bout_id).push(s); }

  const primaries = dedupeEvents(events, { boutsByEvent, resultsByBout, statsByBout });
  const eventById = new Map(primaries.map((e) => [e.id, e]));
  const canon = new Map();
  for (const p of primaries) { canon.set(p.id, p.id); for (const a of p.alt_ids) canon.set(a, p.id); }
  /* Bouts of the primary copy only: a duplicate copy of the same card would double every fight. */
  const boutsOfEvent = (eid) => (boutsByEvent.get(eid) || []).slice().sort((x, y) => (y.bout_order || 0) - (x.bout_order || 0));

  /* Fighter archive: completed bouts with a result, newest first, one row per (date, opponent). */
  const archive = new Map();
  for (const b of bouts) {
    const r = resultsByBout.get(b.id);
    if (!r) continue;
    const e = eventById.get(canon.get(b.event_id));
    if (!e) continue;
    for (const [me, opp] of [[b.fighter_a_id, b.fighter_b_id], [b.fighter_b_id, b.fighter_a_id]]) {
      if (!archive.has(me)) archive.set(me, []);
      const oppF = index.byId.get(opp);
      let outcome = 'NC';
      if (r.method === 'DRAW') outcome = 'D';
      else if (r.method === 'NC') outcome = 'NC';
      else if (r.winner_id === me) outcome = 'W';
      else if (r.winner_id === opp) outcome = 'L';
      archive.get(me).push({
        bout_id: b.id, date: e.event_date, event: e.name, opponent_id: opp, opponent: oppF ? oppF.name : 'unknown opponent',
        result: outcome, method: r.method, method_label: METHOD_LABEL[r.method] || r.method_raw, round: r.round, time: mmss(r.time_sec),
      });
    }
  }
  for (const [fid, list] of archive) {
    const seen = new Set();
    archive.set(fid, list
      .sort((x, y) => String(y.date).localeCompare(String(x.date)) || String(x.bout_id).localeCompare(String(y.bout_id)))
      .filter((x) => { const k = `${x.date}|${normalize(x.opponent)}`; if (seen.has(k)) return false; seen.add(k); return true; }));
  }

  const imageByFighter = new Map();
  for (const im of images) if (im.fighter_id && !imageByFighter.has(im.fighter_id)) imageByFighter.set(im.fighter_id, im);

  return { index, events: primaries, eventById, canon, bouts, boutsOfEvent, resultsByBout, statsByBout, archive, imageByFighter, articles: new Map(articles.map((a) => [a.slug, a])) };
}

/* ------------------------------------------------------------ fighters */

function fighterFacts(world, fid, onDate) {
  const f = world.index.byId.get(fid);
  if (!f) return null;
  const hist = world.archive.get(fid) || [];
  const wins = hist.filter((h) => h.result === 'W');
  const finishes = wins.filter((h) => h.method === 'KO_TKO' || h.method === 'SUB');
  const career = f.career_slpm == null ? null : {
    label: 'UFC Stats career averages (career-to-date snapshot)',
    slpm: f.career_slpm, str_acc: f.career_str_acc, sapm: f.career_sapm, str_def: f.career_str_def,
    td_avg: f.career_td_avg, td_acc: f.career_td_acc, td_def: f.career_td_def, sub_avg: f.career_sub_avg,
  };
  return {
    id: f.id, name: f.name, nickname: f.nickname || null,
    record: { w: f.record_w, l: f.record_l, d: f.record_d, nc: f.record_nc }, record_str: recordString(f),
    age: ageOn(f.dob, onDate), height_in: f.height_in, height_str: heightString(f.height_in), reach_in: f.reach_in, stance: f.stance,
    last5: hist.slice(0, 5).map((h) => ({ date: h.date, opponent: h.opponent, result: h.result, method: h.method, method_label: h.method_label, round: h.round })),
    archive: {
      fights: hist.length, wins: wins.length, losses: hist.filter((h) => h.result === 'L').length, draws: hist.filter((h) => h.result === 'D').length,
      no_contests: hist.filter((h) => h.result === 'NC').length, finishes: finishes.length, finish_rate: wins.length ? Math.round((finishes.length / wins.length) * 100) : null,
    },
    career,
  };
}

function heroFor(world, fighterIds) {
  for (const fid of fighterIds) {
    const im = world.imageByFighter.get(fid);
    if (im) return { hero_image_ref: im.id, hero_credit: { author: im.author, license: im.license, source_url: im.source_url } };
  }
  return { hero_image_ref: null, hero_credit: null };
}

function eventFacts(e) {
  return { id: e.id, name: e.name, short_name: eventShortName(e.name), date: e.event_date, venue: e.venue, city: e.city, region: e.region, country: e.country, slug: eventSlug(e) };
}
function venueLine(ev) {
  const place = [ev.venue, ev.city].filter(Boolean).join(' in ');
  if (place) return place;
  return ev.country ? `a venue in ${ev.country} still to be listed` : 'a venue still to be listed';
}
function pronouns(isWomens) {
  return isWomens ? { he: 'she', his: 'her', him: 'her' } : { he: 'he', his: 'his', him: 'him' };
}
function fmtNum(n) { return n == null ? 'n/a' : String(n); }
function inches(n) { return n == null ? 'n/a' : `${Number(n) % 1 === 0 ? Number(n) : Number(n).toFixed(1)}"`; }
function stanceWord(s) { return s ? s.toLowerCase().replace('_', ' ') : null; }
/* Label used in the headline; the phrase used inside sentences derives from it. */
function positionLabel(bout, cardBouts) {
  const top = cardBouts[0] && cardBouts[0].id === bout.id;
  const second = cardBouts[1] && cardBouts[1].id === bout.id;
  if (bout.is_title) return 'title fight';
  if (top) return 'main event';
  if (second) return 'co-main event';
  if (bout.card_position === 'main') return 'main card';
  if (bout.card_position === 'prelim' || bout.card_position === 'early') return 'prelim';
  return 'card';
}
function positionPhrase(bt) {
  if (bt.position_label === 'title fight') return bt.bout_order != null && bt.is_main ? 'the title fight that closes the show' : 'the title fight';
  if (bt.position_label === 'main event') return 'the main event';
  if (bt.position_label === 'co-main event') return 'the co-main event';
  if (bt.card_position === 'main') return 'on the main card';
  if (bt.card_position === 'early') return 'on the early prelims';
  if (bt.card_position === 'prelim') return 'on the prelims';
  return 'on the card';
}
function joinWithAnd(parts) {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p.join('');
  return `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
}

/* ------------------------------------------------------- fight_preview */

function previewFactBlock(world, bout, e, cardBouts) {
  const a = fighterFacts(world, bout.fighter_a_id, e.event_date);
  const b = fighterFacts(world, bout.fighter_b_id, e.event_date);
  if (!a || !b) return null;
  const derived = {
    reach_diff_in: a.reach_in != null && b.reach_in != null ? Math.round((a.reach_in - b.reach_in) * 10) / 10 : null,
    height_diff_in: a.height_in != null && b.height_in != null ? Math.round((a.height_in - b.height_in) * 10) / 10 : null,
    age_diff: a.age != null && b.age != null ? a.age - b.age : null,
  };
  return {
    type: 'fight_preview',
    generated_from: ['ufc_events', 'ufc_bouts', 'ufc_bout_results', 'ufc_fighters'],
    event: eventFacts(e),
    bout: {
      id: bout.id, weight_class: bout.weight_class, weight_class_raw: bout.weight_class_raw, weight_class_label: weightClassLabel(bout),
      is_title: bout.is_title, is_womens: bout.is_womens, scheduled_rounds: bout.scheduled_rounds, card_position: bout.card_position,
      bout_order: bout.bout_order, position_label: positionLabel(bout, cardBouts), is_main: Boolean(cardBouts[0] && cardBouts[0].id === bout.id),
      status: bout.status, short_notice_days: bout.short_notice_days, card_size: cardBouts.length,
    },
    fighters: [a, b],
    derived,
  };
}

function last5Line(f) {
  return f.last5.map((h) => {
    const what = h.result === 'W' ? 'W' : h.result === 'L' ? 'L' : h.result === 'D' ? 'D' : 'NC';
    const how = h.round ? `${h.method_label}, R${h.round}` : h.method_label;
    return `- **${what}** vs ${h.opponent} — ${how} (${shortDate(h.date)})`;
  }).join('\n');
}

function archiveParagraph(f, p, seed) {
  const n = f.archive.fights;
  if (!n) {
    return pick(seed, [
      `The PropBetEdge archive holds no completed UFC bout for ${f.name} yet, so ${p.his} ${f.record_str || 'listed'} record stands on its own here; fight-by-fight detail for ${p.him} is still being loaded.`,
      `${f.name} has no completed UFC bout in the PropBetEdge archive at the time of writing. The ${f.record_str || 'listed'} record above is ${p.his} official line, and ${p.his} fight-by-fight history will fill in as the archive loads.`,
    ], f.id);
  }
  const last = f.last5[0];
  const { wins: w, losses: l, draws: dr, no_contests: nc, finishes: fin } = f.archive;
  const verb = last.result === 'W' ? `beat ${last.opponent}` : last.result === 'L' ? `lost to ${last.opponent}` : last.result === 'D' ? `drew with ${last.opponent}` : `had a no contest with ${last.opponent}`;
  const how = last.round ? `by ${last.method_label} in round ${last.round}` : `by ${last.method_label}`;
  let finishNote = '';
  if (w && fin === 0) finishNote = w === 1 ? 'That win went the distance.' : 'None of those wins came inside the distance.';
  else if (w && fin === w) finishNote = w === 1 ? 'That win came inside the distance.' : 'All of them came inside the distance.';
  else if (w) finishNote = `${fin} of those wins came inside the distance.`;
  const tally = joinWithAnd([
    `${w} ${w === 1 ? 'win' : 'wins'}`,
    l ? `${l} ${l === 1 ? 'loss' : 'losses'}` : null,
    dr ? `${dr} ${dr === 1 ? 'draw' : 'draws'}` : null,
    nc ? `${nc} no ${nc === 1 ? 'contest' : 'contests'}` : null,
  ]);
  const lead = pick(seed, [
    `${f.name} has ${n} completed UFC ${n === 1 ? 'bout' : 'bouts'} in the PropBetEdge archive: ${tally}. ${finishNote}`,
    `Our archive has ${n} completed UFC ${n === 1 ? 'bout' : 'bouts'} for ${f.name}, ${tally}. ${finishNote}`,
  ], `${f.id}-lead`);
  const recent = pick(seed, [
    `Most recently ${p.he} ${verb} ${how} on ${shortDate(last.date)}.`,
    `${p.he === 'he' ? 'He' : 'She'} last fought on ${shortDate(last.date)} and ${verb} ${how}.`,
  ], `${f.id}-recent`);
  return `${lead} ${recent}`.replace(/\s+/g, ' ').trim();
}

function careerSentence(f, p) {
  const c = f.career;
  if (!c) return '';
  const bits = [];
  if (c.slpm != null) bits.push(`${c.slpm} significant strikes landed per minute${c.str_acc != null ? ` at ${c.str_acc}% accuracy` : ''}`);
  if (c.sapm != null) bits.push(`${c.sapm} absorbed per minute${c.str_def != null ? ` with ${c.str_def}% striking defence` : ''}`);
  if (c.td_avg != null) bits.push(`${c.td_avg} takedowns per 15 minutes${c.td_acc != null ? ` at ${c.td_acc}% accuracy` : ''}`);
  if (c.sub_avg != null) bits.push(`${c.sub_avg} submission attempts per 15 minutes`);
  if (!bits.length) return '';
  return ` UFC Stats career averages list ${p.him} at ${joinWithAnd(bits)}; those are career-to-date figures, not a read on this matchup.`;
}

function tapeParagraph(fb, seed) {
  const [a, b] = fb.fighters;
  const pa = pronouns(fb.bout.is_womens);
  const s = [];
  const intro = (f) => {
    const parts = [];
    if (f.age != null) parts.push(`${f.age}`);
    const body = [];
    if (f.height_str) body.push(`listed at ${f.height_str}`);
    if (f.reach_in != null) body.push(`with a ${inches(f.reach_in).replace('"', '')}-inch reach`);
    if (f.stance) body.push(`fighting ${stanceWord(f.stance)}`);
    const who = f.nickname ? `${f.name} ("${f.nickname}")` : f.name;
    return `${who}${parts.length ? `, ${parts.join(', ')},` : ''} comes in at ${f.record_str || 'an unlisted record'}${body.length ? `, ${body.join(', ')}` : ''}.`;
  };
  s.push(intro(a));
  s.push(`${pick(seed, ['', 'Across the cage, ', `Opposite ${pa.him}, `], 'tape-b')}${intro(b)}`);
  const d = fb.derived;
  const inch = (n) => `${Math.abs(n)} ${Math.abs(n) === 1 ? 'inch' : 'inches'}`;
  const hHolder = d.height_diff_in == null || d.height_diff_in === 0 ? null : (d.height_diff_in > 0 ? a : b);
  const rHolder = d.reach_diff_in == null || d.reach_diff_in === 0 ? null : (d.reach_diff_in > 0 ? a : b);
  const diffs = [];
  if (hHolder && rHolder && hHolder.id === rHolder.id) {
    diffs.push(`${surnameOf(hHolder)} has ${inch(d.height_diff_in)} of height and ${inch(d.reach_diff_in)} of reach`);
  } else {
    if (d.height_diff_in != null) diffs.push(hHolder ? `${surnameOf(hHolder)} has ${inch(d.height_diff_in)} of height` : 'they are level on height');
    if (d.reach_diff_in != null) diffs.push(rHolder ? `${surnameOf(rHolder)} holds ${inch(d.reach_diff_in)} of reach` : 'reach is identical');
  }
  if (diffs.length) s.push(`On the tape, ${joinWithAnd(diffs)}.`);
  if (d.age_diff != null && d.age_diff !== 0) s.push(`${surnameOf(d.age_diff < 0 ? a : b)} is the younger by ${Math.abs(d.age_diff)} ${Math.abs(d.age_diff) === 1 ? 'year' : 'years'}.`);
  if (a.stance && b.stance) {
    const pair = new Set([a.stance, b.stance]);
    if (a.stance === b.stance) s.push(`Both fight ${stanceWord(a.stance)}.`);
    else if (pair.has('ORTHODOX') && pair.has('SOUTHPAW')) s.push(`It is an ${stanceWord(a.stance)}-versus-${stanceWord(b.stance)} pairing, so lead hands and lead legs line up on opposite sides.`);
    else s.push(`${a.name} is listed ${stanceWord(a.stance)}, ${surnameOf(b)} ${stanceWord(b.stance)}.`);
  }
  return s.join(' ');
}

/* Second mentions use the surname; single-token names stay whole. */
function surnameOf(f) {
  const toks = String(f.name).trim().split(/\s+/);
  return toks[toks.length - 1];
}

function tapeList(fb) {
  const [a, b] = fb.fighters;
  const row = (label, va, vb) => `- **${label}:** ${a.name} ${va} · ${b.name} ${vb}`;
  return [
    row('Record', a.record_str || 'n/a', b.record_str || 'n/a'),
    row('Age', fmtNum(a.age), fmtNum(b.age)),
    row('Height', a.height_str || 'n/a', b.height_str || 'n/a'),
    row('Reach', inches(a.reach_in), inches(b.reach_in)),
    row('Stance', a.stance ? titleCase(stanceWord(a.stance)) : 'n/a', b.stance ? titleCase(stanceWord(b.stance)) : 'n/a'),
  ].join('\n');
}

function watchParagraph(fb, seed) {
  const [a, b] = fb.fighters;
  const d = fb.derived;
  const s = [];
  if (d.reach_diff_in != null && Math.abs(d.reach_diff_in) >= 2) {
    const longer = d.reach_diff_in > 0 ? a : b;
    const shorter = d.reach_diff_in > 0 ? b : a;
    s.push(pick(seed, [
      `Range is the first thing the tape flags: ${longer.name} owns a ${Math.abs(d.reach_diff_in)}-inch reach advantage, which sets the distance ${shorter.name} has to cross to land.`,
      `The ${Math.abs(d.reach_diff_in)}-inch reach gap in ${longer.name}'s favour is the tape's headline number; it defines the range each ${fb.bout.is_womens ? 'woman' : 'man'} is working from.`,
    ], 'watch-reach'));
  } else if (d.reach_diff_in != null) {
    s.push(`Reach is close to even (${Math.abs(d.reach_diff_in)} ${Math.abs(d.reach_diff_in) === 1 ? 'inch' : 'inches'} between them), so neither fighter starts with a length edge.`);
  }
  if (a.stance && b.stance && a.stance !== b.stance) {
    const pair = new Set([a.stance, b.stance]);
    if (pair.has('ORTHODOX') && pair.has('SOUTHPAW')) {
      s.push(`The open-stance geometry puts ${a.name}'s lead ${a.stance === 'SOUTHPAW' ? 'right' : 'left'} side against ${b.name}'s lead ${b.stance === 'SOUTHPAW' ? 'right' : 'left'}, the classic setup for rear-hand and rear-kick exchanges.`);
    } else if (pair.has('SWITCH')) {
      const sw = a.stance === 'SWITCH' ? a : b;
      s.push(`${sw.name} is listed as a switch-stance fighter, so the lead side on ${sw.id === a.id ? 'that' : 'that'} side of the cage can change through the fight.`);
    }
  }
  const fin = (f) => (f.archive.wins ? `${f.name} has finished ${f.archive.finishes} of ${f.archive.wins} archived ${f.archive.wins === 1 ? 'win' : 'wins'}` : null);
  const finBits = [fin(a), fin(b)].filter(Boolean);
  if (finBits.length) s.push(`From our archive, ${joinWithAnd(finBits)}.`);
  const rounds = fb.bout.scheduled_rounds;
  const tail = [];
  if (fb.bout.is_title) tail.push(`The ${fb.bout.weight_class_label} title is on the line${rounds ? `, over ${rounds} rounds` : ''}.`);
  else if (rounds) tail.push(rounds === 5 ? 'It is scheduled for five rounds, so the pace of the first ten minutes carries into a championship distance.' : `It is scheduled for ${rounds} rounds.`);
  if (fb.bout.short_notice_days != null) tail.push(`Our tables have this booking at ${fb.bout.short_notice_days} days' notice.`);
  /* Thin tape (missing reach, empty archives): say what is on file and what is not, rather than pad. */
  if (d.reach_diff_in == null && d.height_diff_in != null && Math.abs(d.height_diff_in) >= 2) {
    const taller = d.height_diff_in > 0 ? a : b;
    const missing = [a, b].filter((f) => f.reach_in == null).map((f) => surnameOf(f));
    s.push(`Height is the one physical number that separates them on file: ${taller.name} is listed ${Math.abs(d.height_diff_in)} inches taller. Reach is not listed for ${missing.length === 2 ? 'either fighter' : missing[0]}.`);
  } else if (d.reach_diff_in == null) {
    s.push(`Reach is not on file for ${[a, b].filter((f) => f.reach_in == null).length === 2 ? 'either fighter' : surnameOf([a, b].find((f) => f.reach_in == null))}, so the tape cannot say who has the length.`);
  }
  for (const f of [a, b]) {
    if (f.record && f.record.w != null && (f.record.w + (f.record.l || 0) + (f.record.d || 0)) <= 2) {
      s.push(`${f.name}'s listed record is ${f.record_str}, which leaves no fight-level history to weigh.`);
    }
  }
  if (!a.archive.fights && !b.archive.fights) s.push('Neither fighter has a completed UFC bout in the PropBetEdge archive, so the tape above is the whole of what our tables can say before the walkouts.');
  if (!s.length) s.push('The tape offers no standout physical edge either way; the archive lines above are the concrete facts on file.');
  return [...s, ...tail].join(' ');
}

function renderPreview(fb, slug) {
  const [a, b] = fb.fighters;
  const ev = fb.event;
  const bt = fb.bout;
  const p = pronouns(bt.is_womens);
  const short = ev.short_name;
  const kindWord = bt.position_label;
  const headline = `${a.name} vs ${b.name}: ${bt.weight_class_label} ${kindWord} preview at ${short}`;
  const posPhrase = positionPhrase(bt);
  const dek = pick(slug, [
    `${a.name} (${a.record_str || 'record n/a'}) meets ${b.name} (${b.record_str || 'record n/a'}) at ${bt.weight_class_label} on ${shortDate(ev.date)}. Tale of the tape, archive form and what to watch.`,
    `Tale of the tape and archive form for ${a.name} against ${b.name}, ${posPhrase} at ${short} on ${shortDate(ev.date)}.`,
  ], 'dek');
  const roundsBit = bt.scheduled_rounds ? `, scheduled for ${bt.scheduled_rounds} rounds` : '';
  const posAs = posPhrase.startsWith('on ') ? posPhrase : `as ${posPhrase}`;
  const intro = pick(slug, [
    `${ev.name} lands on ${formatDate(ev.date)} at ${venueLine(ev)}, and ${posPhrase.startsWith('on ') ? `${posPhrase} sits` : `${posPhrase} is`} ${a.name} against ${b.name} at ${bt.weight_class_label}${roundsBit}.`,
    `${a.name} and ${b.name} meet at ${bt.weight_class_label} ${posAs} when ${short} arrives at ${venueLine(ev)} on ${formatDate(ev.date)}${roundsBit}.`,
    `On ${formatDate(ev.date)}, ${short} brings ${a.name} and ${b.name} together at ${bt.weight_class_label} ${posAs} at ${venueLine(ev)}${roundsBit}.`,
  ], 'intro');
  const featured = ['main event', 'co-main event', 'title fight'].includes(bt.position_label);
  const segment = bt.card_position === 'early' ? 'early prelims' : bt.card_position === 'prelim' ? 'prelims' : 'main card';
  const cardLine = pick(slug, [
    `Our schedule tables list ${bt.card_size} ${bt.card_size === 1 ? 'bout' : 'bouts'} on the card${bt.card_position && !featured ? `; this one is filed under the ${segment}` : ''}.`,
    `The card carries ${bt.card_size} ${bt.card_size === 1 ? 'bout' : 'bouts'} in our tables${bt.card_position && !featured ? `, with this pairing on the ${segment}` : ''}.`,
  ], 'card');

  const body = [
    `${intro} ${cardLine}`,
    '## Tale of the tape',
    tapeParagraph(fb, slug),
    tapeList(fb),
    '## What the archive says',
    `${archiveParagraph(a, p, slug)}${careerSentence(a, p)}`,
    a.last5.length ? last5Line(a) : null,
    `${archiveParagraph(b, p, slug)}${careerSentence(b, p)}`,
    b.last5.length ? last5Line(b) : null,
    '## What to watch',
    watchParagraph(fb, slug),
    HOOK,
  ].filter(Boolean).join('\n\n');
  return { headline, dek, body };
}

function generatePreviews(world) {
  const upcoming = world.events
    .filter((e) => e.event_date && e.event_date >= TODAY && !isContenderSeries(e.name))
    .map((e) => ({ e, bouts: world.boutsOfEvent(e.id).filter((b) => b.status === 'announced' || b.status === 'confirmed') }))
    .filter((x) => x.bouts.length)
    .sort((x, y) => x.e.event_date.localeCompare(y.e.event_date))
    .slice(0, 2);
  const out = [];
  for (const { e, bouts } of upcoming) {
    for (const bout of bouts) {
      const fb = previewFactBlock(world, bout, e, bouts);
      if (!fb) continue;
      const [a, b] = fb.fighters;
      const slug = `${slugify(a.name)}-vs-${slugify(b.name)}-preview-${e.event_date}`;
      const { headline, dek, body } = renderPreview(fb, slug);
      out.push({
        slug, story_type: 'fight_preview', headline, dek, body_md: body, fact_block: fb, status: 'published', needs_human: false,
        fighter_ids: [a.id, b.id], bout_id: bout.id, event_id: e.id, ...heroFor(world, [a.id, b.id]),
        extra_sources: [{ kind: 'matchup', slug: matchupSlug(a, b, e) }],
        target_words: [250, 450],
      });
    }
  }
  return { articles: out, events: upcoming.map((u) => ({ name: u.e.name, date: u.e.event_date, bouts: u.bouts.length })) };
}

/* -------------------------------------------------------------- results */

function methodVerb(method) {
  return { KO_TKO: 'stops', SUB: 'submits', DEC_U: 'outpoints', DEC_S: 'edges', DEC_M: 'takes majority decision over', DQ: 'wins by disqualification over', OTHER: 'defeats' }[method] || 'defeats';
}
function methodPast(method) {
  return { KO_TKO: 'stopped', SUB: 'submitted', DEC_U: 'outpointed', DEC_S: 'edged', DEC_M: 'took a majority decision over', DQ: 'won by disqualification over', OTHER: 'defeated' }[method] || 'defeated';
}

function statTotals(rows, fid) {
  const mine = rows.filter((r) => r.fighter_id === fid);
  if (!mine.length) return null;
  const sum = (k) => mine.reduce((acc, r) => acc + (r[k] || 0), 0);
  return { rounds: mine.length, kd: sum('kd'), sig_landed: sum('sig_str_landed'), sig_att: sum('sig_str_att'), total_landed: sum('total_str_landed'), total_att: sum('total_str_att'), td_landed: sum('td_landed'), td_att: sum('td_att'), sub_att: sum('sub_att'), ctrl_sec: sum('ctrl_sec'), ctrl: mmss(sum('ctrl_sec')) };
}

function resultsFactBlock(world, e) {
  const cardBouts = world.boutsOfEvent(e.id);
  const rows = [];
  for (const b of cardBouts) {
    const r = world.resultsByBout.get(b.id);
    if (!r) continue;
    const fa = world.index.byId.get(b.fighter_a_id);
    const fbb = world.index.byId.get(b.fighter_b_id);
    if (!fa || !fbb) continue;
    const winner = r.winner_id === fa.id ? fa : r.winner_id === fbb.id ? fbb : null;
    const loser = winner ? (winner.id === fa.id ? fbb : fa) : null;
    rows.push({
      bout_id: b.id, bout_order: b.bout_order, card_position: b.card_position, weight_class_label: weightClassLabel(b), is_title: b.is_title, scheduled_rounds: b.scheduled_rounds,
      a: { id: fa.id, name: fa.name, record_str: recordString(fa) }, b: { id: fbb.id, name: fbb.name, record_str: recordString(fbb) },
      winner: winner ? { id: winner.id, name: winner.name, record_str: recordString(winner) } : null,
      loser: loser ? { id: loser.id, name: loser.name, record_str: recordString(loser) } : null,
      method: r.method, method_label: METHOD_LABEL[r.method] || r.method_raw, method_raw: r.method_raw, round: r.round, time: mmss(r.time_sec), time_sec: r.time_sec,
      finish_detail: r.finish_detail, referee: r.referee, scorecards: r.scorecards,
    });
  }
  if (!rows.length) return null;
  const main = rows[0];
  const statRows = world.statsByBout.get(main.bout_id) || [];
  const stats = statRows.length ? { a: statTotals(statRows, main.a.id), b: statTotals(statRows, main.b.id) } : null;
  const finishes = rows.filter((r) => r.method === 'KO_TKO' || r.method === 'SUB').length;
  return {
    type: 'results',
    generated_from: ['ufc_events', 'ufc_bouts', 'ufc_bout_results', 'ufc_bout_round_stats', 'ufc_fighters'],
    event: eventFacts(e),
    bouts: rows,
    main: { ...main, stats },
    totals: { bouts: rows.length, finishes, ko_tko: rows.filter((r) => r.method === 'KO_TKO').length, subs: rows.filter((r) => r.method === 'SUB').length, decisions: rows.filter((r) => r.method.startsWith('DEC')).length },
  };
}

function resultLine(r) {
  const wc = r.weight_class_label;
  const tail = [r.method_label, r.round ? `R${r.round}` : null, r.time || null].filter(Boolean).join(' · ');
  if (r.method === 'DRAW') return `- ${r.a.name} vs ${r.b.name} · draw · ${tail.replace('draw · ', '')} (${wc})`;
  if (r.method === 'NC') return `- ${r.a.name} vs ${r.b.name} · no contest · ${tail.replace('no contest · ', '')} (${wc})`;
  if (!r.winner) return `- ${r.a.name} vs ${r.b.name} · ${tail} (${wc})`;
  return `- **${r.winner.name}** def. ${r.loser.name} · ${tail}${r.is_title ? ' · title fight' : ''} (${wc})`;
}

function scorecardText(sc) {
  if (!Array.isArray(sc) || !sc.length) return null;
  const parts = sc.map((s) => (s && s.score ? `${s.score}${s.judge ? ` (${s.judge})` : ''}` : null)).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function renderResults(fb, slug) {
  const ev = fb.event;
  const m = fb.main;
  let headline;
  if (m.method === 'DRAW') headline = `${ev.name} results: ${m.a.name} and ${m.b.name} fight to a draw`;
  else if (m.method === 'NC' || !m.winner) headline = `${ev.name} results: ${m.a.name} vs ${m.b.name} ruled a no contest`;
  else headline = `${ev.name} results: ${m.winner.name} ${methodVerb(m.method)} ${m.loser.name}`;

  const where = venueLine(ev);
  const when = formatDate(ev.date);
  const isDec = m.method.startsWith('DEC');
  const timeBit = m.round ? `${m.time ? `at ${m.time} of ` : 'in '}round ${m.round}` : '';

  let mainPara;
  if (m.winner) {
    const open = pick(slug, [
      `${m.winner.name} ${methodPast(m.method)} ${m.loser.name} in the ${m.weight_class_label} ${m.is_title ? 'title fight' : 'main event'} at ${where} on ${when}.`,
      `The ${m.weight_class_label} ${m.is_title ? 'title fight' : 'main event'} at ${where} went to ${m.winner.name}, who ${methodPast(m.method)} ${m.loser.name} on ${when}.`,
    ], 'main-open');
    let how;
    if (isDec) {
      const sc = scorecardText(m.scorecards);
      how = sc ? `The judges returned ${sc}.` : `It went the full ${m.scheduled_rounds || m.round || ''} rounds and was scored a ${m.method_label}.`.replace(/\s+rounds/, ' rounds');
    } else if (m.method === 'KO_TKO' || m.method === 'SUB') {
      how = `The finish came ${timeBit}${m.finish_detail ? ` (${m.finish_detail})` : ''}${m.referee ? `, with ${m.referee} the referee` : ''}.`;
    } else {
      how = `The result was recorded as ${m.method_raw}${timeBit ? ` ${timeBit}` : ''}${m.referee ? `; ${m.referee} refereed` : ''}.`;
    }
    const recs = `${m.winner.name} is listed at ${m.winner.record_str || 'an unlisted record'} in our tables; ${m.loser.name} at ${m.loser.record_str || 'an unlisted record'}.`;
    mainPara = `${open} ${how} ${recs}`;
  } else {
    mainPara = `${m.a.name} and ${m.b.name} met in the ${m.weight_class_label} ${m.is_title ? 'title fight' : 'main event'} at ${where} on ${when}; the bout was recorded as a ${m.method_label}${timeBit ? ` ${timeBit}` : ''}${m.referee ? ` under referee ${m.referee}` : ''}.`;
  }

  const t = fb.totals;
  const cardSummary = pick(slug, [
    `Across the ${t.bouts} ${t.bouts === 1 ? 'bout' : 'bouts'} with results in our tables, ${t.finishes} ended inside the distance (${t.ko_tko} by KO/TKO, ${t.subs} by submission) and ${t.decisions} went to the judges.`,
    `The card produced ${t.finishes} ${t.finishes === 1 ? 'finish' : 'finishes'} in ${t.bouts} recorded ${t.bouts === 1 ? 'bout' : 'bouts'}: ${t.ko_tko} KO/TKO, ${t.subs} ${t.subs === 1 ? 'submission' : 'submissions'}, ${t.decisions} ${t.decisions === 1 ? 'decision' : 'decisions'}.`,
  ], 'card-summary');

  const dek = m.winner
    ? `${m.winner.name} ${methodPast(m.method)} ${m.loser.name}${m.round ? ` in round ${m.round}` : ''} to close ${ev.short_name} at ${where}. Every result from the card, with main-event numbers where our round stats exist.`
    : `${m.a.name} vs ${m.b.name} ended in a ${m.method_label} at ${ev.short_name}. Every result from the card, with main-event numbers where our round stats exist.`;

  const sections = [
    '## Main event',
    mainPara,
    cardSummary,
    '## Full results',
    fb.bouts.map(resultLine).join('\n'),
  ];
  if (m.stats && m.stats.a && m.stats.b) {
    const A = m.stats.a; const B = m.stats.b;
    const pct = (l, a) => (a ? `${Math.round((l / a) * 100)}%` : 'n/a');
    sections.push('## By the numbers');
    sections.push(`Over ${A.rounds} ${A.rounds === 1 ? 'round' : 'rounds'} of UFC Stats data, ${m.a.name} landed ${A.sig_landed} of ${A.sig_att} significant strikes (${pct(A.sig_landed, A.sig_att)}) against ${B.sig_landed} of ${B.sig_att} (${pct(B.sig_landed, B.sig_att)}) for ${m.b.name}. Takedowns went ${A.td_landed} of ${A.td_att} for ${m.a.name} and ${B.td_landed} of ${B.td_att} for ${m.b.name}; control time was ${A.ctrl} to ${B.ctrl}${A.kd || B.kd ? `, with knockdowns ${A.kd}-${B.kd}` : ''}.`);
    sections.push([
      `- **Significant strikes:** ${m.a.name} ${A.sig_landed}/${A.sig_att} · ${m.b.name} ${B.sig_landed}/${B.sig_att}`,
      `- **Total strikes:** ${m.a.name} ${A.total_landed}/${A.total_att} · ${m.b.name} ${B.total_landed}/${B.total_att}`,
      `- **Takedowns:** ${m.a.name} ${A.td_landed}/${A.td_att} · ${m.b.name} ${B.td_landed}/${B.td_att}`,
      `- **Control time:** ${m.a.name} ${A.ctrl} · ${m.b.name} ${B.ctrl}`,
      `- **Knockdowns:** ${m.a.name} ${A.kd} · ${m.b.name} ${B.kd}`,
      `- **Submission attempts:** ${m.a.name} ${A.sub_att} · ${m.b.name} ${B.sub_att}`,
    ].join('\n'));
  }
  sections.push(`Full card, bout pages and fighter archives: [${ev.name}](${SITE_URL}/events/${ev.slug}).`);
  return { headline, dek, body: sections.join('\n\n') };
}

function generateResults(world) {
  const done = world.events
    .filter((e) => e.event_date && e.event_date <= TODAY && !isContenderSeries(e.name))
    .filter((e) => !EVENT_FILTER || e.name.toLowerCase().includes(EVENT_FILTER))
    .filter((e) => world.boutsOfEvent(e.id).some((b) => world.resultsByBout.has(b.id)))
    .sort((x, y) => y.event_date.localeCompare(x.event_date))
    .slice(0, 4);
  const out = [];
  for (const e of done) {
    const fb = resultsFactBlock(world, e);
    if (!fb) continue;
    const slug = `${fb.event.slug}-results`;
    const { headline, dek, body } = renderResults(fb, slug);
    const m = fb.main;
    const subjects = [m.winner ? m.winner.id : null, m.loser ? m.loser.id : null, m.a.id, m.b.id].filter(Boolean);
    out.push({
      slug, story_type: 'results', headline, dek, body_md: body, fact_block: fb, status: 'published', needs_human: false,
      fighter_ids: [...new Set(fb.bouts.flatMap((r) => [r.a.id, r.b.id]))], bout_id: m.bout_id, event_id: e.id, ...heroFor(world, subjects),
      extra_sources: [], target_words: [120, 900],
    });
  }
  return { articles: out, events: done.map((e) => ({ name: e.name, date: e.event_date })) };
}

/* ------------------------------------------------------------- external */

function titlePhrase(title, maxWords = 10) {
  const words = String(title).replace(/\s+/g, ' ').trim().split(' ');
  if (words.length <= maxWords) return title.trim();
  return `${words.slice(0, maxWords).join(' ').replace(/[,;:\-–—]$/, '')}…`;
}

function nextBoutFor(world, fid) {
  const cands = world.bouts
    .filter((b) => (b.fighter_a_id === fid || b.fighter_b_id === fid) && (b.status === 'announced' || b.status === 'confirmed'))
    .map((b) => ({ b, e: world.eventById.get(world.canon.get(b.event_id)) }))
    .filter((x) => x.e && x.e.event_date && x.e.event_date >= TODAY)
    .sort((x, y) => x.e.event_date.localeCompare(y.e.event_date));
  if (!cands.length) return null;
  const { b, e } = cands[0];
  const opp = world.index.byId.get(b.fighter_a_id === fid ? b.fighter_b_id : b.fighter_a_id);
  return { bout_id: b.id, opponent: opp ? opp.name : 'an opponent still to be listed', event: e.name, date: e.event_date, weight_class_label: weightClassLabel(b), status: b.status };
}

async function generateExternal(world, sb) {
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const items = await sb.select('ufc_news_items', `select=id,source_id,url,title,published_at,summary,taxonomy,fighter_ids,bout_id,event_id,captured_at&or=(published_at.gte.${since},and(published_at.is.null,captured_at.gte.${since}))&order=published_at.desc.nullslast`);
  const sources = new Map((await sb.select('ufc_news_sources', 'select=id,name,url')).map((s) => [s.id, s]));
  const out = [];
  for (const it of items) {
    const scores = (it.taxonomy && it.taxonomy.scores) || {};
    const qualifying = Object.keys(scores).filter((l) => EXTERNAL_STORY_LABELS.has(l) && scores[l] >= 0.6);
    if (!qualifying.length || !(it.taxonomy.confidence >= 0.6)) continue;
    if (!it.fighter_ids || !it.fighter_ids.length) continue;   /* nothing of our own to add -> no story */
    const src = sources.get(it.source_id);
    const fighters = it.fighter_ids.slice(0, 3).map((fid) => {
      const f = fighterFacts(world, fid, TODAY);
      return f ? { id: f.id, name: f.name, record_str: f.record_str, next_bout: nextBoutFor(world, fid), last: f.last5[0] || null } : null;
    }).filter(Boolean);
    if (!fighters.length) continue;
    let bout = null;
    if (it.bout_id) {
      const b = world.bouts.find((x) => x.id === it.bout_id);
      const e = b && world.eventById.get(world.canon.get(b.event_id));
      const fa = b && world.index.byId.get(b.fighter_a_id); const fbb = b && world.index.byId.get(b.fighter_b_id);
      if (b && e && fa && fbb) bout = { id: b.id, a: fa.name, b: fbb.name, weight_class_label: weightClassLabel(b), status: b.status, event: e.name, date: e.event_date };
    }
    const event = it.event_id && world.eventById.get(world.canon.get(it.event_id));
    const fb = {
      type: 'external',
      generated_from: ['ufc_news_items', 'ufc_fighters', 'ufc_bouts', 'ufc_events'],
      item: { id: it.id, title: it.title, url: it.url, published_at: it.published_at, source: src ? src.name : 'the source', labels: qualifying, confidence: it.taxonomy.confidence, quoted_phrase: titlePhrase(it.title, 6) },
      fighters, bout, event: event ? eventFacts(event) : null,
    };
    const slug = slugify(it.title).slice(0, 80).replace(/-+$/, '');
    if (!slug) continue;
    const review = qualifying.some((l) => l === 'injury' || l === 'withdrawal');
    const { headline, dek, body } = renderExternal(fb, slug);
    out.push({
      slug, story_type: 'external', headline, dek, body_md: body, fact_block: fb, status: review ? 'review' : 'published', needs_human: review,
      fighter_ids: fighters.map((f) => f.id), bout_id: bout ? bout.id : null, event_id: event ? event.id : null, ...heroFor(world, fighters.map((f) => f.id)),
      extra_sources: [{ kind: 'news_item', id: it.id, url: it.url }], target_words: [80, 150],
    });
    if (out.length >= 6) break;
  }
  return { articles: out };
}

function withArticle(word) {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/* The headline and dek are ours; the outside report contributes one short quoted phrase, once. */
function renderExternal(fb, slug) {
  const it = fb.item;
  const label = it.labels[0].replace('_', ' ');
  const names = joinWithAnd(fb.fighters.map((f) => f.name));
  const headline = `${titleCase(label)} report from ${it.source}: the table view on ${names}`;
  const dek = `${it.source} has ${withArticle(label)} item naming ${names}. Records, bookings and latest results from the PropBetEdge tables, with a link to the original.`;
  const lead = pick(slug, [
    `${it.source} is reporting "${it.quoted_phrase}" — the full report is at [${it.source}](${it.url}). What follows is what our own tables hold on the names involved.`,
    `${withArticle(label).replace(/^a/, 'A')} item from ${it.source} leads with "${it.quoted_phrase}". Read the original at [${it.source}](${it.url}); below is the PropBetEdge table view of the fighters it names.`,
  ], 'lead');

  /* Fighters booked against each other collapse into one sentence. */
  const lines = [];
  const used = new Set();
  for (const f of fb.fighters) {
    if (used.has(f.id)) continue;
    const partner = f.next_bout ? fb.fighters.find((g) => g.id !== f.id && g.next_bout && g.next_bout.bout_id === f.next_bout.bout_id) : null;
    if (partner) {
      used.add(f.id); used.add(partner.id);
      lines.push(`${f.name} (${f.record_str || 'record n/a'}) and ${partner.name} (${partner.record_str || 'record n/a'}) are booked against each other at ${f.next_bout.weight_class_label} on the ${f.next_bout.event} card, ${shortDate(f.next_bout.date)}; the bout is listed as ${f.next_bout.status} in our schedule.`);
      continue;
    }
    used.add(f.id);
    let s = `${f.name} is listed at ${f.record_str || 'an unlisted record'} in our tables`;
    if (f.next_bout) s += ` and is booked against ${f.next_bout.opponent} at ${f.next_bout.weight_class_label} on the ${f.next_bout.event} card (${shortDate(f.next_bout.date)}, listed as ${f.next_bout.status})`;
    else if (f.last) s += `; ${f.last.result === 'W' ? 'a win over' : f.last.result === 'L' ? 'a loss to' : 'a bout with'} ${f.last.opponent} on ${shortDate(f.last.date)} is the most recent result in our archive`;
    else s += ', with no completed UFC bout in our archive yet';
    lines.push(`${s}.`);
  }
  const boutLine = fb.bout && !fb.fighters.some((f) => f.next_bout && f.next_bout.bout_id === fb.bout.id)
    ? ` The bout the report points at, on our schedule: ${fb.bout.a} vs ${fb.bout.b}, ${fb.bout.weight_class_label}, ${fb.bout.event} on ${shortDate(fb.bout.date)}, currently ${fb.bout.status}.` : '';
  const anyBooking = Boolean(fb.bout) || fb.fighters.some((f) => f.next_bout);
  const close = anyBooking
    ? 'Any change to the booking shows on the event page once our schedule tables update. Nothing above beyond the quoted phrase comes from the outside report.'
    : 'The records and results above are from PropBetEdge tables; nothing beyond the quoted phrase comes from the outside report.';
  return { headline, dek, body: `${lead}\n\n${lines.join(' ')}${boutLine}\n\n${close}` };
}

/* ---------------------------------------------------------- card_change */

function generateCardChanges(world) {
  const out = [];
  for (const e of world.events) {
    if (!e.event_date || e.event_date < TODAY || isContenderSeries(e.name)) continue;
    for (const bout of world.boutsOfEvent(e.id)) {
      if (bout.status !== 'cancelled' && bout.status !== 'replaced') continue;
      const a = fighterFacts(world, bout.fighter_a_id, e.event_date);
      const b = fighterFacts(world, bout.fighter_b_id, e.event_date);
      if (!a || !b) continue;
      const repl = world.bouts.find((x) => x.replaced_bout_id === bout.id);
      const replacement = repl ? {
        id: repl.id, a: (world.index.byId.get(repl.fighter_a_id) || {}).name, b: (world.index.byId.get(repl.fighter_b_id) || {}).name,
        weight_class_label: weightClassLabel(repl), status: repl.status, short_notice_days: repl.short_notice_days,
        a_record: recordString(world.index.byId.get(repl.fighter_a_id)), b_record: recordString(world.index.byId.get(repl.fighter_b_id)),
      } : null;
      const fb = { type: 'card_change', generated_from: ['ufc_events', 'ufc_bouts', 'ufc_fighters'], event: eventFacts(e), bout: { id: bout.id, status: bout.status, weight_class_label: weightClassLabel(bout), card_position: bout.card_position, is_title: bout.is_title }, fighters: [a, b], replacement };
      const slug = `${slugify(a.name)}-vs-${slugify(b.name)}-off-${fb.event.slug}`;
      const headline = `${a.name} vs ${b.name} off ${fb.event.short_name}`;
      const dek = `The ${fb.bout.weight_class_label} bout is marked ${bout.status} in the PropBetEdge schedule for ${shortDate(e.event_date)}${replacement ? `; ${replacement.a} vs ${replacement.b} now holds the slot` : ''}.`;
      const para1 = `${a.name} vs ${b.name}, a ${fb.bout.weight_class_label} bout on ${e.name} (${formatDate(e.event_date)}, ${venueLine(e)}), is marked ${bout.status} in our schedule tables. Our tables record the status change, not the reason for it.`;
      const para2 = replacement
        ? `The slot now reads ${replacement.a} (${replacement.a_record || 'record n/a'}) vs ${replacement.b} (${replacement.b_record || 'record n/a'}) at ${replacement.weight_class_label}, status ${replacement.status}${replacement.short_notice_days != null ? `, booked at ${replacement.short_notice_days} days' notice` : ''}.`
        : 'No replacement bout is on our schedule for the slot at the time of writing.';
      const para3 = `${a.name} is listed at ${a.record_str || 'an unlisted record'}; ${b.name} at ${b.record_str || 'an unlisted record'}. The card page updates as the tables do: [${e.name}](${SITE_URL}/events/${fb.event.slug}).`;
      out.push({
        slug, story_type: 'card_change', headline, dek, body_md: [para1, para2, para3].join('\n\n'), fact_block: fb, status: 'published', needs_human: false,
        fighter_ids: [a.id, b.id], bout_id: bout.id, event_id: e.id, ...heroFor(world, [a.id, b.id]), extra_sources: [], target_words: [60, 300],
      });
    }
  }
  return { articles: out };
}

/* ------------------------------------------------------------------ LLM */

const LLM_SYSTEM = `You are a copy editor for PropBetEdge UFC, a fight-intelligence outlet. You receive a FACT BLOCK (JSON) and a DRAFT article written from it. Rewrite the draft for flow only.

Rules, all mandatory:
1. State no fact that is not in the fact block. Do not add names, dates, places, injuries, odds, picks, probabilities, predictions or quotes. Do not speculate about who wins.
2. Keep every number from the draft exactly as written (records, ages, inches, rounds, times, percentages, dates). Do not add new numbers.
3. Keep every Markdown heading line (## ...) and every Markdown list line (- ...) exactly as in the draft, in the same order.
4. Keep every Markdown link exactly as in the draft.
5. If the draft ends with an italic line beginning "*Algo lean: locked.", keep that line verbatim as the final line.
6. Short paragraphs, concrete, no hype adjectives, no filler about fans or excitement. Keep the length within 15% of the draft.
7. Output only the rewritten article body in Markdown. No preamble, no commentary.`;

const NUM_RE = /\d+(?:[.,:]\d+)*/g;
function numbersIn(s) { return new Set((String(s).match(NUM_RE) || []).map((n) => n.replace(/,/g, ''))); }

function validateRewrite(draft, out, fb) {
  if (!out || typeof out !== 'string') return 'empty';
  const allowed = new Set([...numbersIn(draft), ...numbersIn(JSON.stringify(fb))]);
  for (const n of numbersIn(out)) if (!allowed.has(n)) return `number ${n} not in fact block/draft`;
  if (draft.includes(HOOK) && !out.trim().endsWith(HOOK)) return 'funnel hook missing or moved';
  const heads = (t) => t.split('\n').filter((l) => /^(## |- )/.test(l.trim())).map((l) => l.trim());
  if (JSON.stringify(heads(draft)) !== JSON.stringify(heads(out))) return 'headings/list lines changed';
  const links = (t) => (t.match(/\[[^\]]*\]\([^)]*\)/g) || []).sort();
  if (JSON.stringify(links(draft)) !== JSON.stringify(links(out))) return 'links changed';
  const wd = wordCount(draft); const wo = wordCount(out);
  if (wo < wd * 0.8 || wo > wd * 1.2) return `length drifted (${wd} -> ${wo} words)`;
  if (/\b(odds|underdog|favou?rite|will win|should win|prediction|pick:)\b/i.test(out) && !/\b(odds|underdog|favou?rite|will win|should win|prediction|pick:)\b/i.test(draft)) return 'added betting/prediction language';
  return null;
}

async function llmRewrite(apiKey, draft, fb) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 4000,
      system: LLM_SYSTEM,
      messages: [{ role: 'user', content: `FACT BLOCK:\n${JSON.stringify(fb, null, 1)}\n\nDRAFT:\n${draft}` }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  if (json.stop_reason === 'refusal') throw new Error('anthropic: refusal');
  return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/* ------------------------------------------------------------- persist */

async function persist(sb, world, art, env, stats) {
  const hash = factHash(art.fact_block);
  const sources = [{ kind: 'fact_block', hash }, { kind: 'tables', names: art.fact_block.generated_from }, ...(art.extra_sources || [])];
  const existing = world.articles.get(art.slug);
  const [lo, hi] = art.target_words;
  const words = wordCount(art.body_md.replace(/^#+ .*$/gm, ''));
  const lenNote = words < lo || words > hi ? ` (words=${words}, target ${lo}-${hi})` : '';

  if (existing) {
    const refreshable = art.story_type === 'results' || art.story_type === 'fight_preview';
    const oldHash = (Array.isArray(existing.sources) ? existing.sources : []).find((s) => s && s.kind === 'fact_block');
    if (!refreshable || (oldHash && oldHash.hash === hash)) { stats.unchanged += 1; return; }
    stats.refreshed += 1;
    console.log(`  ~ refresh ${art.story_type} ${art.slug}${lenNote}`);
    if (DRY) return;
    let body = art.body_md; let model = TEMPLATE_VERSION;
    ({ body, model } = await maybeRewrite(env, art, body, model));
    /* Never demote a human-held row: a refresh keeps review/needs_human as the editor left them. */
    await sb.patch('ufc_articles', `id=eq.${existing.id}`, {
      headline: art.headline, dek: art.dek, body_md: body, fact_block: art.fact_block, sources, model_version: model,
      fighter_ids: art.fighter_ids, bout_id: art.bout_id, event_id: art.event_id, hero_image_ref: art.hero_image_ref, hero_credit: art.hero_credit,
      updated_at: new Date().toISOString(),
    });
    return;
  }

  stats.created += 1;
  console.log(`  + ${art.story_type.padEnd(13)} ${art.status.padEnd(9)} ${art.slug}${lenNote}`);
  if (PRINT) console.log(`
${'='.repeat(78)}
# ${art.headline}
_${art.dek}_

${art.body_md}
${'='.repeat(78)}
`);
  if (DRY) return;
  let body = art.body_md; let model = TEMPLATE_VERSION;
  ({ body, model } = await maybeRewrite(env, art, body, model));
  const now = new Date().toISOString();
  const row = {
    slug: art.slug, headline: art.headline, dek: art.dek, body_md: body, story_type: art.story_type, status: art.status,
    hero_image_ref: art.hero_image_ref, hero_credit: art.hero_credit, sources, fact_block: art.fact_block,
    fighter_ids: art.fighter_ids, bout_id: art.bout_id, event_id: art.event_id, model_version: model, needs_human: art.needs_human,
    published_at: art.status === 'published' ? now : null, updated_at: now,
  };
  const inserted = await sb.insert('ufc_articles', [row], { onConflict: 'slug', ignoreDuplicates: true });
  if (inserted && inserted[0]) world.articles.set(art.slug, inserted[0]);
}

async function maybeRewrite(env, art, body, model) {
  if (!LLM) return { body, model };
  if (!env.ANTHROPIC_API_KEY) { console.log('    llm: ANTHROPIC_API_KEY not set, template kept'); return { body, model }; }
  try {
    const out = await llmRewrite(env.ANTHROPIC_API_KEY, body, art.fact_block);
    const problem = validateRewrite(body, out, art.fact_block);
    if (problem) { console.log(`    llm: rejected (${problem}), template kept`); return { body, model }; }
    return { body: out, model: LLM_MODEL };
  } catch (e) {
    console.log(`    llm: ${e.message.slice(0, 160)}, template kept`);
    return { body, model };
  }
}

/* ----------------------------------------------------------------- main */

async function main() {
  const env = loadEnv();
  const sb = new Supabase(env);
  const world = await loadWorld(sb);
  console.log(`world: ${world.events.length} events (deduped), ${world.bouts.length} bouts, ${world.resultsByBout.size} results, ${world.statsByBout.size} bouts with round stats, ${world.index.fighters.length} fighters, ${world.imageByFighter.size} portraits, ${world.articles.size} existing articles`);
  if (LLM && !env.ANTHROPIC_API_KEY) console.log('--llm requested but ANTHROPIC_API_KEY is not set: running template mode');

  const batches = [];
  if (TYPES.has('fight_preview')) {
    const r = generatePreviews(world);
    console.log(`previews: ${r.events.length ? r.events.map((e) => `${e.name} (${e.date}, ${e.bouts} bouts)`).join('; ') : 'no upcoming card with announced bouts'}`);
    batches.push(r.articles);
  }
  if (TYPES.has('results')) {
    const r = generateResults(world);
    console.log(`results: ${r.events.length ? r.events.map((e) => `${e.name} (${e.date})`).join('; ') : 'no completed event with results'}`);
    batches.push(r.articles);
  }
  if (TYPES.has('external')) batches.push((await generateExternal(world, sb)).articles);
  if (TYPES.has('card_change')) batches.push(generateCardChanges(world).articles);

  const stats = { created: 0, refreshed: 0, unchanged: 0 };
  for (const list of batches) {
    const slice = LIMIT ? list.slice(0, LIMIT) : list;
    for (const art of slice) await persist(sb, world, art, env, stats);
  }
  console.log(`\n${DRY ? '[dry-run] ' : ''}created=${stats.created} refreshed=${stats.refreshed} unchanged=${stats.unchanged}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
