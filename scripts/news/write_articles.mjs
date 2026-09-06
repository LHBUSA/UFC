#!/usr/bin/env node
/* Generate ufc_articles from our own tables (fact block v2, docs/editorial_contract.md).
 *
 * Every story is built in two steps: a JSON fact block assembled from
 * ufc_events / ufc_bouts / ufc_bout_results / ufc_bout_round_stats /
 * ufc_fighters (stored in ufc_articles.fact_block), then prose written ONLY
 * from that block. No FABRICATED odds, picks, probabilities or predictions:
 * betting-impact analysis (fact_block.bettor_angle) is derived by rule from
 * the verified block; odds_status / model_status stay "unavailable" until
 * verified structured data exists.
 *
 * Story generators
 *   fight_preview  one per bout on the next 2 upcoming UFC cards
 *   results        one per completed event with results (latest 4)
 *   external       short attributed items from ufc_news_items (last 48h, cap 6)
 *   card_change    bouts with status cancelled/replaced on an upcoming card
 *
 * Idempotent: a slug is never created twice. results / fight_preview are
 * refreshed only when the salted fact-block hash changes (hash kept in
 * `sources`; bumping HASH_SALT regenerates every article once).
 *
 *   node scripts/news/write_articles.mjs [--dry-run] [--types preview,results,external,card_change]
 *                                        [--limit N] [--llm] [--print] [--force] [--event <name substring>]
 *
 * --llm rewrites the template draft for flow and matchup translation with
 * Claude (needs ANTHROPIC_API_KEY in .env). The rewrite may not add facts or
 * numbers, must keep headings / list lines / links, and passes the same
 * editorial gates as the template; output that fails is discarded and the
 * template draft is stored. A template draft that fails a gate is stored with
 * status='review', needs_human=true and fact_block.review_reason (fail closed).
 */
import { normalize } from '../../shared/alias_resolver.mjs';
import {
  Supabase, loadEnv, slugify, eventSlug, matchupSlug, fighterSlug, factHash, pick, wordCount,
  recordString, ageOn, heightString, mmss, weightClassLabel, METHOD_LABEL, eventShortName,
  isContenderSeries, formatDate, shortDate, dedupeEvents, loadFighterIndex, EXTERNAL_STORY_LABELS, titleCase,
  pctPrinted, numOrNull, daysBetween,
} from './lib.mjs';

/* --------------------------------------------------------------- args */
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const DRY = flag('--dry-run');
const LLM = flag('--llm');
const FORCE = flag('--force');   /* refresh preview/results rows even when the fact-block hash is unchanged (prose/template fixes) */
const PRINT = flag('--print');   /* dump every created/refreshed article (body + bettor_angle) to stdout */
const LIMIT = Number(opt('--limit', 0)) || 0;
const EVENT_FILTER = opt('--event', '').toLowerCase();   /* results only: restrict to events whose name contains this */
const TYPE_ALIASES = { preview: 'fight_preview', previews: 'fight_preview', fight_preview: 'fight_preview', results: 'results', result: 'results', external: 'external', card_change: 'card_change', cardchange: 'card_change' };
const TYPES = new Set(opt('--types', 'preview,results,external,card_change').split(',').map((t) => TYPE_ALIASES[t.trim()]).filter(Boolean));

const FACT_VERSION = 2;
const HASH_SALT = 'v2';                 /* bump -> every stored preview/results article regenerates once */
const TEMPLATE_VERSION = 'template-2';
const LLM_MODEL = 'claude-sonnet-5';
const TODAY = new Date().toISOString().slice(0, 10);

/* Depth targets (addendum §2) and the floor a story marked `depth.short` must still clear. */
const DEPTH = {
  main_event_preview: [900, 1500], main_card_preview: [650, 1050], prelim_preview: [300, 700], event_preview: [1200, 2000],
  results: [800, 1400], card_change: [500, 900], rankings: [500, 900], external: [250, 500],
};
const SHORT_FLOOR = { main_event_preview: 450, main_card_preview: 350, prelim_preview: 180, results: 400, card_change: 60, external: 60 };
const MARKETS = ['moneyline', 'fight_goes_distance', 'total_rounds', 'method_of_victory', 'round_betting', 'significant_strikes', 'takedowns'];
const ODDS_NOTE = 'Current market price not yet available in PropBetEdge data.';

/* --------------------------------------------------------------- data */

async function loadWorld(sb) {
  const [index, events, bouts, results, statRows, images, articles] = await Promise.all([
    loadFighterIndex(sb),
    sb.select('ufc_events', 'select=id,name,event_date,venue,city,region,country,card_status'),
    sb.select('ufc_bouts', 'select=id,event_id,fighter_a_id,fighter_b_id,weight_class,weight_class_raw,is_womens,is_title,scheduled_rounds,card_position,bout_order,status,replaced_bout_id,short_notice_days'),
    sb.select('ufc_bout_results', 'select=bout_id,winner_id,method,method_raw,round,time_sec,time_format,referee,scorecards,finish_detail,has_stats'),
    sb.select('ufc_bout_round_stats', 'select=bout_id,fighter_id,round,kd,sig_str_landed,sig_str_att,total_str_landed,total_str_att,td_landed,td_att,sub_att,ctrl_sec'),
    sb.select('ufc_images', 'select=id,kind,r2_key,license,author,source_url,fighter_id&kind=eq.wikimedia'),
    sb.select('ufc_articles', 'select=id,slug,headline,story_type,status,sources,needs_human'),
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
        opponent_slug: oppF ? fighterSlug(oppF) : null, result: outcome, method: r.method, method_label: METHOD_LABEL[r.method] || r.method_raw,
        round: r.round, time: mmss(r.time_sec),
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

  /* Slug universe the site builds (web/lib/slug.ts): used by the internal-link gate. */
  const slugs = { fighters: new Set(index.fighters.map((f) => fighterSlug(f))), events: new Set(primaries.map((e) => eventSlug(e))), fights: new Set(), articles: new Set(articles.map((a) => a.slug)) };
  for (const b of bouts) {
    const e = eventById.get(canon.get(b.event_id)); const fa = index.byId.get(b.fighter_a_id); const fbb = index.byId.get(b.fighter_b_id);
    if (e && fa && fbb) { slugs.fights.add(matchupSlug(fa, fbb, e)); slugs.fights.add(matchupSlug(fbb, fa, e)); }
  }

  return { index, events: primaries, eventById, canon, bouts, boutsOfEvent, resultsByBout, statsByBout, archive, imageByFighter, slugs, articles: new Map(articles.map((a) => [a.slug, a])) };
}

/* ------------------------------------------------------------ fighters */

/* FighterFacts per docs/editorial_contract.md. The archive is as of `onDate`
 * (bouts dated before it): previews see everything, results stories see the
 * pre-fight picture; days_since_last is the layoff going into that date. */
function fighterFacts(world, fid, onDate) {
  const f = world.index.byId.get(fid);
  if (!f) return null;
  const hist = (world.archive.get(fid) || []).filter((h) => !onDate || !h.date || h.date < onDate);
  let w = 0, l = 0, d = 0, nc = 0, ko = 0, sub = 0, dec = 0, finishedBy = 0, r1 = 0;
  for (const h of hist) {
    if (h.result === 'NC') { nc += 1; continue; }
    if (h.result === 'D') { d += 1; continue; }
    if (h.result === 'W') {
      w += 1;
      if (h.method === 'KO_TKO') ko += 1; else if (h.method === 'SUB') sub += 1; else dec += 1;
      if ((h.method === 'KO_TKO' || h.method === 'SUB') && h.round === 1) r1 += 1;
    } else { l += 1; if (h.method === 'KO_TKO' || h.method === 'SUB') finishedBy += 1; }
  }
  const totals = { sig_l: 0, sig_a: 0, td_l: 0, td_a: 0, kd: 0, ctrl_sec: 0 };
  let rounds = 0;
  for (const h of hist) for (const r of world.statsByBout.get(h.bout_id) || []) {
    if (r.fighter_id !== fid) continue;
    rounds += 1; totals.sig_l += r.sig_str_landed || 0; totals.sig_a += r.sig_str_att || 0; totals.td_l += r.td_landed || 0; totals.td_a += r.td_att || 0; totals.kd += r.kd || 0; totals.ctrl_sec += r.ctrl_sec || 0;
  }
  const careerRaw = {
    slpm: numOrNull(f.career_slpm), str_acc: pctPrinted(f.career_str_acc), sapm: numOrNull(f.career_sapm), str_def: pctPrinted(f.career_str_def),
    td_avg: numOrNull(f.career_td_avg), td_acc: pctPrinted(f.career_td_acc), td_def: pctPrinted(f.career_td_def), sub_avg: numOrNull(f.career_sub_avg),
  };
  const career = Object.values(careerRaw).some((v) => v != null) ? careerRaw : null;
  return {
    fighter_id: f.id, name: f.name, nickname: f.nickname || null, slug: fighterSlug(f),
    record: f.record_w == null ? null : { w: f.record_w, l: f.record_l ?? 0, d: f.record_d ?? 0, nc: f.record_nc ?? 0 },
    age: ageOn(f.dob, onDate), height_in: numOrNull(f.height_in, 1), reach_in: numOrNull(f.reach_in, 1), stance: f.stance || null, weight_lbs: numOrNull(f.weight_lbs, 1),
    career,
    archive: {
      fights: hist.length, w, l, d, nc, ko, sub, dec, finishes: ko + sub, finished_by: finishedBy, r1_finishes: r1,
      finish_rate: w ? Math.round(((ko + sub) / w) * 100) : null, rounds_with_stats: rounds,
      totals: rounds ? { ...totals, ctrl: mmss(totals.ctrl_sec), sig_per_round: Math.round((totals.sig_l / rounds) * 10) / 10, sig_pct: totals.sig_a ? Math.round((totals.sig_l / totals.sig_a) * 100) : null } : null,
      last: hist.slice(0, 5).map((h) => ({ date: h.date, opponent: h.opponent, opponent_slug: h.opponent_slug, result: h.result, method: h.method, round: h.round, event: h.event })),
      days_since_last: hist[0] ? daysBetween(hist[0].date, onDate) : null,
    },
  };
}

const recStr = (f) => (f && f.record ? `${f.record.w}-${f.record.l}-${f.record.d}${f.record.nc ? ` (${f.record.nc} NC)` : ''}` : null);
function surnameOf(f) { const toks = String(f.name).trim().split(/\s+/); return toks[toks.length - 1]; }
function pronouns(isWomens) { return isWomens ? { he: 'she', his: 'her', him: 'her', He: 'She' } : { he: 'he', his: 'his', him: 'him', He: 'He' }; }
function stanceWord(s) { return s ? s.toLowerCase().replace('_', ' ') : null; }
function inchesWord(n) { const v = Math.abs(n); return `${v} ${v === 1 ? 'inch' : 'inches'}`; }
function plural(n, s, p = `${s}s`) { return `${n} ${n === 1 ? s : p}`; }
function joinWithAnd(parts) { const p = parts.filter(Boolean); if (p.length <= 1) return p.join(''); return `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`; }
function methodMix(ar) { return joinWithAnd([ar.ko ? `${ar.ko} by KO/TKO` : null, ar.sub ? `${ar.sub} by submission` : null]); }
function roundsWord(n) { return n === 5 ? 'five' : n === 3 ? 'three' : String(n); }
function finishedIn(f) { return f.archive.finished_by ? `finished ${once(f.archive.finished_by)} in ${plural(f.archive.fights, 'archived bout')}` : `never finished in ${plural(f.archive.fights, 'archived bout')}`; }
function once(n) { return n === 1 ? 'once' : n === 2 ? 'twice' : plural(n, 'time'); }
function methodLabel(m) { return METHOD_LABEL[m] || String(m || '').toLowerCase(); }

function heroFor(world, fighterIds) {
  for (const fid of fighterIds) {
    const im = world.imageByFighter.get(fid);
    if (im) return { hero_image_ref: im.id, hero_credit: { author: im.author, license: im.license, source_url: im.source_url } };
  }
  return { hero_image_ref: null, hero_credit: null };
}

function eventFacts(e) {
  return { id: e.id, name: e.name, short_name: eventShortName(e.name), event_date: e.event_date, venue: e.venue || null, city: e.city || null, region: e.region || null, country: e.country || null, slug: eventSlug(e) };
}
function venueLine(ev) {
  const place = [ev.venue, ev.city].filter(Boolean).join(' in ');
  if (place) return place;
  return ev.country ? `a venue in ${ev.country} still to be listed` : 'a venue still to be listed';
}
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
  if (bt.position_label === 'title fight') return bt.is_main ? 'the title fight that closes the show' : 'the title fight';
  if (bt.position_label === 'main event') return 'the main event';
  if (bt.position_label === 'co-main event') return 'the co-main event';
  if (bt.card_position === 'main') return 'on the main card';
  if (bt.card_position === 'early') return 'on the early prelims';
  if (bt.card_position === 'prelim') return 'on the prelims';
  return 'on the card';
}
function storyClassFor(bout, cardBouts) {
  const top = cardBouts[0] && cardBouts[0].id === bout.id;
  if (bout.is_title || top) return 'main_event_preview';
  if (bout.card_position === 'main') return 'main_card_preview';
  if (bout.card_position === 'prelim' || bout.card_position === 'early') return 'prelim_preview';
  return cardBouts.findIndex((b) => b.id === bout.id) < 5 ? 'main_card_preview' : 'prelim_preview';
}

/* --------------------------------------------------------------- edges */

/* Material differences only (thresholds in docs/news_pipeline.md). `favors`
 * names the side the number favours; deltas are absolute. */
function computeEdges(a, b) {
  const edges = [];
  const add = (key, va, vb, { unit, higherBetter = true, min = 0, digits = 1, note }) => {
    if (va == null || vb == null) return;
    const delta = Math.round(Math.abs(va - vb) * 10 ** digits) / 10 ** digits;
    if (delta < min || delta === 0) return;
    const favors = higherBetter ? (va > vb ? 'a' : 'b') : (va > vb ? 'b' : 'a');
    const winner = favors === 'a' ? a : b; const other = favors === 'a' ? b : a;
    edges.push({ key, favors, delta, unit, note: note(winner, other, delta) });
  };
  add('reach', a.reach_in, b.reach_in, { unit: 'in', min: 2, note: (w, o, d) => `${w.name} holds ${inchesWord(d)} of reach on ${o.name} (${w.reach_in}" to ${o.reach_in}").` });
  add('height', a.height_in, b.height_in, { unit: 'in', min: 2, note: (w, o, d) => `${w.name} is listed ${inchesWord(d)} taller than ${o.name}.` });
  add('age', a.age, b.age, { unit: 'yr', higherBetter: false, min: 5, digits: 0, note: (w, o, d) => `${w.name} is the younger by ${plural(d, 'year')} (${w.age} to ${o.age}).` });
  add('slpm', a.career && a.career.slpm, b.career && b.career.slpm, { unit: 'per_min', min: 1, digits: 2, note: (w, o, d) => `${w.name} lands ${d} more significant strikes per minute (${w.career.slpm} to ${o.career.slpm}).` });
  add('sapm', a.career && a.career.sapm, b.career && b.career.sapm, { unit: 'per_min', higherBetter: false, min: 1, digits: 2, note: (w, o, d) => `${w.name} absorbs ${d} fewer significant strikes per minute (${w.career.sapm} to ${o.career.sapm}).` });
  add('str_def', a.career && a.career.str_def, b.career && b.career.str_def, { unit: 'pct', min: 8, digits: 0, note: (w, o, d) => `${w.name}'s striking defence is ${d} points higher (${w.career.str_def}% to ${o.career.str_def}%).` });
  add('td_avg', a.career && a.career.td_avg, b.career && b.career.td_avg, { unit: 'per_15', min: 1, digits: 2, note: (w, o, d) => `${w.name} averages ${d} more takedowns per 15 minutes (${w.career.td_avg} to ${o.career.td_avg}).` });
  add('td_def', a.career && a.career.td_def, b.career && b.career.td_def, { unit: 'pct', min: 10, digits: 0, note: (w, o, d) => `${w.name} defends takedowns at ${w.career.td_def}% against ${o.career.td_def}% for ${o.name}.` });
  if (a.archive.w >= 3 && b.archive.w >= 3) {
    add('finish_rate', a.archive.finish_rate, b.archive.finish_rate, { unit: 'pct', min: 25, digits: 0, note: (w, o) => `${w.name} has finished ${w.archive.finishes} of ${w.archive.w} archived wins (${w.archive.finish_rate}%) against ${o.archive.finishes} of ${o.archive.w} (${o.archive.finish_rate}%) for ${o.name}.` });
  }
  add('archive_fights', a.archive.fights, b.archive.fights, { unit: 'fights', min: 3, digits: 0, note: (w, o) => `${w.name} has ${w.archive.fights} archived UFC bouts to ${o.archive.fights} for ${o.name}: the deeper sample is on ${surnameOf(w)}'s side.` });
  return edges;
}
const edgeOf = (edges, key) => edges.find((e) => e.key === key) || null;
const sideOf = (m, e) => (e ? (e.favors === 'a' ? m.a : m.b) : null);
const otherOf = (m, e) => (e ? (e.favors === 'a' ? m.b : m.a) : null);

/* Takedown mismatch: one side's takedown rate against the other's defence. */
function tdMismatch(a, b) {
  const test = (x, y) => (x.career && y.career && x.career.td_avg != null && y.career.td_def != null && x.career.td_avg >= 1.5 && y.career.td_def <= 65 ? { attacker: x, defender: y } : null);
  return test(a, b) || test(b, a);
}
function finishSignal(f) { return f.archive.w >= 3 && f.archive.finish_rate >= 60; }
function distanceSignal(f) { return f.archive.w >= 3 && f.archive.finish_rate <= 34; }
const MARKET_LABEL = { moneyline: 'moneyline', fight_goes_distance: 'fight goes the distance', total_rounds: 'total rounds', method_of_victory: 'method of victory', round_betting: 'round betting', significant_strikes: 'significant strikes', takedowns: 'takedowns' };
const marketLabel = (k) => MARKET_LABEL[k] || k.replace(/_/g, ' ');

/* --------------------------------------------------------- bettor angle */

/* Impact score rules (analysis, not fact; see docs/news_pipeline.md):
 *   start 1; +1 title fight or main event; +1 five scheduled rounds;
 *   +1 material mismatch (reach >= 3in, or SLpM gap >= 1.5, or TD avg >= 1.5 vs TD def <= 65%);
 *   +1 finish-rate signal (either fighter >= 60% on >= 3 archived wins);
 *   -1 thin sample (either fighter < 3 archived bouts and no career averages);
 *   cap 3 when neither fighter has UFC Stats averages, cap 4 when only one has; clamp 1..5. */
function previewAngle(fb) {
  const m = fb.matchup; const { a, b, edges } = m; const bt = fb.bout;
  const rules = [];
  let score = 1;
  if (bt.is_title) { score += 1; rules.push('+1 title fight'); } else if (bt.is_main) { score += 1; rules.push('+1 main event'); }
  if (bt.scheduled_rounds === 5) { score += 1; rules.push('+1 five rounds'); }
  const reach = edgeOf(edges, 'reach'); const pace = edgeOf(edges, 'slpm'); const td = tdMismatch(a, b);
  const mismatch = (reach && reach.delta >= 3) || (pace && pace.delta >= 1.5) || Boolean(td);
  if (mismatch) { score += 1; rules.push('+1 material mismatch'); }
  const finishers = [a, b].filter(finishSignal);
  if (finishers.length) { score += 1; rules.push('+1 finish-rate signal'); }
  const thin = [a, b].filter((f) => f.archive.fights < 3 && !f.career);
  if (thin.length) { score -= 1; rules.push('-1 thin sample'); }
  const both = Boolean(a.career && b.career); const any = Boolean(a.career || b.career);
  if (!any) { score = Math.min(score, 3); rules.push('cap 3: no career averages'); } else if (!both) { score = Math.min(score, 4); rules.push('cap 4: one-sided career averages'); }
  score = Math.max(1, Math.min(5, score));

  /* Markets only when logically connected to the evidence. */
  const markets = new Set();
  if (bt.scheduled_rounds === 5) markets.add('total_rounds');
  const finishEvidence = finishers.length > 0 || [a, b].some((f) => f.archive.finished_by >= 2);
  if (finishEvidence) { markets.add('fight_goes_distance'); markets.add('method_of_victory'); }
  if ([a, b].every(distanceSignal)) markets.add('fight_goes_distance');
  if (td) markets.add('takedowns');
  const bothSlpm = a.career && b.career && a.career.slpm != null && b.career.slpm != null;
  if ((pace && pace.delta >= 1.5) || (bothSlpm && a.career.slpm >= 4.5 && b.career.slpm >= 4.5) || (reach && reach.delta >= 3 && any)) markets.add('significant_strikes');
  if ([a, b].some((f) => f.archive.r1_finishes >= 2)) markets.add('round_betting');
  const directional = edges.filter((e) => ['reach', 'slpm', 'sapm', 'str_def', 'td_def', 'finish_rate'].includes(e.key));
  const sideCount = { a: 0, b: 0 };
  for (const e of directional) sideCount[e.favors] += 1;
  if ((sideCount.a >= 2 && sideCount.b === 0) || (sideCount.b >= 2 && sideCount.a === 0)) markets.add('moneyline');

  const supporting = [];
  for (const e of edges.filter((x) => x.key !== 'archive_fights' && x.key !== 'height').slice(0, 4)) supporting.push(e.note);
  for (const f of finishers) if (!supporting.some((s) => s.includes('archived wins'))) supporting.push(`${f.name} has finished ${f.archive.finishes} of ${f.archive.w} archived UFC wins (${f.archive.finish_rate}%).`);
  if (td) supporting.push(`${td.attacker.name} averages ${td.attacker.career.td_avg} takedowns per 15 minutes; ${td.defender.name} defends takedowns at ${td.defender.career.td_def}%.`);
  if (bt.scheduled_rounds === 5) supporting.push(`Scheduled for five rounds${bt.is_title ? ' with the title on the line' : ''}: the bout can run 25 minutes, not 15, which is the runway the total-rounds market prices.`);
  if (!supporting.length) supporting.push(`Listed records: ${a.name} ${recStr(a) || 'n/a'}, ${b.name} ${recStr(b) || 'n/a'}; ${plural(bt.scheduled_rounds || 3, 'scheduled round')} at ${bt.weight_class_label}.`);

  const risks = [];
  for (const f of [a, b]) if (f.archive.fights < 3) risks.push(f.archive.fights ? `${f.name} has only ${plural(f.archive.fights, 'archived UFC bout')} in the PropBetEdge database, so the form read is thin.` : `${f.name} has no completed UFC bout in the PropBetEdge archive, so nothing here rests on ${surnameOf(f)}'s fight-level history.`);
  const noCareer = [a, b].filter((f) => !f.career);
  if (noCareer.length) risks.push(`UFC Stats striking and grappling averages are not on file for ${joinWithAnd(noCareer.map((f) => f.name))}, so pace, defence and takedown rates cannot be compared${noCareer.length === 1 ? ' both ways' : ''}.`);
  for (const f of [a, b]) if (f.career && (f.career.td_avg == null || f.career.td_def == null)) risks.push(`Grappling metrics are incomplete for ${f.name}; any takedown read is one-sided.`);
  if ([a, b].some((f) => f.reach_in == null)) risks.push(`Reach is not listed for ${joinWithAnd([a, b].filter((f) => f.reach_in == null).map((f) => f.name))}, so the range read is missing a number.`);
  if (bt.short_notice_days != null) risks.push(`Our tables have this booking at ${plural(bt.short_notice_days, "day's notice", "days' notice")}; a short camp adds variance the numbers do not show.`);
  for (const f of [a, b]) if (f.archive.days_since_last != null && f.archive.days_since_last >= 365) risks.push(`${f.name} will have been out ${plural(f.archive.days_since_last, 'day')} by fight night on our archive dates: a long layoff the averages cannot price.`);
  if (both) risks.push('Career averages are career-to-date snapshots at capture; they include fights outside this matchup context and are not as-of figures.');
  risks.push('No odds snapshot or model price exists in PropBetEdge data for this bout, so the angle is unpriced: it says what to look for, not where value sits.');

  const watch = ['Weigh-in: a missed weight or catchweight rebooking changes the physical read above.'];
  watch.push(bt.scheduled_rounds === 5 ? 'Confirm the bout stays scheduled for five rounds; a move to three compresses the total-rounds market.' : 'Confirm card position and scheduled rounds on fight week.');
  if (markets.has('fight_goes_distance')) watch.push('Line movement once priced: a fight-goes-distance line that drifts against the finish-rate read is the first signal to re-examine.');
  else if (markets.has('takedowns')) watch.push('Line movement once priced: takedown and control props are where the grappling mismatch would first show.');
  else watch.push('Line movement once priced: with no market connected yet, the opener itself is the first data point to compare against this read.');

  const orderedMarkets = MARKETS.filter((k) => markets.has(k));
  const watchMarkets = orderedMarkets.filter((k) => k !== 'moneyline').slice(0, 3);
  return {
    angle: {
      impact_score: score, markets: orderedMarkets, summary: previewSummary(fb, { reach, pace, td, finishers, orderedMarkets, both, any }),
      supporting_facts: supporting, risks, watch_items: watch, odds_status: 'unavailable', model_status: 'unavailable', rules_applied: rules,
    },
    market_watch: { status: 'unavailable', markets: watchMarkets.length ? watchMarkets : ['fight_goes_distance', 'total_rounds'], note: ODDS_NOTE },
  };
}

function previewSummary(fb, { reach, pace, td, finishers, orderedMarkets, both, any }) {
  const m = fb.matchup; const { a, b } = m; const bt = fb.bout;
  const s = [];
  if (reach && reach.delta >= 3 && pace && pace.favors === reach.favors) {
    const w = sideOf(m, reach); const o = otherOf(m, reach);
    s.push(`${w.name} brings both the length (${inchesWord(reach.delta)} of reach) and the higher output (${w.career.slpm} to ${o.career.slpm} significant strikes per minute), the combination that most often turns a reach edge into round control.`);
  } else if (td) {
    s.push(`${td.attacker.name}'s takedown rate (${td.attacker.career.td_avg} per 15 minutes) meets a ${td.defender.career.td_def}% takedown defence, which makes ${td.defender.name}'s ability to stay upright the variable the rest of the fight hangs on.`);
  } else if (reach && reach.delta >= 3) {
    const w = sideOf(m, reach);
    s.push(`The measurable edge on file is ${w.name}'s ${inchesWord(reach.delta)} of reach; without UFC Stats pace figures for ${both ? 'this pairing' : 'both fighters'} it is a range advantage, not yet a proven output advantage.`);
  } else if (finishers.length === 2) {
    s.push(`Both fighters finish: ${a.name} ${a.archive.finishes} of ${a.archive.w} archived wins, ${b.name} ${b.archive.finishes} of ${b.archive.w}. The archive points at a fight less likely to hear the final bell than the typical bout at ${bt.weight_class_label}.`);
  } else if (finishers.length === 1) {
    const f = finishers[0]; const o = f === a ? b : a;
    s.push(`${f.name}'s finishing rate (${f.archive.finishes} of ${f.archive.w} archived wins) is the number that shapes this matchup; ${o.name} has been ${finishedIn(o)}.`);
  } else if (!any && (a.archive.fights < 3 || b.archive.fights < 3)) {
    s.push('The verified fact block is thin here: no UFC Stats averages for either fighter and a short archive, so no edge is claimed.');
  } else {
    s.push('The tape and archive do not separate these two by a material margin; the honest read is an open matchup rather than a mismatch.');
  }
  if (bt.scheduled_rounds === 5) s.push(`Five scheduled rounds ${orderedMarkets.includes('fight_goes_distance') ? 'give the finishing pattern more time to matter and ' : ''}put the total-rounds market in play in a way a three-round bout does not.`);
  if (orderedMarkets.length) s.push(`Markets logically connected to that evidence: ${orderedMarkets.map(marketLabel).join(', ')}.`);
  else s.push('No market is singled out because the evidence does not connect to one; watch the opener rather than act on this read.');
  s.push('No price or model output exists yet, so this is a read on what to monitor, not a pick.');
  return s.join(' ');
}

/* ----------------------------------------------------------- preview FB */

function previewFactBlock(world, bout, e, cardBouts) {
  const a = fighterFacts(world, bout.fighter_a_id, e.event_date);
  const b = fighterFacts(world, bout.fighter_b_id, e.event_date);
  if (!a || !b) return null;
  const families = ['espn'];
  if (a.career || b.career || a.archive.rounds_with_stats || b.archive.rounds_with_stats) families.push('ufcstats');
  const fb = {
    version: FACT_VERSION, story_class: storyClassFor(bout, cardBouts), generated_at: new Date().toISOString(),
    sources: { families, news_item_ids: [] },
    generated_from: ['ufc_events', 'ufc_bouts', 'ufc_bout_results', 'ufc_bout_round_stats', 'ufc_fighters'],
    event: eventFacts(e),
    bout: {
      id: bout.id, weight_class: bout.weight_class, weight_class_label: weightClassLabel(bout), is_womens: Boolean(bout.is_womens), is_title: Boolean(bout.is_title),
      scheduled_rounds: bout.scheduled_rounds, card_position: bout.card_position, bout_order: bout.bout_order,
      position_label: positionLabel(bout, cardBouts), is_main: Boolean(cardBouts[0] && cardBouts[0].id === bout.id), status: bout.status,
      short_notice_days: bout.short_notice_days, card_size: cardBouts.length, matchup_slug: matchupSlug({ name: a.name }, { name: b.name }, e),
    },
    matchup: { a, b, edges: computeEdges(a, b) },
  };
  const { angle, market_watch } = previewAngle(fb);
  fb.bettor_angle = angle;
  fb.market_watch = market_watch;
  fb.depth = previewDepth(fb);
  return fb;
}

/* Depth is data-led: the story class keeps its target range and `short` is
 * set (with the reason) when the block cannot support the full range. */
function previewDepth(fb) {
  const { a, b } = fb.matchup; const reasons = [];
  const noCareer = [a, b].filter((f) => !f.career);
  if (noCareer.length) reasons.push(`no UFC Stats career averages for ${joinWithAnd(noCareer.map((f) => f.name))}`);
  const thin = [a, b].filter((f) => f.archive.fights < 3);
  if (thin.length) reasons.push(`archive shorter than 3 bouts for ${joinWithAnd(thin.map((f) => f.name))}`);
  if ([a, b].some((f) => f.reach_in == null)) reasons.push('reach not listed');
  return { class: fb.story_class, target: DEPTH[fb.story_class], short: reasons.length > 0, short_reason: reasons.join('; ') || null };
}

/* -------------------------------------------------------- preview prose */

/* Evidence-led headline when a real edge exists; plain matchup headline otherwise. */
function previewHeadline(fb) {
  const m = fb.matchup; const { a, b, edges } = m; const bt = fb.bout;
  const names = `${a.name} vs. ${b.name}`;
  const reach = edgeOf(edges, 'reach'); const pace = edgeOf(edges, 'slpm'); const td = tdMismatch(a, b);
  if (reach && reach.delta >= 3 && pace && pace.favors === reach.favors) return `${names}: the reach and pace mismatch bettors should watch`;
  if (td) return `Why ${td.defender.name}'s takedown defence is the key variable against ${td.attacker.name}`;
  if (reach && reach.delta >= 4) return `${names}: the ${reach.delta}-inch reach edge that frames the ${bt.weight_class_label} ${bt.position_label}`;
  const finishers = [a, b].filter(finishSignal);
  if (finishers.length === 2) return `${names}: two finishers and a fight-goes-distance question`;
  if (finishers.length === 1) { const f = finishers[0]; const o = f === a ? b : a; return `${f.name}'s finishing rate is the number that matters against ${o.name}`; }
  if (bt.scheduled_rounds === 5 && bt.is_main && a.archive.fights >= 3 && b.archive.fights >= 3) return `Five rounds change the betting equation for ${names}`;
  return `${names}: ${bt.weight_class_label} ${bt.position_label} preview at ${fb.event.short_name}`;
}

/* The dek states the analytical question the article answers. */
function previewDek(fb, slug) {
  const m = fb.matchup; const { a, b, edges } = m; const bt = fb.bout; const ev = fb.event;
  const reach = edgeOf(edges, 'reach'); const td = tdMismatch(a, b); const finishers = [a, b].filter(finishSignal);
  const when = shortDate(ev.event_date);
  if (td) return `Can ${td.defender.name} keep the fight standing against ${td.attacker.name}'s ${td.attacker.career.td_avg} takedowns per 15 minutes? What the tape, the archive and UFC Stats say ahead of ${ev.short_name} on ${when}, and which markets the answer touches.`;
  if (reach && reach.delta >= 3) { const w = sideOf(m, reach); const o = otherOf(m, reach); return `Does ${w.name}'s ${inchesWord(reach.delta)} of reach decide the range against ${o.name}? Tale of the tape, recent form and the markets connected to the answer at ${ev.short_name} on ${when}.`; }
  if (finishers.length) return `Does the finishing pattern in our archive make this a fight that ends early? Tale of the tape, form and the distance question for ${a.name} vs. ${b.name} at ${ev.short_name} on ${when}.`;
  return pick(slug, [
    `Does either side bring a measurable edge into ${bt.weight_class_label} ${positionPhrase(bt).replace(/^on /, 'on ')} at ${ev.short_name} on ${when}? What our tape, archive and UFC Stats tables can and cannot say.`,
    `${a.name} (${recStr(a) || 'record n/a'}) meets ${b.name} (${recStr(b) || 'record n/a'}) at ${ev.short_name} on ${when}. The question this preview works through: where is the edge, and what data is missing?`,
  ], 'dek');
}

function tapeList(fb) {
  const { a, b } = fb.matchup;
  const row = (label, va, vb) => `- **${label}:** ${a.name} ${va} · ${b.name} ${vb}`;
  const inch = (n) => (n == null ? 'n/a' : `${n}"`);
  const rows = [
    row('Record', recStr(a) || 'n/a', recStr(b) || 'n/a'),
    row('Age', a.age ?? 'n/a', b.age ?? 'n/a'),
    row('Height', a.height_in != null ? heightString(a.height_in) : 'n/a', b.height_in != null ? heightString(b.height_in) : 'n/a'),
    row('Reach', inch(a.reach_in), inch(b.reach_in)),
    row('Stance', a.stance ? titleCase(stanceWord(a.stance)) : 'n/a', b.stance ? titleCase(stanceWord(b.stance)) : 'n/a'),
  ];
  if (a.weight_lbs != null || b.weight_lbs != null) rows.push(row('Listed weight', a.weight_lbs != null ? `${a.weight_lbs} lbs` : 'n/a', b.weight_lbs != null ? `${b.weight_lbs} lbs` : 'n/a'));
  return rows.join('\n');
}

function setupSection(fb, slug) {
  const { a, b, edges } = fb.matchup; const ev = fb.event; const bt = fb.bout;
  const posPhrase = positionPhrase(bt);
  const posAs = posPhrase.startsWith('on ') ? posPhrase : `as ${posPhrase}`;
  const roundsBit = bt.scheduled_rounds ? `, scheduled for ${roundsWord(bt.scheduled_rounds)} rounds` : '';
  const recA = recStr(a) || 'record n/a'; const recB = recStr(b) || 'record n/a';
  const p1 = pick(slug, [
    `${ev.name} lands on ${formatDate(ev.event_date)} at ${venueLine(ev)}, and ${posPhrase.startsWith('on ') ? `${posPhrase} sits` : `${posPhrase} is`} ${a.name} (${recA}) against ${b.name} (${recB}) at ${bt.weight_class_label}${roundsBit}.`,
    `${a.name} (${recA}) and ${b.name} (${recB}) meet at ${bt.weight_class_label} ${posAs} when ${ev.short_name} arrives at ${venueLine(ev)} on ${formatDate(ev.event_date)}${roundsBit}.`,
    `On ${formatDate(ev.event_date)}, ${ev.short_name} brings ${a.name} (${recA}) and ${b.name} (${recB}) together at ${bt.weight_class_label} ${posAs} at ${venueLine(ev)}${roundsBit}.`,
  ], 'intro');
  const featured = ['main event', 'co-main event', 'title fight'].includes(bt.position_label);
  const segment = bt.card_position === 'early' ? 'early prelims' : bt.card_position === 'prelim' ? 'prelims' : 'main card';
  const bits = [];
  bits.push(pick(slug, [
    `Our schedule tables list ${plural(bt.card_size, 'bout')} on the card${bt.card_position && !featured ? `; this one is filed under the ${segment}` : ''}.`,
    `The card carries ${plural(bt.card_size, 'bout')} in our tables${bt.card_position && !featured ? `, with this pairing on the ${segment}` : ''}.`,
  ], 'card'));
  if (bt.is_title) bits.push(`The ${bt.weight_class_label} title is on the line, which is why the bout is scheduled for five rounds.`);
  else if (bt.scheduled_rounds === 5) bits.push('Five scheduled rounds is the format detail that matters most for the markets: it doubles the time a finish can arrive in and changes what a total-rounds line means.');
  if (bt.short_notice_days != null) bits.push(`Our tables have the booking at ${plural(bt.short_notice_days, "day's notice", "days' notice")}, a short-notice state that is part of every read below.`);
  bits.push(`The bout is listed as ${bt.status} in the PropBetEdge schedule.`);
  const p2 = bits.join(' ');

  /* What this preview examines, framed by the evidence actually on file. */
  const reach = edgeOf(edges, 'reach'); const td = tdMismatch(a, b); const finishers = [a, b].filter(finishSignal);
  const careerNote = a.career && b.career ? 'UFC Stats career averages are on file for both fighters' : a.career || b.career ? `UFC Stats career averages are on file for ${(a.career ? a : b).name} only` : 'UFC Stats career averages are on file for neither fighter';
  let p3;
  if (td) p3 = `The question this preview works through is whether ${td.defender.name} can keep the fight where ${td.defender.career.td_def}% takedown defence says it will struggle to stay, against a ${td.attacker.career.td_avg}-takedowns-per-15 opponent. ${careerNote}, so that comparison is two-sided.`;
  else if (reach && reach.delta >= 3) { const w = sideOf(fb.matchup, reach); const o = otherOf(fb.matchup, reach); p3 = `The question this preview works through is whether ${w.name}'s ${inchesWord(reach.delta)} of reach translates into control of range against ${o.name}, or whether the archive says ${surnameOf(o)} closes distance regardless. ${careerNote}, which sets the limit on how far that read can go.`; }
  else if (finishers.length) p3 = `The question this preview works through is whether the finishing pattern in our archive makes this a fight that ends early, and what that does to the distance and method markets. ${careerNote}.`;
  else p3 = `The question this preview works through is simple: does either side bring a measurable edge, or is this a matchup the data leaves open? ${careerNote}, and the archive holds ${plural(a.archive.fights, 'completed UFC bout')} for ${a.name} and ${plural(b.archive.fights, 'completed UFC bout')} for ${b.name}.`;
  return [p1, p2, p3].join('\n\n');
}

function tapeSection(fb, slug) {
  const m = fb.matchup; const { a, b, edges } = m; const p = pronouns(fb.bout.is_womens);
  const s = [];
  const reach = edgeOf(edges, 'reach'); const height = edgeOf(edges, 'height'); const age = edgeOf(edges, 'age');
  if (reach) {
    const w = sideOf(m, reach); const o = otherOf(m, reach);
    s.push(pick(slug, [
      `Range is the first thing the tape flags: ${w.name} holds ${inchesWord(reach.delta)} of reach (${w.reach_in}" to ${o.reach_in}"), which sets the distance ${o.name} has to cross to land.`,
      `The ${reach.delta}-inch reach gap in ${w.name}'s favour (${w.reach_in}" to ${o.reach_in}") is the tape's headline number; it defines the range each ${fb.bout.is_womens ? 'woman' : 'man'} is working from.`,
    ], 'tape-reach'));
    if (w.career && o.career && w.career.slpm != null && o.career.slpm != null) {
      if (w.career.slpm > o.career.slpm) s.push(`A reach edge of that size matters more when the longer fighter also sets the pace, and here ${surnameOf(w)} does: ${w.career.slpm} significant strikes landed per minute against ${o.career.slpm} for ${surnameOf(o)}. Length with output behind it is how rounds get banked from the outside.`);
      else s.push(`A reach edge matters most when the longer fighter also sets the pace, and here the numbers cut the other way: ${o.name} out-lands ${surnameOf(w)} ${o.career.slpm} to ${w.career.slpm} per minute, so the shorter fighter is the busier one and has to cross the gap to do it. That is a different fight from a long fighter picking apart a passive one.`);
    } else {
      s.push(reach.delta >= 3
        ? `A gap that size usually matters, but how much depends on pace and defence, and ${w.career || o.career ? `UFC Stats averages are on file for only ${(w.career ? w : o).name}` : 'neither fighter has a UFC Stats striking profile on file'}. Treat the reach number as a starting point rather than a thesis.`
        : `A gap under three inches is modest: enough to notice at kicking range, not enough on its own to change how the fight is fought.`);
    }
  } else if (a.reach_in != null && b.reach_in != null) {
    s.push(`Reach is close to even (${a.reach_in}" to ${b.reach_in}"), so neither fighter starts with a length edge and the striking exchanges begin from the same distance.`);
  } else {
    const missing = [a, b].filter((f) => f.reach_in == null);
    s.push(`Reach is not listed for ${missing.length === 2 ? 'either fighter' : missing[0].name}, so the tape cannot say who has the length${height ? `; height is the physical number that separates them, with ${sideOf(m, height).name} listed ${inchesWord(height.delta)} taller` : ''}.`);
  }
  if (height && reach && height.favors !== reach.favors) s.push(`${sideOf(m, height).name} is the taller by ${inchesWord(height.delta)} while giving up reach, an unusual combination that tends to favour the longer-armed fighter at distance and the taller one in the clinch.`);
  if (age) s.push(`${sideOf(m, age).name} is the younger by ${plural(age.delta, 'year')} (${sideOf(m, age).age} to ${otherOf(m, age).age}). Age on its own tells you little at this level; it reads better alongside the layoff figures in the form section.`);
  if (a.stance && b.stance) {
    const pair = new Set([a.stance, b.stance]);
    if (a.stance === b.stance) s.push(`Both fight ${stanceWord(a.stance)}, so lead hands mirror and the rear-hand exchanges are conventional.`);
    else if (pair.has('ORTHODOX') && pair.has('SOUTHPAW')) s.push(`It is an ${stanceWord(a.stance)}-versus-${stanceWord(b.stance)} pairing: lead legs line up on the outside, which rewards the rear straight and the rear kick and makes the calf-kick battle a live one.`);
    else if (pair.has('SWITCH')) { const sw = a.stance === 'SWITCH' ? a : b; s.push(`${sw.name} is listed as a switch-stance fighter, so ${p.his} lead side can change through the fight and the opponent's setups have to work in both directions.`); }
    else s.push(`${a.name} is listed ${stanceWord(a.stance)}, ${surnameOf(b)} ${stanceWord(b.stance)}.`);
  }
  if (a.weight_lbs != null && b.weight_lbs != null && Math.abs(a.weight_lbs - b.weight_lbs) >= 5) {
    const heavier = a.weight_lbs > b.weight_lbs ? a : b; const lighter = heavier === a ? b : a;
    s.push(`Listed weights differ: ${heavier.name} at ${heavier.weight_lbs} lbs to ${lighter.weight_lbs} for ${lighter.name}. Listed weight is a roster figure, not a weigh-in, so it is a note rather than an edge.`);
  }
  return s.join(' ');
}

function formSection(fb, slug) {
  const m = fb.matchup; const { a, b } = m; const p = pronouns(fb.bout.is_womens);
  const paras = [];
  const lastLine = (f) => f.archive.last.map((h) => `- **${h.result}** vs ${h.opponent} — ${methodLabel(h.method)}${h.round ? `, R${h.round}` : ''} (${shortDate(h.date)}, ${h.event})`).join('\n');
  for (const f of [a, b]) {
    const ar = f.archive; const n = ar.fights;
    if (!n) {
      paras.push(pick(slug, [
        `The PropBetEdge archive holds no completed UFC bout for ${f.name} yet, so ${p.his} ${recStr(f) || 'listed'} record stands on its own here; fight-by-fight detail is still being loaded.`,
        `${f.name} has no completed UFC bout in the PropBetEdge archive at the time of writing. The ${recStr(f) || 'listed'} record is ${p.his} official line, and ${p.his} fight-by-fight history will fill in as the archive loads.`,
      ], `${f.fighter_id}-none`));
      continue;
    }
    const last = ar.last[0];
    const verb = last.result === 'W' ? `beat ${last.opponent}` : last.result === 'L' ? `lost to ${last.opponent}` : last.result === 'D' ? `drew with ${last.opponent}` : `had a no contest with ${last.opponent}`;
    const how = last.round ? `by ${methodLabel(last.method)} in round ${last.round}` : `by ${methodLabel(last.method)}`;
    const tally = joinWithAnd([plural(ar.w, 'win'), ar.l ? plural(ar.l, 'loss', 'losses') : null, ar.d ? plural(ar.d, 'draw') : null, ar.nc ? plural(ar.nc, 'no contest') : null]);
    let finishNote = '';
    if (ar.w && ar.finishes === 0) finishNote = ar.w === 1 ? 'That win went the distance.' : `None of those wins came inside the distance, a pattern that leans toward the judges.`;
    else if (ar.w && ar.finishes === ar.w) finishNote = ar.w === 1 ? 'That win came inside the distance.' : `Every one of them came inside the distance (${methodMix(ar)}).`;
    else if (ar.w) finishNote = `${ar.finishes} of those wins came inside the distance (${methodMix(ar)}), a ${ar.finish_rate}% finish rate on archived wins.`;
    const lossNote = ar.l ? (ar.finished_by ? ` ${p.He} has been finished ${once(ar.finished_by)} in the archive${ar.finished_by === ar.l ? ', every loss ending early' : ''}.` : ` ${ar.l === 1 ? 'The loss' : 'The losses'} went to the scorecards.`) : '';
    const lead = pick(slug, [
      `${f.name} has ${plural(n, 'completed UFC bout')} in the PropBetEdge archive: ${tally}. ${finishNote}${lossNote}`,
      `Our archive has ${plural(n, 'completed UFC bout')} for ${f.name}, ${tally}. ${finishNote}${lossNote}`,
    ], `${f.fighter_id}-lead`);
    const layoff = ar.days_since_last != null ? (ar.days_since_last >= 365 ? ` That is ${plural(ar.days_since_last, 'day')} before fight night on our dates, a layoff long enough to count as a variable in its own right.` : ar.days_since_last <= 120 ? ` That is ${plural(ar.days_since_last, 'day')} before fight night, a quick turnaround.` : ` That puts ${p.him} ${plural(ar.days_since_last, 'day')} out by fight night.`) : '';
    const recent = pick(slug, [
      `Most recently ${p.he} ${verb} ${how} on ${shortDate(last.date)}.${layoff}`,
      `${p.He} last fought on ${shortDate(last.date)} and ${verb} ${how}.${layoff}`,
    ], `${f.fighter_id}-recent`);
    paras.push(`${lead} ${recent}`.replace(/\s+/g, ' ').trim());
    paras.push(lastLine(f));
  }
  /* Comparative read across the two archives. */
  const comp = [];
  if (a.archive.days_since_last != null && b.archive.days_since_last != null && Math.abs(a.archive.days_since_last - b.archive.days_since_last) >= 120) {
    const busier = a.archive.days_since_last < b.archive.days_since_last ? a : b; const other = busier === a ? b : a;
    comp.push(`${busier.name} is the more recently active of the two (${busier.archive.days_since_last} days out against ${other.archive.days_since_last} for ${surnameOf(other)}).`);
  }
  if (a.archive.w >= 2 && b.archive.w >= 2) {
    const fa = a.archive.finish_rate; const fbr = b.archive.finish_rate;
    if (fa >= 60 && fbr >= 60) comp.push(`Both archives lean toward finishes (${fa}% and ${fbr}% of wins), which is the pattern that feeds a fight-goes-distance read.`);
    else if (fa <= 34 && fbr <= 34) comp.push(`Both archives lean toward decisions (${fa}% and ${fbr}% of wins finished), which points the other way on the distance question.`);
    else if ((fa >= 60) !== (fbr >= 60)) { const hi = fa >= 60 ? a : b; const lo = hi === a ? b : a; comp.push(`${hi.name} ends ${hi.archive.finish_rate}% of archived wins early against ${lo.archive.finish_rate}% for ${lo.name}; with ${lo.name} ${finishedIn(lo)}, that asymmetry is the pattern behind the distance and method markets.`); }
    else if (Math.abs(fa - fbr) >= 25) { const hi = fa > fbr ? a : b; const lo = hi === a ? b : a; comp.push(`The finishing profiles diverge: ${hi.name} ends ${hi.archive.finish_rate}% of archived wins early, ${lo.name} ${lo.archive.finish_rate}%. Combined with ${lo.name} having been ${finishedIn(lo)}, that asymmetry is where a method-of-victory read starts.`); }
  }
  if (comp.length) paras.push(comp.join(' '));
  return paras.join('\n\n');
}

function styleSection(fb, slug) {
  const m = fb.matchup; const { a, b, edges } = m; const p = pronouns(fb.bout.is_womens);
  const paras = [];
  const both = a.career && b.career;
  if (both) {
    const c = a.career; const d = b.career;
    const bits = [];
    if (c.slpm != null && d.slpm != null) {
      const pace = edgeOf(edges, 'slpm');
      bits.push(`${a.name} lands ${c.slpm} significant strikes per minute${c.str_acc != null ? ` at ${c.str_acc}% accuracy` : ''}; ${b.name} lands ${d.slpm}${d.str_acc != null ? ` at ${d.str_acc}%` : ''}.`);
      if (pace) bits.push(`That ${pace.delta}-per-minute gap in ${sideOf(m, pace).name}'s favour is a real pace differential: over three rounds it compounds into a scorecard edge unless the lower-volume fighter is landing the more damaging shots.`);
      else bits.push('The two are close on volume, so neither side can expect to win rounds on activity alone.');
    }
    if (c.sapm != null && d.sapm != null) {
      const sapm = edgeOf(edges, 'sapm'); const def = edgeOf(edges, 'str_def');
      bits.push(`On the other side of the exchange, ${a.name} absorbs ${c.sapm} per minute${c.str_def != null ? ` with ${c.str_def}% striking defence` : ''} and ${b.name} absorbs ${d.sapm}${d.str_def != null ? ` with ${d.str_def}%` : ''}.`);
      if (sapm && def && sapm.favors === def.favors) bits.push(`${sideOf(m, sapm).name} is the harder fighter to hit on both measures, which is the profile that makes an opponent's volume less useful than it looks.`);
      else if (def) bits.push(`${sideOf(m, def).name}'s ${def.delta}-point defence edge is the number to hold against the pace figures: it decides how much of the opponent's output actually lands.`);
    }
    if (bits.length) paras.push(bits.join(' '));
    const g = [];
    if (c.td_avg != null || d.td_avg != null) {
      g.push(`On the ground, ${a.name} averages ${c.td_avg ?? 'n/a'} takedowns per 15 minutes${c.td_acc != null ? ` at ${c.td_acc}% accuracy` : ''}${c.td_def != null ? ` and defends ${c.td_def}% of attempts against ${p.him}` : ''}; ${b.name} averages ${d.td_avg ?? 'n/a'}${d.td_acc != null ? ` at ${d.td_acc}%` : ''}${d.td_def != null ? ` and defends ${d.td_def}%` : ''}.`);
      const td = tdMismatch(a, b);
      if (td) g.push(`That is the mismatch in this fight: ${td.attacker.name}'s takedown rate against a ${td.defender.career.td_def}% defence means ${td.defender.name} should expect to be tested on the fence early, and the takedown and control markets follow directly from whether ${surnameOf(td.defender)} holds.`);
      else if (c.td_avg != null && d.td_avg != null && c.td_avg < 1 && d.td_avg < 1) g.push('Neither fighter wrestles much by the averages, which points to a fight decided on the feet and makes the striking figures above the ones that matter.');
      else if (c.td_def != null && d.td_def != null) { const td_def = edgeOf(edges, 'td_def'); if (td_def) g.push(`${sideOf(m, td_def).name}'s ${td_def.delta}-point takedown-defence edge is the grappling number to weigh: it limits how often the fight leaves the striking exchanges.`); }
    }
    if (c.sub_avg != null && d.sub_avg != null && (c.sub_avg >= 1 || d.sub_avg >= 1)) { const hi = c.sub_avg >= d.sub_avg ? a : b; g.push(`${hi.name} attempts ${hi.career.sub_avg} submissions per 15 minutes, the higher rate of the two, so any ground time carries a finishing threat.`); }
    if (g.length) paras.push(g.join(' '));
    paras.push('All of these are career-to-date UFC Stats snapshots at capture, not as-of figures for this bout: they describe each fighter across every opponent, which is why the archive form above is read alongside them rather than replaced by them.');
  } else if (a.career || b.career) {
    const f = a.career ? a : b; const o = f === a ? b : a; const c = f.career;
    const bits = [];
    if (c.slpm != null) bits.push(`${f.name} lands ${c.slpm} significant strikes per minute${c.str_acc != null ? ` at ${c.str_acc}% accuracy` : ''}${c.sapm != null ? ` and absorbs ${c.sapm}` : ''}${c.str_def != null ? ` with ${c.str_def}% striking defence` : ''}.`);
    if (c.td_avg != null) bits.push(`${p.He} averages ${c.td_avg} takedowns per 15 minutes${c.td_acc != null ? ` at ${c.td_acc}% accuracy` : ''}${c.td_def != null ? ` and defends ${c.td_def}% of takedowns` : ''}${c.sub_avg != null ? `, with ${c.sub_avg} submission attempts per 15` : ''}.`);
    bits.push(`For ${o.name}, our tables carry no UFC Stats averages, so the comparison is one-sided: treat this as a description of what ${surnameOf(f)} brings, not a matchup edge.`);
    if (c.slpm != null) bits.push(c.slpm >= 4.5 ? `A ${c.slpm}-per-minute output is high-volume by any standard, which is the one number here that connects to a market: it is the profile that lifts significant-strike totals whoever the opponent is.` : c.slpm <= 2.5 ? `A ${c.slpm}-per-minute output is low volume, which usually means a fighter who picks moments rather than accumulates, and that shapes what a scorecard fight would look like.` : `A ${c.slpm}-per-minute output is mid-range for the division and does not by itself point at a market.`);
    paras.push(bits.join(' '));
  }
  /* Round-level archive totals, labelled by sample size. */
  const rs = [];
  for (const f of [a, b]) {
    const t = f.archive.totals;
    if (!t) continue;
    rs.push(`Round-level UFC Stats exist for ${plural(f.archive.rounds_with_stats, 'archived round')} of ${f.name}'s: ${t.sig_l} of ${t.sig_a} significant strikes landed${t.sig_pct != null ? ` (${t.sig_pct}%)` : ''}, ${t.sig_per_round} per round, ${t.td_l} of ${t.td_a} takedowns, ${t.ctrl} of control time${t.kd ? ` and ${plural(t.kd, 'knockdown')}` : ''}.`);
  }
  if (rs.length) paras.push(`${rs.join(' ')} ${rs.length === 2 ? 'Those samples are small and uneven, so they colour the career averages rather than override them.' : 'That is a small sample and is offered as colour, not as a rate.'}`);
  /* Method mix as a style proxy when nothing else is on file. */
  if (!a.career && !b.career && !rs.length) {
    const mix = [];
    for (const f of [a, b]) if (f.archive.w >= 2) mix.push(`${f.name}'s archived wins split ${joinWithAnd([f.archive.ko ? `${f.archive.ko} by KO/TKO` : null, f.archive.sub ? `${f.archive.sub} by submission` : null, f.archive.dec ? `${f.archive.dec} on the cards` : null])}`);
    if (mix.length) paras.push(`With no UFC Stats averages on file for either fighter, the method mix is the only style signal our tables hold: ${joinWithAnd(mix)}. ${mix.length === 2 ? 'Read together, that is a sketch of where each one wins, not a measure of pace or defence.' : 'That is a sketch of where the wins come from, not a measure of pace or defence.'}`);
  }
  return paras.length ? paras.join('\n\n') : null;
}

function breakSection(fb, slug) {
  const risks = fb.bettor_angle.risks;
  const openers = ['Start with what is missing.', 'The counter-case is mostly about sample.', 'Here is where the read could be wrong.'];
  const body = risks.slice(0, -1).map((r) => r.replace(/\.$/, '')).map((r, i) => (i === 0 ? r : r.charAt(0).toUpperCase() + r.slice(1)));
  const lines = [pick(slug, openers, 'break')];
  if (body.length) lines.push(`${body.join('. ')}.`);
  else lines.push('The fact block is complete on every field this preview uses, which leaves ordinary fight variance as the main source of error.');
  lines.push('There is also no odds snapshot in PropBetEdge data for this bout, so nothing above can be checked against a market yet; the read describes what to look for, not where value sits. A late weigh-in miss, a replacement or a change in scheduled rounds would each invalidate parts of it.');
  return lines.join(' ');
}

function finalRead(fb, slug) {
  const m = fb.matchup; const { a, b, edges } = m; const bt = fb.bout; const angle = fb.bettor_angle;
  const reach = edgeOf(edges, 'reach'); const td = tdMismatch(a, b); const finishers = [a, b].filter(finishSignal);
  let thesis;
  if (td) thesis = `On the data, the fight turns on ${td.defender.name}'s takedown defence against ${td.attacker.name}'s rate: ${td.defender.career.td_def}% against ${td.attacker.career.td_avg} per 15 minutes.`;
  else if (reach && reach.delta >= 3) thesis = `On the data, ${sideOf(m, reach).name}'s ${inchesWord(reach.delta)} of reach is the one material physical edge, and what it is worth depends on pace figures our tables ${a.career && b.career ? 'do hold' : a.career || b.career ? 'only partly hold' : 'do not hold'}.`;
  else if (finishers.length) thesis = `On the data, the finishing pattern is the strongest signal: ${joinWithAnd(finishers.map((f) => `${f.name} ${f.archive.finishes} of ${f.archive.w} archived wins early`))}.`;
  else thesis = 'On the data, neither fighter carries a material edge into this one; the tape is close and the archive does not separate them.';
  const uncertainty = fb.depth.short ? `The uncertainty is mostly about coverage: ${fb.depth.short_reason}.` : 'The uncertainty is ordinary fight variance rather than missing data.';
  const monitor = angle.markets.length ? `What to monitor: the ${plural(bt.scheduled_rounds || 3, 'round').replace(/^5 rounds$/, 'five-round').replace(/^3 rounds$/, 'three-round')} format holding, the weigh-in, and once a price exists, where the ${joinWithAnd(angle.markets.map(marketLabel))} ${angle.markets.length === 1 ? 'market opens' : 'markets open'} relative to this read.` : 'What to monitor: the weigh-in, the scheduled-rounds confirmation, and the opening price once one exists, because no market is singled out here.';
  return `${thesis} ${uncertainty} ${monitor} No model price or market line exists in PropBetEdge data for this bout, so this is not a pick; the Bettor's Edge panel above carries the impact score and the markets connected to the evidence.`;
}

function previewLinks(fb) {
  const { a, b } = fb.matchup; const ev = fb.event;
  return `Matchup page: [${a.name} vs. ${b.name}](/fights/${fb.bout.matchup_slug}) · Full card: [${ev.name}](/events/${ev.slug}) · Fighter pages: [${a.name}](/fighters/${a.slug}), [${b.name}](/fighters/${b.slug}).`;
}

function renderPreview(fb, slug) {
  const sections = ['## The setup', setupSection(fb, slug), '## Tale of the tape', tapeList(fb), tapeSection(fb, slug), '## Recent form', formSection(fb, slug)];
  const style = styleSection(fb, slug);
  if (style) sections.push('## Style and statistical matchup', style);
  sections.push('## What could break the angle', breakSection(fb, slug), '## Final read', finalRead(fb, slug), previewLinks(fb));
  return { headline: previewHeadline(fb), dek: previewDek(fb, slug), body: sections.filter(Boolean).join('\n\n') };
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
      const { a, b } = fb.matchup;
      const slug = `${slugify(a.name)}-vs-${slugify(b.name)}-preview-${e.event_date}`;
      const { headline, dek, body } = renderPreview(fb, slug);
      out.push({
        slug, story_type: 'fight_preview', headline, dek, body_md: body, fact_block: fb, status: 'published', needs_human: false,
        fighter_ids: [a.fighter_id, b.fighter_id], bout_id: bout.id, event_id: e.id, ...heroFor(world, [a.fighter_id, b.fighter_id]),
        extra_sources: [{ kind: 'matchup', slug: fb.bout.matchup_slug }],
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
  const t = { rounds: mine.length, kd: sum('kd'), sig_l: sum('sig_str_landed'), sig_a: sum('sig_str_att'), tot_l: sum('total_str_landed'), tot_a: sum('total_str_att'), td_l: sum('td_landed'), td_a: sum('td_att'), sub: sum('sub_att'), ctrl_sec: sum('ctrl_sec') };
  t.ctrl = mmss(t.ctrl_sec);
  t.sig_pct = t.sig_a ? Math.round((t.sig_l / t.sig_a) * 100) : null;
  return t;
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
    const brief = (f) => ({ fighter_id: f.id, name: f.name, slug: fighterSlug(f), record: recordString(f) });
    const finish = r.method === 'KO_TKO' || r.method === 'SUB';
    rows.push({
      bout_id: b.id, bout_order: b.bout_order, card_position: b.card_position, weight_class: b.weight_class, weight_class_label: weightClassLabel(b), is_title: Boolean(b.is_title), is_womens: Boolean(b.is_womens), scheduled_rounds: b.scheduled_rounds,
      a: brief(fa), b: brief(fbb), winner: winner ? brief(winner) : null, loser: loser ? brief(loser) : null,
      method: r.method, method_label: methodLabel(r.method), method_raw: r.method_raw, round: r.round, time: mmss(r.time_sec), time_sec: r.time_sec,
      finish, elapsed_sec: finish && r.round ? (r.round - 1) * 300 + (r.time_sec || 0) : null,
      finish_detail: r.finish_detail || null, referee: r.referee || null, scorecards: r.scorecards || null, has_stats: Boolean(world.statsByBout.get(b.id)),
    });
  }
  if (!rows.length) return null;
  const main = rows[0];
  const statRows = world.statsByBout.get(main.bout_id) || [];
  const stats = statRows.length ? { a: statTotals(statRows, main.a.fighter_id), b: statTotals(statRows, main.b.fighter_id) } : null;
  const a = fighterFacts(world, main.a.fighter_id, e.event_date);
  const b = fighterFacts(world, main.b.fighter_id, e.event_date);
  const finishes = rows.filter((r) => r.finish);
  const fastest = finishes.filter((r) => r.elapsed_sec != null).sort((x, y) => x.elapsed_sec - y.elapsed_sec)[0] || null;
  const totals = {
    bouts: rows.length, finishes: finishes.length, ko_tko: rows.filter((r) => r.method === 'KO_TKO').length, subs: rows.filter((r) => r.method === 'SUB').length,
    decisions: rows.filter((r) => r.method.startsWith('DEC')).length, split_decisions: rows.filter((r) => r.method === 'DEC_S').length,
    r1_finishes: finishes.filter((r) => r.round === 1).length, title_fights: rows.filter((r) => r.is_title).length, with_stats: rows.filter((r) => r.has_stats).length,
  };
  const fb = {
    version: FACT_VERSION, story_class: 'results', generated_at: new Date().toISOString(),
    sources: { families: statRows.length || (a && a.career) || (b && b.career) ? ['espn', 'ufcstats'] : ['espn'], news_item_ids: [] },
    generated_from: ['ufc_events', 'ufc_bouts', 'ufc_bout_results', 'ufc_bout_round_stats', 'ufc_fighters'],
    event: eventFacts(e),
    bout: {
      id: main.bout_id, weight_class: main.weight_class, weight_class_label: main.weight_class_label, is_womens: main.is_womens, is_title: main.is_title, scheduled_rounds: main.scheduled_rounds,
      card_position: main.card_position, bout_order: main.bout_order, position_label: main.is_title ? 'title fight' : 'main event', is_main: true,
      matchup_slug: matchupSlug({ name: main.a.name }, { name: main.b.name }, e),
    },
    matchup: a && b ? { a, b, edges: computeEdges(a, b) } : null,
    results: { bouts: rows, main: { ...main, stats }, co_main: rows[1] || null, fastest_finish: fastest ? { winner: fastest.winner, loser: fastest.loser, round: fastest.round, time: fastest.time, weight_class_label: fastest.weight_class_label } : null, totals },
  };
  fb.results.post_mortem = postMortem(fb);
  const { angle, market_watch } = resultsAngle(fb);
  fb.bettor_angle = angle;
  fb.market_watch = market_watch;
  const reasons = [];
  if (!stats) reasons.push('no round stats for the main event');
  if (rows.length < 6) reasons.push(`only ${plural(rows.length, 'bout')} with results`);
  if (!a || !b || a.archive.fights < 2 || b.archive.fights < 2) reasons.push('pre-fight archive shorter than 2 bouts for a main-event fighter');
  fb.depth = { class: 'results', target: DEPTH.results, short: reasons.length > 0, short_reason: reasons.join('; ') || null };
  return fb;
}

/* Facts the post-mortem prose is allowed to use: pre-fight profile of both
 * main-event fighters (archive as of the event date), the differentials from
 * round stats, and the archive pattern after the result. */
function postMortem(fb) {
  const m = fb.results.main; const mu = fb.matchup;
  if (!mu) return null;
  const winner = m.winner ? (m.winner.fighter_id === mu.a.fighter_id ? mu.a : mu.b) : null;
  const loser = winner ? (winner === mu.a ? mu.b : mu.a) : null;
  const pre = (f) => (f ? { name: f.name, fights: f.archive.fights, w: f.archive.w, l: f.archive.l, finishes: f.archive.finishes, finish_rate: f.archive.finish_rate, finished_by: f.archive.finished_by, days_since_last: f.archive.days_since_last, last_results: f.archive.last.map((x) => x.result) } : null);
  const streak = (f) => { let n = 0; for (const x of f.archive.last) { if (x.result === f.archive.last[0].result) n += 1; else break; } return { result: f.archive.last[0] ? f.archive.last[0].result : null, n }; };
  const out = {
    went_distance: !m.finish && m.method.startsWith('DEC'), method: m.method, round: m.round, scheduled_rounds: m.scheduled_rounds,
    winner: winner ? { ...pre(winner), streak_before: streak(winner), archive_after: { fights: winner.archive.fights + 1, w: winner.archive.w + 1, finishes: winner.archive.finishes + (m.finish ? 1 : 0) } } : null,
    loser: loser ? { ...pre(loser), streak_before: streak(loser), archive_after: { fights: loser.archive.fights + 1, l: loser.archive.l + 1, finished_by: loser.archive.finished_by + (m.finish ? 1 : 0) } } : null,
    differentials: null,
    expectation: null,
  };
  if (m.stats && m.stats.a && m.stats.b && winner) {
    const W = winner === mu.a ? m.stats.a : m.stats.b; const L = winner === mu.a ? m.stats.b : m.stats.a;
    out.differentials = { sig: W.sig_l - L.sig_l, td: W.td_l - L.td_l, ctrl_sec: W.ctrl_sec - L.ctrl_sec, kd: W.kd - L.kd, winner_sig_pct: W.sig_pct, loser_sig_pct: L.sig_pct };
  }
  if (winner && winner.archive.w >= 3) {
    out.expectation = m.finish
      ? (winner.archive.finish_rate >= 60 ? 'finish_in_line' : 'finish_against_pattern')
      : (winner.archive.finish_rate >= 60 ? 'decision_against_pattern' : 'decision_in_line');
  }
  return out;
}

/* Impact score rules for results (post-mortem): start 2; +1 title fight;
 * +1 five scheduled rounds; +1 finish inside two rounds; +1 large round-stat differential (sig strikes
 * >= 40, control >= 4:00 or knockdowns >= 2); -1 no round stats; clamp 1..5. */
function resultsAngle(fb) {
  const m = fb.results.main; const pm = fb.results.post_mortem; const t = fb.results.totals;
  const rules = []; let score = 2;
  if (m.is_title) { score += 1; rules.push('+1 title fight'); }
  if (m.scheduled_rounds === 5) { score += 1; rules.push('+1 five rounds'); }
  if (m.finish && m.round && m.round <= 2) { score += 1; rules.push('+1 early finish'); }
  const d = pm && pm.differentials;
  if (d && (Math.abs(d.sig) >= 40 || Math.abs(d.ctrl_sec) >= 240 || Math.abs(d.kd) >= 2)) { score += 1; rules.push('+1 large stat differential'); }
  if (!m.stats) { score -= 1; rules.push('-1 no round stats'); }
  score = Math.max(1, Math.min(5, score));

  const markets = new Set();
  const preFinishers = [pm && pm.winner, pm && pm.loser].filter((x) => x && x.w >= 3 && x.finish_rate >= 60);
  if (m.finish || preFinishers.length) { markets.add('method_of_victory'); markets.add('fight_goes_distance'); }
  if (m.scheduled_rounds === 5) markets.add('total_rounds');
  if (m.stats && m.stats.a && m.stats.b && (Math.abs(m.stats.a.sig_l - m.stats.b.sig_l) >= 40 || m.stats.a.sig_l >= 100 || m.stats.b.sig_l >= 100)) markets.add('significant_strikes');
  if (m.stats && m.stats.a && m.stats.b && Math.max(m.stats.a.td_l, m.stats.b.td_l) >= 3) markets.add('takedowns');
  if (m.finish && m.round === 1) markets.add('round_betting');
  const orderedMarkets = MARKETS.filter((k) => markets.has(k));

  const supporting = [];
  if (m.winner) supporting.push(`${m.winner.name} ${methodPast(m.method)} ${m.loser.name}${m.round ? ` in round ${m.round}` : ''}${m.time && m.finish ? ` at ${m.time}` : ''} (${m.method_label}).`);
  else supporting.push(`${m.a.name} vs ${m.b.name} was recorded as a ${m.method_label}.`);
  if (m.stats && m.stats.a && m.stats.b) supporting.push(`Significant strikes ${m.a.name} ${m.stats.a.sig_l}/${m.stats.a.sig_a}, ${m.b.name} ${m.stats.b.sig_l}/${m.stats.b.sig_a}; takedowns ${m.stats.a.td_l}/${m.stats.a.td_a} to ${m.stats.b.td_l}/${m.stats.b.td_a}; control ${m.stats.a.ctrl} to ${m.stats.b.ctrl} over ${plural(m.stats.a.rounds, 'round')} of UFC Stats data.`);
  if (pm && pm.winner && pm.winner.w) supporting.push(`Coming in, ${pm.winner.name} had finished ${pm.winner.finishes} of ${pm.winner.w} archived wins${pm.winner.finish_rate != null ? ` (${pm.winner.finish_rate}%)` : ''}; ${pm.loser.name} had been finished ${once(pm.loser.finished_by)} in ${plural(pm.loser.fights, 'archived bout')}.`);
  supporting.push(`Card: ${t.finishes} of ${t.bouts} recorded bouts ended inside the distance (${t.ko_tko} KO/TKO, ${t.subs} submission${t.subs === 1 ? '' : 's'}), ${t.decisions} went to the judges.`);

  const risks = ['No pre-fight odds snapshot exists in PropBetEdge data, so nothing here is a claim about closing-line value, a bad beat or a mispriced market; it is a read on what the result did to each profile.'];
  if (!m.stats) risks.push('UFC Stats round data for the main event is not in our tables yet, so the striking, takedown and control differentials are not available.');
  if (pm && pm.winner && pm.winner.fights < 3) risks.push(pm.winner.fights ? `${pm.winner.name}'s pre-fight archive held only ${plural(pm.winner.fights, 'bout')}, so the "pattern" this result confirms or breaks is thin.` : `${pm.winner.name} had no archived UFC bout before this, so there was no pattern for the result to confirm or break.`);
  if (pm && pm.loser && pm.loser.fights < 3) risks.push(pm.loser.fights ? `${pm.loser.name}'s pre-fight archive held only ${plural(pm.loser.fights, 'bout')}.` : `${pm.loser.name} had no archived UFC bout before this.`);
  risks.push('One result is one data point: it updates the archive, it does not by itself change a career average.');

  const watch = ['Next bookings for both main-event fighters as they appear in the schedule tables.', 'Opening line on each fighter\'s next bout once a price is connected, compared against the archive pattern after this result.', 'Rankings snapshot movement for the winner, which changes likely matchmaking more than it changes any single market.'];
  const watchMarkets = orderedMarkets.filter((k) => k !== 'moneyline').slice(0, 3);
  return {
    angle: { impact_score: score, markets: orderedMarkets, summary: resultsSummary(fb, orderedMarkets), supporting_facts: supporting, risks, watch_items: watch, odds_status: 'unavailable', model_status: 'unavailable', rules_applied: rules },
    market_watch: { status: 'unavailable', markets: watchMarkets.length ? watchMarkets : ['fight_goes_distance', 'method_of_victory'], note: ODDS_NOTE },
  };
}

function resultsSummary(fb, orderedMarkets) {
  const m = fb.results.main; const pm = fb.results.post_mortem;
  const s = [];
  if (!m.winner) s.push(`The main event was recorded as a ${m.method_label}, so it changes little in either profile beyond one more archived bout.`);
  else if (pm && pm.expectation === 'finish_in_line') s.push(`${m.winner.name}'s ${m.method_label} of ${m.loser.name} is in line with a pre-fight archive that already read ${pm.winner.finishes} finishes in ${pm.winner.w} wins: the finishing profile is confirmed rather than changed.`);
  else if (pm && pm.expectation === 'finish_against_pattern') s.push(`${m.winner.name} finished ${m.loser.name} despite an archive that had ${pm.winner.finishes} finishes in ${pm.winner.w} wins coming in, which is the kind of result that should move method-of-victory expectations next time.`);
  else if (pm && pm.expectation === 'decision_against_pattern') s.push(`${m.winner.name} went to the cards against ${m.loser.name} with an archive that had finished ${pm.winner.finishes} of ${pm.winner.w} wins before this; the distance read on ${surnameOf(m.winner)} needs revisiting.`);
  else if (pm && pm.expectation === 'decision_in_line') s.push(`${m.winner.name}'s decision over ${m.loser.name} fits an archive that already leaned toward the judges (${pm.winner.finishes} finishes in ${pm.winner.w} wins).`);
  else s.push(`${m.winner.name} ${methodPast(m.method)} ${m.loser.name}; with ${pm && pm.winner ? plural(pm.winner.w, 'archived win') : 'no archived win'} coming in, the pre-fight archive was too short for this result to confirm or break a pattern.`);
  const d = pm && pm.differentials;
  if (d) s.push(d.sig >= 40 ? `The round stats back the result: a ${d.sig}-strike edge in significant strikes landed for the winner${d.ctrl_sec >= 120 ? ` and ${mmss(d.ctrl_sec)} more control time` : ''}.` : d.sig <= -20 ? `The round stats complicate the result: ${m.loser.name} out-landed the winner by ${Math.abs(d.sig)} significant strikes, which is the kind of split that keeps a rematch market live.` : 'The round stats show a close fight on the numbers rather than a one-sided one.');
  if (orderedMarkets.length) s.push(`Markets to reassess next time either fighter is priced: ${orderedMarkets.map(marketLabel).join(', ')}.`);
  s.push('No pre-fight odds were stored, so this is a profile update, not a grade on the market.');
  return s.join(' ');
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
  const ev = fb.event; const R = fb.results; const m = R.main; const pm = R.post_mortem; const t = R.totals;
  let headline;
  if (m.method === 'DRAW') headline = `${ev.short_name} results: ${m.a.name} and ${m.b.name} fight to a draw`;
  else if (m.method === 'NC' || !m.winner) headline = `${ev.short_name} results: ${m.a.name} vs ${m.b.name} ruled a no contest`;
  else if (m.finish && m.round) headline = `${ev.short_name} results: ${m.winner.name} ${methodVerb(m.method)} ${m.loser.name} in round ${m.round}`;
  else headline = `${ev.short_name} results: ${m.winner.name} ${methodVerb(m.method)} ${m.loser.name}`;
  if (pm && pm.expectation === 'finish_against_pattern' && m.finish) headline = `${ev.short_name} results: ${m.winner.name} finishes ${m.loser.name}, and the archive did not see it coming`;
  else if (pm && pm.differentials && pm.differentials.sig <= -20 && m.winner) headline = `${ev.short_name} results: ${m.winner.name} ${methodVerb(m.method)} ${m.loser.name} while losing the strike count`;

  const where = venueLine(ev); const when = formatDate(ev.event_date);
  const isDec = m.method.startsWith('DEC');
  const timeBit = m.round ? `${m.time ? `at ${m.time} of ` : 'in '}round ${m.round}` : '';
  let mainPara;
  if (m.winner) {
    const open = pick(slug, [
      `${m.winner.name} ${methodPast(m.method)} ${m.loser.name} in the ${m.weight_class_label} ${m.is_title ? 'title fight' : 'main event'} at ${where} on ${when}.`,
      `The ${m.weight_class_label} ${m.is_title ? 'title fight' : 'main event'} at ${where} went to ${m.winner.name}, who ${methodPast(m.method)} ${m.loser.name} on ${when}.`,
    ], 'main-open');
    let how;
    if (isDec) { const sc = scorecardText(m.scorecards); how = sc ? `The judges returned ${sc}.` : `It went the full ${m.scheduled_rounds || m.round || ''} rounds and was scored a ${m.method_label}.`.replace(/\s+rounds/, ' rounds'); }
    else if (m.finish) how = `The finish came ${timeBit}${m.finish_detail ? ` (${m.finish_detail})` : ''}${m.referee ? `, with ${m.referee} the referee` : ''}.`;
    else how = `The result was recorded as ${m.method_raw}${timeBit ? ` ${timeBit}` : ''}${m.referee ? `; ${m.referee} refereed` : ''}.`;
    const recs = `${m.winner.name} is listed at ${m.winner.record || 'an unlisted record'} in our tables; ${m.loser.name} at ${m.loser.record || 'an unlisted record'}.`;
    mainPara = `${open} ${how} ${recs}`;
  } else {
    mainPara = `${m.a.name} and ${m.b.name} met in the ${m.weight_class_label} ${m.is_title ? 'title fight' : 'main event'} at ${where} on ${when}; the bout was recorded as a ${m.method_label}${timeBit ? ` ${timeBit}` : ''}${m.referee ? ` under referee ${m.referee}` : ''}.`;
  }
  const preContext = [];
  if (pm && pm.winner && pm.loser) {
    const w = pm.winner; const l = pm.loser;
    preContext.push(`Coming in, ${w.name} had ${w.fights ? plural(w.fights, 'archived UFC bout') : 'no archived UFC bout'} in the PropBetEdge database${w.w ? ` (${w.w}-${w.l}, ${plural(w.finishes, 'finish', 'finishes')}${w.finish_rate != null ? `, a ${w.finish_rate}% finish rate on wins` : ''})` : ''}${w.streak_before.n >= 2 ? `, arriving on a run of ${w.streak_before.n} straight ${w.streak_before.result === 'W' ? 'wins' : 'losses'}` : ''}${w.days_since_last != null ? ` and ${plural(w.days_since_last, 'day')} since ${pronouns(m.is_womens).his} last fight` : ''}.`);
    preContext.push(`${l.name} had ${l.fights ? plural(l.fights, 'archived bout') : 'no archived bout'}${l.fights ? ` (${l.w}-${l.l}, finished ${once(l.finished_by)})` : ''}${l.streak_before.n >= 2 ? `, on ${plural(l.streak_before.n, 'straight ' + (l.streak_before.result === 'W' ? 'win' : 'loss'), 'straight ' + (l.streak_before.result === 'W' ? 'wins' : 'losses'))}` : ''}${l.days_since_last != null ? `, ${plural(l.days_since_last, 'day')} out` : ''}.`);
  }

  const cardSummary = pick(slug, [
    `Across the ${plural(t.bouts, 'bout')} with results in our tables, ${t.finishes} ended inside the distance (${t.ko_tko} by KO/TKO, ${t.subs} by submission) and ${t.decisions} went to the judges${t.split_decisions ? `, ${t.split_decisions} of them split` : ''}.`,
    `The card produced ${plural(t.finishes, 'finish', 'finishes')} in ${plural(t.bouts, 'recorded bout')}: ${t.ko_tko} KO/TKO, ${plural(t.subs, 'submission')}, ${plural(t.decisions, 'decision')}${t.split_decisions ? ` (${t.split_decisions} split)` : ''}.`,
  ], 'card-summary');
  const notes = [];
  if (R.co_main && R.co_main.winner) notes.push(`In the co-main event, ${R.co_main.winner.name} ${methodPast(R.co_main.method)} ${R.co_main.loser.name}${R.co_main.round && R.co_main.finish ? ` in round ${R.co_main.round}` : ''} at ${R.co_main.weight_class_label}.`);
  if (R.fastest_finish && R.fastest_finish.winner) notes.push(`The quickest finish on the card was ${R.fastest_finish.winner.name}'s ${R.fastest_finish.weight_class_label} win over ${R.fastest_finish.loser.name} at ${R.fastest_finish.time} of round ${R.fastest_finish.round}.`);
  if (t.r1_finishes) notes.push(`${plural(t.r1_finishes, 'bout')} ended in the first round.`);
  if (t.with_stats) notes.push(`UFC Stats round data is in our tables for ${t.with_stats} of the ${t.bouts} bouts.`);

  const sections = ['## Main event', mainPara];
  if (preContext.length) sections.push(preContext.join(' '));
  const mu = fb.matchup;
  if (mu) {
    const tape = mu.edges.filter((e) => ['reach', 'height', 'age', 'archive_fights'].includes(e.key)).map((e) => e.note.replace(/\.$/, ''));
    const tapeLine = tape.length ? `On the pre-fight tape: ${tape.join('; ')}.` : `On the pre-fight tape, the two were level on every listed measure our tables hold${mu.a.reach_in != null && mu.b.reach_in != null ? ` (reach ${mu.a.reach_in}" to ${mu.b.reach_in}")` : ''}.`;
    const cov = mu.a.career && mu.b.career ? 'UFC Stats career averages were on file for both fighters.' : mu.a.career || mu.b.career ? `UFC Stats career averages were on file for ${(mu.a.career ? mu.a : mu.b).name} only.` : 'UFC Stats career averages were on file for neither fighter, so striking and grappling rates could not be compared going in.';
    sections.push(`${tapeLine} ${cov}`);
    for (const f of [mu.a, mu.b]) {
      if (!f.archive.last.length) continue;
      sections.push(`**${f.name}, last ${Math.min(3, f.archive.last.length)} before this bout**\n\n${f.archive.last.slice(0, 3).map((h) => `- **${h.result}** vs ${h.opponent} — ${methodLabel(h.method)}${h.round ? `, R${h.round}` : ''} (${shortDate(h.date)})`).join('\n')}`);
    }
  }
  sections.push('## Full results', R.bouts.map(resultLine).join('\n'), cardSummary);
  if (notes.length) sections.push(notes.join(' '));
  if (m.stats && m.stats.a && m.stats.b) {
    const A = m.stats.a; const B = m.stats.b;
    const pct = (v) => (v == null ? 'n/a' : `${v}%`);
    sections.push('## By the numbers');
    sections.push(`Over ${plural(A.rounds, 'round')} of UFC Stats data, ${m.a.name} landed ${A.sig_l} of ${A.sig_a} significant strikes (${pct(A.sig_pct)}) against ${B.sig_l} of ${B.sig_a} (${pct(B.sig_pct)}) for ${m.b.name}. Takedowns went ${A.td_l} of ${A.td_a} for ${m.a.name} and ${B.td_l} of ${B.td_a} for ${m.b.name}; control time was ${A.ctrl} to ${B.ctrl}${A.kd || B.kd ? `, with knockdowns ${A.kd}-${B.kd}` : ''}.`);
    sections.push([
      `- **Significant strikes:** ${m.a.name} ${A.sig_l}/${A.sig_a} · ${m.b.name} ${B.sig_l}/${B.sig_a}`,
      `- **Total strikes:** ${m.a.name} ${A.tot_l}/${A.tot_a} · ${m.b.name} ${B.tot_l}/${B.tot_a}`,
      `- **Takedowns:** ${m.a.name} ${A.td_l}/${A.td_a} · ${m.b.name} ${B.td_l}/${B.td_a}`,
      `- **Control time:** ${m.a.name} ${A.ctrl} · ${m.b.name} ${B.ctrl}`,
      `- **Knockdowns:** ${m.a.name} ${A.kd} · ${m.b.name} ${B.kd}`,
      `- **Submission attempts:** ${m.a.name} ${A.sub} · ${m.b.name} ${B.sub}`,
    ].join('\n'));
  }
  sections.push('## What the fight changed', postMortemProse(fb, slug));
  sections.push(`Full card, bout pages and fighter archives: [${ev.name}](/events/${ev.slug}). Main-event matchup page: [${m.a.name} vs. ${m.b.name}](/fights/${fb.bout.matchup_slug}).`);
  const dek = m.winner
    ? `${m.winner.name} ${methodPast(m.method)} ${m.loser.name}${m.round && m.finish ? ` in round ${m.round}` : ''} to close ${ev.short_name} at ${where}. Every result from the card, what the main event confirmed or broke in each fighter's pre-fight profile, and which markets to reassess next time.`
    : `${m.a.name} vs ${m.b.name} ended in a ${m.method_label} at ${ev.short_name}. Every result from the card, with main-event numbers where our round stats exist and what the outcome changes.`;
  return { headline, dek, body: sections.join('\n\n') };
}

function postMortemProse(fb, slug) {
  const m = fb.results.main; const pm = fb.results.post_mortem; const angle = fb.bettor_angle; const p = pronouns(m.is_womens);
  if (!pm || !pm.winner) return `The main event was recorded as a ${m.method_label}, which adds one archived bout to each profile and changes nothing else our tables can measure. No pre-fight odds were stored, so there is no market grade to give.`;
  const w = pm.winner; const l = pm.loser;
  const paras = [];
  /* 1. Validated or challenged. */
  let p1;
  if (pm.expectation === 'finish_in_line') p1 = `${w.name} arrived with a finishing profile (${w.finishes} of ${w.w} archived wins) and delivered a ${m.method_label} in round ${m.round}; the result validates the read that ${surnameOf(m.winner)} ends fights rather than accumulates rounds.`;
  else if (pm.expectation === 'finish_against_pattern') p1 = `${w.name} had finished only ${w.finishes} of ${w.w} archived wins coming in, so a ${m.method_label} in round ${m.round} cuts against the pattern our archive showed. One finish does not rewrite a profile, but it is the kind of data point that should widen the method-of-victory range next time ${p.he} is priced.`;
  else if (pm.expectation === 'decision_against_pattern') p1 = `${w.name} had finished ${w.finishes} of ${w.w} archived wins before this and went the distance here${m.scheduled_rounds ? ` over ${plural(m.scheduled_rounds, 'round')}` : ''}. That challenges a fight-goes-distance read built on ${surnameOf(m.winner)} alone; the opponent's durability (${l.name} finished ${plural(l.finished_by, 'time')} in ${plural(l.fights, 'archived bout')} before tonight) is the other half of that equation.`;
  else if (pm.expectation === 'decision_in_line') p1 = `${w.name}'s archive already leaned toward the judges (${w.finishes} finishes in ${w.w} wins), and a ${m.method_label} over ${l.name} keeps it there: the distance read on ${surnameOf(m.winner)} holds.`;
  else p1 = w.fights ? `${w.name}'s pre-fight archive held ${plural(w.fights, 'bout')} with ${plural(w.w, 'win')}, too few wins for this ${m.method_label} to confirm or break a finishing pattern; it is an early data point rather than a verdict.` : `${w.name} had no completed UFC bout in the PropBetEdge archive before this, so the ${m.method_label} is the first data point on file rather than confirmation of a pattern.`;
  paras.push(p1);
  /* 2. Differentials. */
  const d = pm.differentials;
  if (d) {
    const bits = [];
    bits.push(d.sig >= 40 ? `The round stats say the result was earned on volume: ${m.winner.name} out-landed ${m.loser.name} by ${d.sig} significant strikes${d.winner_sig_pct != null ? ` at ${d.winner_sig_pct}% accuracy` : ''}.` : d.sig > 0 ? `The round stats show a ${d.sig}-strike edge in significant strikes for the winner, a margin that describes a competitive fight rather than a dominant one.` : d.sig === 0 ? 'The round stats show the two level on significant strikes landed.' : `The round stats cut the other way on volume: ${m.loser.name} landed ${Math.abs(d.sig)} more significant strikes than the winner, which is worth remembering the next time either fighter is priced on a strike-total prop.`);
    if (d.td !== 0) bits.push(`${d.td > 0 ? m.winner.name : m.loser.name} took ${plural(Math.abs(d.td), 'more takedown')}${d.ctrl_sec !== 0 ? ` and ${d.ctrl_sec > 0 === d.td > 0 ? 'also' : 'yet'} ${d.ctrl_sec > 0 ? m.winner.name : m.loser.name} held ${mmss(Math.abs(d.ctrl_sec))} more control time` : ''}, so the grappling exchanges ${d.td > 0 ? 'ran with' : 'ran against'} the result.`);
    else if (d.ctrl_sec !== 0) bits.push(`Takedowns were level, but ${d.ctrl_sec > 0 ? m.winner.name : m.loser.name} held ${mmss(Math.abs(d.ctrl_sec))} more control time.`);
    if (d.kd !== 0) bits.push(`Knockdowns went ${Math.abs(d.kd)} in ${d.kd > 0 ? 'the winner' : 'the loser'}'s favour${d.kd < 0 ? ', the clearest sign the scorecards and the damage did not agree' : ''}.`);
    paras.push(bits.join(' '));
  } else {
    paras.push('UFC Stats round data for this bout is not yet in our tables, so the striking, takedown and control differentials that would normally sit here are unavailable; the profile update below rests on the result alone.');
  }
  /* 3. Distance and archive pattern. */
  const dist = pm.went_distance
    ? `The fight went the distance${m.scheduled_rounds ? ` over ${plural(m.scheduled_rounds, 'round')}` : ''}, which is the outcome a fight-goes-distance market pays on and the one to hold against both archives next time.`
    : `The fight ended in round ${m.round}${m.scheduled_rounds ? ` of a scheduled ${m.scheduled_rounds}` : ''}, which feeds the method and distance markets directly the next time either fighter is priced.`;
  const arch = `${w.name}'s archive now reads ${plural(w.archive_after.w, 'win')} in ${plural(w.archive_after.fights, 'bout')} with ${plural(w.archive_after.finishes, 'finish', 'finishes')}${w.streak_before.result === 'W' && w.streak_before.n >= 1 ? `, extending a winning run to ${w.streak_before.n + 1}` : w.streak_before.result === 'L' ? `, snapping a run of ${plural(w.streak_before.n, 'loss', 'losses')}` : ''}. ${l.name} drops to ${plural(l.archive_after.l, 'loss', 'losses')} in ${plural(l.archive_after.fights, 'archived bout')}${m.finish ? `, and has now been finished ${once(l.archive_after.finished_by)}` : ''}${l.streak_before.result === 'L' && l.streak_before.n >= 1 ? `; that is ${l.streak_before.n + 1} straight losses` : ''}.`;
  paras.push(`${dist} ${arch}`);
  /* 4. Markets to reassess. */
  const mk = angle.markets.length ? `Markets to reassess when either fighter is next priced: ${joinWithAnd(angle.markets.map(marketLabel))}.` : 'No specific market is singled out for reassessment; the result adds an archived bout without pointing at one.';
  paras.push(`${mk} ${pick(slug, ['No pre-fight odds snapshot was stored, so this post-mortem grades the profiles, not the market: there is no closing-line claim to make.', 'Without a stored pre-fight price, none of this is a claim about value or a bad beat; it is what the result did to each fighter\'s archive and what to carry into the next booking.'], 'pm-close')}`);
  return paras.join('\n\n');
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
    const m = fb.results.main;
    const subjects = [m.winner ? m.winner.fighter_id : null, m.loser ? m.loser.fighter_id : null, m.a.fighter_id, m.b.fighter_id].filter(Boolean);
    out.push({
      slug, story_type: 'results', headline, dek, body_md: body, fact_block: fb, status: 'published', needs_human: false,
      fighter_ids: [...new Set(fb.results.bouts.flatMap((r) => [r.a.fighter_id, r.b.fighter_id]))], bout_id: m.bout_id, event_id: e.id, ...heroFor(world, subjects),
      extra_sources: [{ kind: 'matchup', slug: fb.bout.matchup_slug }],
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
  return { bout_id: b.id, opponent: opp ? opp.name : 'an opponent still to be listed', event: e.name, event_slug: eventSlug(e), date: e.event_date, weight_class_label: weightClassLabel(b), status: b.status };
}

function withArticle(word) { return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`; }

/* Wire items carry a minimal angle: the verified fact is the attributed
 * report plus what our tables hold; no market is claimed until the schedule
 * tables confirm a change. */
function externalAngle(fb) {
  const label = fb.item.labels[0];
  const booked = fb.fighters.filter((f) => f.next_bout);
  const score = ['withdrawal', 'replacement', 'weight_miss', 'bout_moved'].includes(label) && booked.length ? 2 : 1;
  const supporting = [`${fb.item.source} reports "${fb.item.quoted_phrase}" (${label.replace('_', ' ')} item).`];
  for (const f of booked) supporting.push(`${f.name} (${f.record || 'record n/a'}) is booked against ${f.next_bout.opponent} on ${f.next_bout.event}, ${shortDate(f.next_bout.date)}, listed as ${f.next_bout.status} in our schedule.`);
  if (!booked.length) supporting.push(`${joinWithAnd(fb.fighters.map((f) => `${f.name} (${f.record || 'record n/a'})`))} ${fb.fighters.length === 1 ? 'has' : 'have'} no upcoming bout in our schedule tables.`);
  return {
    angle: {
      impact_score: score, markets: [], summary: booked.length ? `An attributed ${label.replace('_', ' ')} report touches a bout in our schedule. Until the schedule tables reflect a change, no market is singled out; if the booking changes, every market on the bout reprices and any preview should be treated as stale.` : `An attributed ${label.replace('_', ' ')} report names ${joinWithAnd(fb.fighters.map((f) => f.name))}, none of whom has a bout in our schedule tables, so there is no market to connect it to yet.`,
      supporting_facts: supporting,
      risks: ['Single attributed source; our tables do not yet confirm the development.', 'No odds snapshot exists in PropBetEdge data, so no market impact can be measured.'],
      watch_items: ['Schedule-table update for the bout named in the report.', 'A replacement booking, which changes the tale of the tape entirely.'],
      odds_status: 'unavailable', model_status: 'unavailable', rules_applied: [`${score === 2 ? '2: booking-affecting label on a scheduled bout' : '1: wire item without a scheduled bout'}`],
    },
    market_watch: { status: 'unavailable', markets: [], note: ODDS_NOTE },
  };
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
      return f ? { fighter_id: f.fighter_id, name: f.name, slug: f.slug, record: recStr(f), next_bout: nextBoutFor(world, fid), last: f.archive.last[0] || null } : null;
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
      version: FACT_VERSION, story_class: 'external', generated_at: new Date().toISOString(),
      sources: { families: ['espn', 'newsroom'], news_item_ids: [it.id] },
      generated_from: ['ufc_news_items', 'ufc_fighters', 'ufc_bouts', 'ufc_events'],
      item: { id: it.id, title: it.title, url: it.url, published_at: it.published_at, source: src ? src.name : 'the source', labels: qualifying, confidence: it.taxonomy.confidence, quoted_phrase: titlePhrase(it.title, 6) },
      fighters, bout, event: event ? eventFacts(event) : null,
    };
    const { angle, market_watch } = externalAngle(fb);
    fb.bettor_angle = angle; fb.market_watch = market_watch;
    fb.depth = { class: 'external', target: DEPTH.external, short: true, short_reason: 'external wire item with limited verified context' };
    const slug = slugify(it.title).slice(0, 80).replace(/-+$/, '');
    if (!slug) continue;
    const review = qualifying.some((l) => l === 'injury' || l === 'withdrawal');
    const { headline, dek, body } = renderExternal(fb, slug);
    out.push({
      slug, story_type: 'external', headline, dek, body_md: body, fact_block: fb, status: review ? 'review' : 'published', needs_human: review,
      fighter_ids: fighters.map((f) => f.fighter_id), bout_id: bout ? bout.id : null, event_id: event ? event.id : null, ...heroFor(world, fighters.map((f) => f.fighter_id)),
      extra_sources: [{ kind: 'news_item', id: it.id, url: it.url }],
    });
    if (out.length >= 6) break;
  }
  return { articles: out };
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
  const lines = [];
  const used = new Set();
  for (const f of fb.fighters) {
    if (used.has(f.fighter_id)) continue;
    const partner = f.next_bout ? fb.fighters.find((g) => g.fighter_id !== f.fighter_id && g.next_bout && g.next_bout.bout_id === f.next_bout.bout_id) : null;
    if (partner) {
      used.add(f.fighter_id); used.add(partner.fighter_id);
      lines.push(`${f.name} (${f.record || 'record n/a'}) and ${partner.name} (${partner.record || 'record n/a'}) are booked against each other at ${f.next_bout.weight_class_label} on the ${f.next_bout.event} card, ${shortDate(f.next_bout.date)}; the bout is listed as ${f.next_bout.status} in our schedule.`);
      continue;
    }
    used.add(f.fighter_id);
    let s = `${f.name} is listed at ${f.record || 'an unlisted record'} in our tables`;
    if (f.next_bout) s += ` and is booked against ${f.next_bout.opponent} at ${f.next_bout.weight_class_label} on the ${f.next_bout.event} card (${shortDate(f.next_bout.date)}, listed as ${f.next_bout.status})`;
    else if (f.last) s += `; ${f.last.result === 'W' ? 'a win over' : f.last.result === 'L' ? 'a loss to' : 'a bout with'} ${f.last.opponent} on ${shortDate(f.last.date)} is the most recent result in our archive`;
    else s += ', with no completed UFC bout in our archive yet';
    lines.push(`${s}.`);
  }
  const boutLine = fb.bout && !fb.fighters.some((f) => f.next_bout && f.next_bout.bout_id === fb.bout.id)
    ? ` The bout the report points at, on our schedule: ${fb.bout.a} vs ${fb.bout.b}, ${fb.bout.weight_class_label}, ${fb.bout.event} on ${shortDate(fb.bout.date)}, currently ${fb.bout.status}.` : '';
  const anyBooking = Boolean(fb.bout) || fb.fighters.some((f) => f.next_bout);
  const close = anyBooking
    ? 'Any change to the booking shows on the event page once our schedule tables update, and a confirmed change would make every market on the bout reprice; until then nothing above beyond the quoted phrase comes from the outside report.'
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
      let replacement = null;
      if (repl) {
        const ra = fighterFacts(world, repl.fighter_a_id, e.event_date); const rb = fighterFacts(world, repl.fighter_b_id, e.event_date);
        const stays = [ra, rb].find((f) => f && (f.fighter_id === a.fighter_id || f.fighter_id === b.fighter_id)) || null;
        const incoming = [ra, rb].find((f) => f && f.fighter_id !== a.fighter_id && f.fighter_id !== b.fighter_id) || null;
        const outgoing = stays ? (stays.fighter_id === a.fighter_id ? b : a) : null;
        replacement = {
          id: repl.id, a: ra, b: rb, weight_class_label: weightClassLabel(repl), status: repl.status, short_notice_days: repl.short_notice_days,
          stays: stays ? stays.name : null, incoming: incoming ? incoming.name : null, outgoing: outgoing ? outgoing.name : null,
          edges_vs_outgoing: incoming && outgoing ? computeEdges(incoming, outgoing) : [],
        };
      }
      const fb = {
        version: FACT_VERSION, story_class: 'card_change', generated_at: new Date().toISOString(), sources: { families: ['espn'], news_item_ids: [] },
        generated_from: ['ufc_events', 'ufc_bouts', 'ufc_bout_results', 'ufc_fighters'], event: eventFacts(e),
        bout: { id: bout.id, status: bout.status, weight_class: bout.weight_class, weight_class_label: weightClassLabel(bout), card_position: bout.card_position, is_title: Boolean(bout.is_title), is_womens: Boolean(bout.is_womens), scheduled_rounds: bout.scheduled_rounds, bout_order: bout.bout_order },
        matchup: { a, b, edges: computeEdges(a, b) }, replacement,
      };
      const supporting = [`${a.name} vs ${b.name} is marked ${bout.status} in the PropBetEdge schedule for ${shortDate(e.event_date)}.`];
      if (replacement) supporting.push(`${replacement.a.name} (${recStr(replacement.a) || 'n/a'}) vs ${replacement.b.name} (${recStr(replacement.b) || 'n/a'}) now holds the slot${replacement.short_notice_days != null ? ` at ${plural(replacement.short_notice_days, "day's notice", "days' notice")}` : ''}.`);
      for (const ed of (replacement ? replacement.edges_vs_outgoing : []).slice(0, 3)) supporting.push(ed.note);
      fb.bettor_angle = {
        impact_score: replacement ? (replacement.short_notice_days != null && replacement.short_notice_days <= 14 ? 3 : 2) : 2, markets: replacement ? ['moneyline'] : [],
        summary: replacement ? `The matchup changed, so every market on the slot reprices from scratch: ${replacement.incoming || 'the incoming fighter'} replaces ${replacement.outgoing || 'the original opponent'} against ${replacement.stays || 'the remaining fighter'}. Any preview written for the original pairing is stale.` : `The bout is off the card with no replacement in our schedule; markets on it are void rather than repriced.`,
        supporting_facts: supporting,
        risks: ['Our tables record the status change, not the reason for it.', 'No odds snapshot exists in PropBetEdge data, so no pre-change and post-change prices can be compared.', ...(replacement && replacement.incoming && !replacement.edges_vs_outgoing.length ? ['No material tale-of-the-tape difference between incoming and outgoing fighter is on file.'] : [])],
        watch_items: ['A rebooked opponent or a further status change in the schedule tables.', 'Weigh-in for any short-notice replacement.'],
        odds_status: 'unavailable', model_status: 'unavailable', rules_applied: [replacement ? (replacement.short_notice_days != null && replacement.short_notice_days <= 14 ? '3: replacement at <= 14 days notice' : '2: replacement booked') : '2: bout off, no replacement'],
      };
      fb.market_watch = { status: 'unavailable', markets: replacement ? ['moneyline'] : [], note: ODDS_NOTE };
      fb.depth = { class: 'card_change', target: DEPTH.card_change, short: true, short_reason: 'status change recorded without a reason; no odds to compare' };
      const slug = `${slugify(a.name)}-vs-${slugify(b.name)}-off-${fb.event.slug}`;
      const headline = replacement && replacement.incoming ? `${replacement.incoming} steps in against ${replacement.stays} at ${fb.event.short_name}: what changed` : `${a.name} vs ${b.name} off ${fb.event.short_name}`;
      const dek = `The ${fb.bout.weight_class_label} bout is marked ${bout.status} in the PropBetEdge schedule for ${shortDate(e.event_date)}${replacement ? `; ${replacement.a.name} vs ${replacement.b.name} now holds the slot. What the replacement changes on the tape.` : '. What that does to the card and the markets on it.'}`;
      const para1 = `${a.name} vs ${b.name}, a ${fb.bout.weight_class_label} bout on ${e.name} (${formatDate(e.event_date)}, ${venueLine(e)}), is marked ${bout.status} in our schedule tables. Our tables record the status change, not the reason for it.`;
      let para2;
      if (replacement) {
        para2 = `The slot now reads ${replacement.a.name} (${recStr(replacement.a) || 'record n/a'}) vs ${replacement.b.name} (${recStr(replacement.b) || 'record n/a'}) at ${replacement.weight_class_label}, status ${replacement.status}${replacement.short_notice_days != null ? `, booked at ${plural(replacement.short_notice_days, "day's notice", "days' notice")}` : ''}.`;
        if (replacement.incoming && replacement.outgoing) {
          const inc = [replacement.a, replacement.b].find((f) => f.name === replacement.incoming);
          const diffs = replacement.edges_vs_outgoing.map((ed) => ed.note);
          para2 += ` Compared with ${replacement.outgoing}, ${replacement.incoming} brings ${plural(inc.archive.fights, 'archived UFC bout')} to our tables${inc.archive.w ? ` (${inc.archive.w}-${inc.archive.l}, ${inc.archive.finishes} finishes)` : ''}${inc.stance ? ` and fights ${stanceWord(inc.stance)}` : ''}.${diffs.length ? ` ${diffs.join(' ')}` : ' No material tale-of-the-tape difference between the two is on file.'} Because the matchup changed, every market on the slot reprices from scratch and any preview written for the original pairing should be read as stale.`;
        }
      } else {
        para2 = 'No replacement bout is on our schedule for the slot at the time of writing, so markets on the original pairing are void rather than repriced.';
      }
      const para3 = `${a.name} is listed at ${recStr(a) || 'an unlisted record'}; ${b.name} at ${recStr(b) || 'an unlisted record'}. The card page updates as the tables do: [${e.name}](/events/${fb.event.slug}).`;
      out.push({
        slug, story_type: 'card_change', headline, dek, body_md: [para1, para2, para3].join('\n\n'), fact_block: fb, status: 'published', needs_human: false,
        fighter_ids: [a.fighter_id, b.fighter_id], bout_id: bout.id, event_id: e.id, ...heroFor(world, [a.fighter_id, b.fighter_id]), extra_sources: [],
      });
    }
  }
  return { articles: out };
}

/* ----------------------------------------------------- editorial gates */

const NUM_RE = /\d+(?:[.,:]\d+)*/g;
function numbersIn(s) { return new Set((String(s).match(NUM_RE) || []).map((n) => n.replace(/,/g, ''))); }
/* Small counts and the two round-length constants prose may use freely; everything else must trace to the block. */
const FREE_NUMBERS = new Set(['0', '1', '2', '3', '4', '5', '15', '25']);

function fightersIn(fb) {
  const out = [];
  if (fb.matchup) out.push(fb.matchup.a, fb.matchup.b);
  if (fb.replacement) out.push(fb.replacement.a, fb.replacement.b);
  return out.filter(Boolean);
}
function allowedNumbers(fb) {
  const set = numbersIn(JSON.stringify(fb));
  for (const f of fightersIn(fb)) if (f.height_in != null) for (const n of numbersIn(heightString(f.height_in))) set.add(n);
  /* Zero-padded date parts ("2026-09-07" -> "07") must match the "7" prose prints. */
  for (const n of [...set]) if (/^0\d+$/.test(n)) set.add(String(Number(n)));
  for (const n of FREE_NUMBERS) set.add(n);
  return set;
}

/* Language that would fabricate a price, a probability, a pick or an injury. */
const BANNED = [
  [/(?:^|[\s(])[-+]\d{3,4}\b/, 'american-odds price'],
  [/\b(favou?rites?|underdogs?|chalk)\b/i, 'favourite/underdog framing'],
  [/\b(lock|locks|guaranteed?|can't miss|free money|sure thing)\b/i, 'certainty language'],
  [/\b(prediction|predictions|predicts?|predicted|our pick|pick:|picks:|will win|should win|our lean|our play)\b/i, 'pick/prediction language'],
  [/\b(implied probability|probabilit(?:y|ies)|percent chance|% chance|chance of winning|parlay|wager|bet on|units?\s+on)\b/i, 'probability/wager language'],
  [/\b(sportsbooks?|bookmakers?|draftkings|fanduel|betmgm|caesars|bet365|pinnacle)\b/i, 'sportsbook availability'],
  [/\bodds\b(?!\s+(?:snapshot|feed|pipeline|data|record|table|exist|were|are|is|do|does|not|or))/i, 'odds claim'],
  [/\b(?:the|a|an|current|opening|closing)\s+line\s+(?:is|was|sits|opened|closed)\s+(?:at\s+)?[-+]?\d/i, 'line quote'],
];
const INJURY_RE = /\b(injur\w*|torn|surgery|fractur\w*|hospitali[sz]ed|concussion|illness|staph|pulled out)\b/i;

/* Returns a list of problems (empty = clean). Used for the template draft and for any LLM rewrite. */
function validateProse(text, fb, { allowInjury = false } = {}) {
  const problems = [];
  const allowed = allowedNumbers(fb);
  const bad = [...numbersIn(text)].filter((n) => !allowed.has(n));
  if (bad.length) problems.push(`numbers not in fact block: ${bad.slice(0, 6).join(', ')}`);
  for (const [re, why] of BANNED) { const m = text.match(re); if (m) problems.push(`${why} ("${m[0].trim()}")`); }
  if (!allowInjury) { const m = text.match(INJURY_RE); if (m) problems.push(`injury claim not in an attributed item ("${m[0]}")`); }
  return problems;
}

function internalLinks(md) {
  const out = [];
  for (const m of md.matchAll(/\]\((\/[^\s)]*|https?:\/\/ufc\.propbetedge\.ai[^\s)]*)\)/g)) out.push(m[1].replace(/^https?:\/\/ufc\.propbetedge\.ai/, ''));
  return out;
}
const STATIC_ROUTES = new Set(['/', '/news', '/events', '/fighters', '/fights', '/rankings', '/about', '/pro', '/login']);
function linkResolves(path, world, batch) {
  const clean = path.split(/[?#]/)[0].replace(/\/$/, '') || '/';
  if (STATIC_ROUTES.has(clean)) return true;
  const m = clean.match(/^\/(events|fighters|fights|news)\/([^/]+)$/);
  if (!m) return false;
  const slug = decodeURIComponent(m[2]);
  if (m[1] === 'events') return world.slugs.events.has(slug);
  if (m[1] === 'fighters') return world.slugs.fighters.has(slug);
  if (m[1] === 'fights') return world.slugs.fights.has(slug);
  return world.slugs.articles.has(slug) || batch.slugs.has(slug);
}
function bodyWords(md) { return wordCount(md.replace(/^#+ .*$/gm, '')); }
function tokenSet(s) { return new Set(normalize(s).split(' ').filter((t) => t.length > 2)); }
function jaccard(a, b) { let inter = 0; for (const t of a) if (b.has(t)) inter += 1; const uni = a.size + b.size - inter; return uni ? inter / uni : 0; }

/* Addendum §11 gates. Returns problems; an empty list means publishable. */
function gateArticle(art, world, batch) {
  const problems = [];
  const fb = art.fact_block; const cls = fb.story_class;
  const words = bodyWords(art.body_md);
  const short = Boolean(fb.depth && fb.depth.short);
  const floor = short ? (SHORT_FLOOR[cls] ?? 0) : (DEPTH[cls] || [0])[0];
  if (words < floor) problems.push(`depth: ${words} words, below the ${short ? 'short-story floor' : 'minimum'} of ${floor} for ${cls}`);
  const ang = fb.bettor_angle;
  if (!ang) problems.push('bettor_angle missing');
  else {
    if (!Number.isInteger(ang.impact_score) || ang.impact_score < 1 || ang.impact_score > 5) problems.push('impact_score outside 1-5');
    if (!Array.isArray(ang.supporting_facts) || !ang.supporting_facts.length) problems.push('bettor_angle has no supporting fact');
    if (!Array.isArray(ang.risks) || !ang.risks.length) problems.push('bettor_angle has no risk');
    if (!Array.isArray(ang.markets) || ang.markets.some((k) => !MARKETS.includes(k))) problems.push('bettor_angle lists an unknown market');
    if (ang.odds_status !== 'unavailable') problems.push('odds_status claims odds without a timestamped odds record');
    if (ang.model_status !== 'unavailable') problems.push('model_status claims a model output without model_version');
  }
  if (!fb.market_watch || fb.market_watch.status !== 'unavailable') problems.push('market_watch claims a price without an odds record');
  const allowInjury = cls === 'external' && (fb.item && fb.item.labels || []).some((l) => l === 'injury' || l === 'withdrawal');
  problems.push(...validateProse(`${art.headline}\n${art.dek || ''}\n${art.body_md}`, fb, { allowInjury }));
  for (const l of internalLinks(art.body_md)) if (!linkResolves(l, world, batch)) problems.push(`internal link does not resolve: ${l}`);
  if (batch.slugs.has(art.slug)) problems.push('duplicate slug within this run');
  const mine = tokenSet(art.headline);
  for (const [slug, toks] of batch.headlines) if (slug !== art.slug && jaccard(mine, toks) >= 0.9) problems.push(`near-duplicate headline of ${slug}`);
  for (const ex of world.articles.values()) if (ex.slug !== art.slug && ex.headline && jaccard(mine, tokenSet(ex.headline)) >= 0.9) problems.push(`near-duplicate headline of existing ${ex.slug}`);
  if (!art.headline || art.headline.length > 140) problems.push('headline missing or over 140 characters');
  return problems;
}

/* Licensed media attribution: a hero without a complete credit is dropped (the site renders its own stat card). */
function enforceHeroCredit(art) {
  if (!art.hero_image_ref) return null;
  const c = art.hero_credit || {};
  if (c.author && c.license && c.source_url) return null;
  art.hero_image_ref = null; art.hero_credit = null;
  return 'hero dropped: licensed credit incomplete';
}

/* ------------------------------------------------------------------ LLM */

const LLM_SYSTEM = `You are the copy editor for PropBetEdge UFC, a bettor-facing fight-intelligence newsroom. You receive a FACT BLOCK (JSON) and a DRAFT article written from it. Rewrite the draft for flow and matchup translation: explain why a number matters for the fight and for the betting markets already named, vary sentence openers, cut repetition.

Rules, all mandatory:
1. State no fact that is not in the fact block. Do not add names, dates, places, injuries, quotes, opponent-quality narratives, odds, prices, sportsbook availability, probabilities, model output, picks or predictions. Never imply a guaranteed edge.
2. Keep every number from the draft exactly as written (records, ages, inches, rounds, times, percentages, dates). Do not introduce any number that is not in the fact block.
3. Keep every Markdown heading line (## ...) and every Markdown list line (- ...) exactly as in the draft, in the same order.
4. Keep every Markdown link exactly as in the draft.
5. Bettor-angle analysis is welcome when it is derived from the fact block; label uncertainty plainly. No "favourite", "underdog", "lock", "pick", "should win" or similar.
6. Short paragraphs, concrete, no hype adjectives, no filler about fans or excitement. Keep the length within 15% of the draft.
7. Output only the rewritten article body in Markdown. No preamble, no commentary.`;

function validateRewrite(draft, out, fb) {
  if (!out || typeof out !== 'string') return 'empty';
  const allowInjury = fb.story_class === 'external' && (fb.item && fb.item.labels || []).some((l) => l === 'injury' || l === 'withdrawal');
  const problems = validateProse(out, fb, { allowInjury });
  if (problems.length) return problems[0];
  const draftNums = numbersIn(draft);
  for (const n of numbersIn(out)) if (!draftNums.has(n) && !FREE_NUMBERS.has(n)) return `number ${n} not in draft`;
  const heads = (t) => t.split('\n').filter((l) => /^(## |- )/.test(l.trim())).map((l) => l.trim());
  if (JSON.stringify(heads(draft)) !== JSON.stringify(heads(out))) return 'headings/list lines changed';
  const links = (t) => (t.match(/\[[^\]]*\]\([^)]*\)/g) || []).sort();
  if (JSON.stringify(links(draft)) !== JSON.stringify(links(out))) return 'links changed';
  const wd = wordCount(draft); const wo = wordCount(out);
  if (wo < wd * 0.85 || wo > wd * 1.15) return `length drifted (${wd} -> ${wo} words)`;
  return null;
}

/* Raw Messages API on purpose: the news scripts are dependency-free (no
 * package.json at the repo root, CI runs them without npm install). Current
 * Sonnet-class id, adaptive thinking, refusal handled. */
async function llmRewrite(apiKey, draft, fb) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: LLM_SYSTEM,
      messages: [{ role: 'user', content: `FACT BLOCK:\n${JSON.stringify(fb, null, 1)}\n\nDRAFT:\n${draft}` }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  if (json.stop_reason === 'refusal') throw new Error(`anthropic: refusal${json.stop_details && json.stop_details.category ? ` (${json.stop_details.category})` : ''}`);
  if (json.stop_reason === 'max_tokens') throw new Error('anthropic: output truncated at max_tokens');
  return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
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

/* ------------------------------------------------------------- persist */

function printArticle(art, tag) {
  console.log(`\n${'='.repeat(78)}\n[${tag}] ${art.story_type} · ${art.fact_block.story_class} · ${art.slug}\n# ${art.headline}\n_${art.dek}_\n\n${art.body_md}\n\n--- bettor_angle ---\n${JSON.stringify(art.fact_block.bettor_angle, null, 2)}\n--- market_watch ---\n${JSON.stringify(art.fact_block.market_watch)}\n${'='.repeat(78)}\n`);
}

async function persist(sb, world, art, env, stats, batch) {
  const heroNote = enforceHeroCredit(art);
  const hash = factHash(art.fact_block, { salt: HASH_SALT });
  const problems = gateArticle(art, world, batch);
  batch.slugs.add(art.slug); batch.headlines.set(art.slug, tokenSet(art.headline));
  const words = bodyWords(art.body_md);
  const cls = art.fact_block.story_class;
  (stats.words[cls] = stats.words[cls] || []).push({ words, short: Boolean(art.fact_block.depth && art.fact_block.depth.short) });
  if (problems.length) {
    art.status = 'review'; art.needs_human = true;
    art.fact_block.review_reason = problems.join('; ');
  }
  const sources = [{ kind: 'fact_block', hash, version: FACT_VERSION }, { kind: 'tables', names: art.fact_block.generated_from }, ...(art.extra_sources || [])];
  const existing = world.articles.get(art.slug);
  const note = `${problems.length ? ` [review: ${problems.join('; ')}]` : ''}${heroNote ? ` [${heroNote}]` : ''}`;
  const depthTag = `${words}w${art.fact_block.depth && art.fact_block.depth.short ? ' short' : ''}`;

  if (existing) {
    const refreshable = art.story_type === 'results' || art.story_type === 'fight_preview';
    const oldHash = (Array.isArray(existing.sources) ? existing.sources : []).find((s) => s && s.kind === 'fact_block');
    if (!refreshable || (!FORCE && oldHash && oldHash.hash === hash)) { stats.unchanged += 1; return; }
    stats.refreshed += 1;
    if (problems.length) stats.review += 1;
    console.log(`  ~ refresh ${art.story_type.padEnd(13)} ${cls.padEnd(19)} ${depthTag.padEnd(11)} ${art.slug}${note}`);
    if (PRINT) printArticle(art, 'refresh');
    if (DRY) return;
    let body = art.body_md; let model = TEMPLATE_VERSION;
    ({ body, model } = await maybeRewrite(env, art, body, model));
    const patch = {
      headline: art.headline, dek: art.dek, body_md: body, fact_block: art.fact_block, sources, model_version: model,
      fighter_ids: art.fighter_ids, bout_id: art.bout_id, event_id: art.event_id, hero_image_ref: art.hero_image_ref, hero_credit: art.hero_credit,
      updated_at: new Date().toISOString(),
    };
    /* Fail closed on a gate failure; otherwise never demote a row an editor holds. A row the
     * gate itself held earlier (fact_block.review_reason set) is released once it passes. */
    if (problems.length) { patch.status = 'review'; patch.needs_human = true; }
    else if (existing.status === 'review' && existing.review_reason) { patch.status = 'published'; patch.needs_human = false; patch.published_at = new Date().toISOString(); }
    await sb.patch('ufc_articles', `id=eq.${existing.id}`, patch);
    return;
  }

  stats.created += 1;
  if (problems.length) stats.review += 1;
  console.log(`  + ${art.story_type.padEnd(13)} ${art.status.padEnd(9)} ${cls.padEnd(19)} ${depthTag.padEnd(11)} ${art.slug}${note}`);
  if (PRINT) printArticle(art, 'create');
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

/* ----------------------------------------------------------------- main */

function wordTable(words) {
  const rows = Object.entries(words).map(([cls, list]) => {
    const ws = list.map((x) => x.words).sort((a, b) => a - b);
    const med = ws.length % 2 ? ws[(ws.length - 1) / 2] : Math.round((ws[ws.length / 2 - 1] + ws[ws.length / 2]) / 2);
    const [lo, hi] = DEPTH[cls] || [0, 0];
    return `  ${cls.padEnd(19)} n=${String(ws.length).padStart(2)}  min=${String(ws[0]).padStart(4)}  median=${String(med).padStart(4)}  max=${String(ws[ws.length - 1]).padStart(4)}  target=${lo}-${hi}  short=${list.filter((x) => x.short).length}`;
  });
  return rows.length ? `\nwords by story_class:\n${rows.join('\n')}` : '';
}

async function main() {
  const env = loadEnv();
  const sb = new Supabase(env);
  const world = await loadWorld(sb);
  /* review_reason lets a refresh tell a gate-held row from an editor-held one. */
  for (const r of await sb.select('ufc_articles', 'select=slug,review_reason:fact_block->>review_reason&status=eq.review')) { const a = world.articles.get(r.slug); if (a) a.review_reason = r.review_reason || null; }
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

  const stats = { created: 0, refreshed: 0, unchanged: 0, review: 0, words: {} };
  const batch = { slugs: new Set(), headlines: new Map() };
  for (const list of batches) {
    const slice = LIMIT ? list.slice(0, LIMIT) : list;
    for (const art of slice) await persist(sb, world, art, env, stats, batch);
  }
  console.log(`\n${DRY ? '[dry-run] ' : ''}created=${stats.created} refreshed=${stats.refreshed} unchanged=${stats.unchanged} held_for_review=${stats.review}${wordTable(stats.words)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
