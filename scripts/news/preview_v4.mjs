#!/usr/bin/env node
/**
 * Editorial V4 no-write preview.
 *
 *   node scripts/news/preview_v4.mjs                       # all six samples
 *   node scripts/news/preview_v4.mjs --only weigh_in_miss
 *   node scripts/news/preview_v4.mjs --json out.json
 *
 * READ-ONLY. It issues GETs, builds packets, composes bodies, runs every gate,
 * and prints the result. It writes no article, touches no production row, and
 * has no --apply.
 *
 * The point of the exercise is the sixth sample. Five of them should come back
 * as real articles. The source-driven one should come back as a WIRE ITEM,
 * because the source supports a sourced update and nothing more, and the system
 * has to prove it will say so rather than inflate it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClass, STORY_DEPTH, isIndexable, CLASS_BUDGET } from './editorial/classes.mjs';
import {
  buildPacket, coreFacts, taleFacts, recentFormFacts, fightDnaFacts,
  marketFacts, availabilityFacts, weighInFacts, resultFacts, sourceItemFacts,
  resetFactIds, taleMetrics, dnaMetrics, marketSummary, roundStatFacts,
} from './editorial/packet.mjs';
import { compose, headlineFor, dekFor } from './editorial/compose.mjs';
import { runAllGates } from './editorial/gates.mjs';
import { classifyStatus, extractClinical, sentencesAbout } from '../status/lib/extract.mjs';
import { resolveLimit, evaluateWeight } from '../weighins/lib/weights.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ONLY = opt('--only', null);
const JSON_OUT = opt('--json', null);

function env() {
  const out = {};
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) out[line.slice(0, i).trim().replace(/^﻿/, '')] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
const E = env();
const URL_ = (E.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = E.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required'); process.exit(2); }

async function q(pathAndQuery) {
  const res = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${pathAndQuery} -> ${res.status}`);
  return res.json();
}

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);

/* ---- link building ------------------------------------------------------ */

function fighterSlug(f) { return `${slugify(f.name)}${f.espn_athlete_id ? `-${f.espn_athlete_id}` : ''}`; }
function eventSlug(e) { return `${slugify(e.name)}-${String(e.event_date).slice(0, 10)}`; }

function linksFor({ fighters = [], event = null, extra = [] }) {
  const out = [];
  for (const f of fighters) out.push({ href: `/fighters/${fighterSlug(f)}`, label: f.name, kind: 'fighter' });
  if (event) out.push({ href: `/events/${eventSlug(event)}`, label: event.name, kind: 'event' });
  out.push(...extra);
  return out;
}

/** Weave links into the body once each, on first mention, never repeated. */
function weaveLinks(body, links) {
  let out = body;
  const done = new Set();
  for (const l of links) {
    if (done.has(l.href)) continue;
    const re = new RegExp(`(?<!\\[)\\b${l.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?!\\]|\\))`);
    if (re.test(out)) { out = out.replace(re, `[${l.label}](${l.href})`); done.add(l.href); }
  }
  return out;
}

/* ---- shared loaders ----------------------------------------------------- */

async function loadWorld() {
  const [events, fighters] = await Promise.all([
    q('ufc_events?select=id,name,event_date,city,region,country&order=event_date.desc&limit=400'),
    q('ufc_fighters?select=id,name,espn_athlete_id,dob,height_in,reach_in,stance,record_w,record_l,record_d,record_nc,career_slpm,career_sapm,career_str_acc,career_str_def,career_td_avg,career_td_acc,career_td_def,career_sub_avg&limit=4000'),
  ]);
  return { events, fighters: new Map(fighters.map((f) => [f.id, f])) };
}

async function boutContext(bout, world, asOf) {
  const ids = [bout.fighter_a_id, bout.fighter_b_id];
  const fighters = ids.map((id) => world.fighters.get(id)).filter(Boolean);
  const event = world.events.find((e) => e.id === bout.event_id);
  const [form, snaps, market] = await Promise.all([
    q(`ufc_fighter_bout_features?select=fighter_id,bout_id,event_date,outcome,method&fighter_id=in.(${ids.join(',')})&order=event_date.desc&limit=60`),
    /* Per fighter, not eight rows across both: ordering by date desc over two
       fighters and taking eight can return eight rows for one of them and none
       for the other, which silently drops a whole Fight DNA section. */
    Promise.all(ids.map((id) => q(`ufc_fighter_dna_snapshots?select=fighter_id,as_of_date,sample_stat_bouts,coverage_status,metrics&fighter_id=eq.${id}&as_of_date=lte.${asOf ?? event?.event_date ?? '2100-01-01'}&order=as_of_date.desc&limit=2`))).then((r) => r.flat()),
    q(`ufc_market_observations?select=bout_id,bookmaker_key,market_key,outcome_fighter_id,price,observed_at&bout_id=eq.${bout.id}&limit=200`),
  ]);
  return { fighters, event, form, snaps, market };
}

/* ---- the six samples ---------------------------------------------------- */

async function samplePreview(kind, world) {
  /* An upcoming, dated, uncancelled bout. Main event = highest bout_order. */
  const upcoming = world.events.filter((e) => e.event_date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.event_date.localeCompare(b.event_date));
  for (const ev of upcoming) {
    const bouts = await q(`ufc_bouts?select=*&event_id=eq.${ev.id}&order=bout_order.desc`);
    if (!bouts.length) continue;
    /* Main event is the top of the card; a main-card preview is any other bout
       carrying a main-card position, falling back to the next one down. */
    const candidates = kind === 'main_event_preview'
      ? [bouts[0]]
      : bouts.slice(1).filter((b) => b.card_position === 'main').concat(bouts.slice(1));
    for (const bout of candidates.filter(Boolean)) {
    const ctx = await boutContext(bout, world, null);
    if (ctx.fighters.length !== 2) continue;

    resetFactIds();
    const packet = buildPacket({
      storyType: kind,
      asOf: null,
      live: true,
      entities: { fighters: ctx.fighters, event: ctx.event, bout },
      parts: [
        coreFacts({ event: ctx.event, bout, fighters: ctx.fighters }),
        taleFacts({ fighters: ctx.fighters, eventDate: ctx.event?.event_date }),
        recentFormFacts({ fighters: ctx.fighters, bouts: ctx.form, asOf: ctx.event?.event_date }),
        fightDnaFacts({ fighters: ctx.fighters, snapshots: ctx.snaps, asOf: ctx.event?.event_date }),
        marketFacts({ observations: ctx.market, fighters: ctx.fighters, asOf: null }),
      ],
      links: linksFor({ fighters: ctx.fighters, event: ctx.event, extra: [{ href: '/learn/fight-dna', label: 'Fight DNA', kind: 'method' }, { href: '/model', label: 'PBE Fight Model', kind: 'method' }] }),
    });
    if (packet.families.length < 3) continue;
    packet.entities = { ...packet.entities, ...marketEntities(ctx) };
    return finish(kind, packet, {
      slug: `${slugify(ctx.fighters[0].name)}-vs-${slugify(ctx.fighters[1].name)}-preview`,
      metrics: taleMetrics({ fighters: ctx.fighters, eventDate: ctx.event?.event_date }),
      dna: dnaMetrics({ fighters: ctx.fighters, snapshots: ctx.snaps, asOf: ctx.event?.event_date }),
    });
    }
  }
  return null;
}

async function sampleResults(world) {
  const past = world.events.filter((e) => e.event_date < new Date().toISOString().slice(0, 10)).sort((a, b) => b.event_date.localeCompare(a.event_date));
  /* Pick the most recent main event that actually went rounds.
   *
   * The first version took the newest card's main event unconditionally and
   * landed on a 71-second knockout, which has one round of statistics and
   * therefore cannot support an article - correctly, but uninformatively. An
   * editor assigning a results piece picks a fight with something to write
   * about, and that is a selection on available material, not on outcome. */
  const candidates = [];
  for (const ev of past.slice(0, 10)) {
    const bouts = await q(`ufc_bouts?select=*&event_id=eq.${ev.id}&order=bout_order.desc&limit=3`);
    for (const b of bouts) {
      const rs = await q(`ufc_bout_round_stats?select=bout_id,round&bout_id=eq.${b.id}`);
      if (rs.length >= 4) candidates.push({ ev, bout: b, rounds: rs.length });
    }
    if (candidates.length >= 3) break;
  }
  candidates.sort((a, b) => b.rounds - a.rounds);
  for (const cand of candidates.length ? candidates : past.slice(0, 10).map((ev) => ({ ev, bout: null }))) {
    const ev = cand.ev;
    const bouts = cand.bout ? [cand.bout] : await q(`ufc_bouts?select=*&event_id=eq.${ev.id}&order=bout_order.desc&limit=1`);
    if (!bouts.length) continue;
    const bout = bouts[0];
    const results = await q(`ufc_bout_results?select=*&bout_id=eq.${bout.id}`);
    if (!results.length) continue;
    const roundRows = await q(`ufc_bout_round_stats?select=*&bout_id=eq.${bout.id}`);
    const asOf = ev.event_date;
    const ctx = await boutContext(bout, world, asOf);
    if (ctx.fighters.length !== 2) continue;

    resetFactIds();
    const packet = buildPacket({
      storyType: 'results',
      asOf,
      entities: { fighters: ctx.fighters, event: ctx.event, bout },
      parts: [
        coreFacts({ event: ctx.event, bout, fighters: ctx.fighters }),
        resultFacts({ result: results[0], bout, fighters: ctx.fighters, referee: results[0].referee, scorecards: results[0].scorecards }),
        roundStatFacts({ rows: roundRows, fighters: ctx.fighters, bout }),
        taleFacts({ fighters: ctx.fighters, eventDate: asOf }),
        recentFormFacts({ fighters: ctx.fighters, bouts: ctx.form.filter((b) => b.event_date < asOf), asOf }),
        fightDnaFacts({ fighters: ctx.fighters, snapshots: ctx.snaps, asOf }),
      ],
      links: linksFor({ fighters: ctx.fighters, event: ctx.event, extra: [{ href: '/learn/fight-dna', label: 'Fight DNA', kind: 'method' }] }),
    });
    if (packet.families.length < 3) continue;
    return finish('results', packet, {
      slug: `${slugify(ev.name)}-result`,
      metrics: taleMetrics({ fighters: ctx.fighters, eventDate: asOf }),
      dna: dnaMetrics({ fighters: ctx.fighters, snapshots: ctx.snaps, asOf }),
    });
  }
  return null;
}

/** Injury / card change, from a real sourced news item. */
async function sampleInjury(world) {
  const items = await q("ufc_news_items?select=id,title,summary,url,published_at,fighter_ids,source_id&order=published_at.desc&limit=120");
  for (const it of items) {
    /* classifyStatus returns an ARRAY of candidate labels ordered by
       confidence, not a single object. Reading .status_type off an array gave
       undefined for every item, so this builder silently found nothing. */
    const kind = classifyStatus(it.title, it.summary || '')[0]?.type;
    if (!['injury', 'withdrawal', 'replacement'].includes(kind)) continue;
    const fids = (it.fighter_ids || []).slice(0, 3);
    const fighters = fids.map((id) => world.fighters.get(id)).filter(Boolean);
    if (!fighters.length) continue;

    const clinical = extractClinical(sentencesAbout(`${it.title}. ${it.summary || ''}`, fighters[0].name).join(' '));
    const statusEvents = [{
      statement: `${fighters[0].name} is reported ${kind === 'injury' ? 'injured' : kind === 'withdrawal' ? 'out of the booking' : 'in as a replacement'}${clinical?.injury_type ? ` with a ${clinical.injury_type}` : ''}, per ${publisherOf(it.url)}.`,
      source_url: it.url, publisher: publisherOf(it.url), published_at: it.published_at,
    }];

    const booking = await q(`ufc_bouts?select=*&or=(fighter_a_id.eq.${fighters[0].id},fighter_b_id.eq.${fighters[0].id})&order=bout_order.desc&limit=1`);
    const bout = booking[0];
    const ctx = bout ? await boutContext(bout, world, null) : { fighters, event: null, form: [], snaps: [], market: [] };

    resetFactIds();
    const packet = buildPacket({
      storyType: 'injury_withdrawal',
      live: true,
      entities: { fighters: ctx.fighters.length ? ctx.fighters : fighters, event: ctx.event, bout },
      parts: [
        sourceItemFacts({ item: { ...it, publisher: publisherOf(it.url) } }),
        availabilityFacts({ statusEvents }),
        bout ? coreFacts({ event: ctx.event, bout, fighters: ctx.fighters }) : [],
        taleFacts({ fighters: ctx.fighters.length ? ctx.fighters : fighters, eventDate: ctx.event?.event_date }),
        recentFormFacts({ fighters: ctx.fighters.length ? ctx.fighters : fighters, bouts: ctx.form, asOf: null }),
        fightDnaFacts({ fighters: ctx.fighters.length ? ctx.fighters : fighters, snapshots: ctx.snaps, asOf: null }),
      ],
      links: linksFor({ fighters: ctx.fighters.length ? ctx.fighters : fighters, event: ctx.event, extra: [{ href: '/injuries', label: 'Injuries & Withdrawals', kind: 'surface' }] }),
    });
    const fs2 = ctx.fighters.length ? ctx.fighters : fighters;
    packet.entities = { ...packet.entities, ...marketEntities(ctx) };
    return finish('injury_withdrawal', packet, {
      slug: slugify(it.title).slice(0, 70),
      metrics: taleMetrics({ fighters: fs2, eventDate: ctx.event?.event_date }),
      dna: dnaMetrics({ fighters: fs2, snapshots: ctx.snaps, asOf: null }),
    });
  }
  return null;
}

/** Weigh-in miss. Requires a sourced limit; never derives one from division alone. */
async function sampleWeighIn(world) {
  const items = await q("ufc_news_items?select=id,title,summary,url,published_at,fighter_ids&order=published_at.desc&limit=200");
  for (const it of items) {
    if (classifyStatus(it.title, it.summary || '')[0]?.type !== 'weight_miss') continue;
    const fighters = (it.fighter_ids || []).map((id) => world.fighters.get(id)).filter(Boolean);
    if (!fighters.length) continue;

    const booking = await q(`ufc_bouts?select=*&or=(fighter_a_id.eq.${fighters[0].id},fighter_b_id.eq.${fighters[0].id})&order=bout_order.desc&limit=1`);
    const bout = booking[0];
    if (!bout) continue;
    const ctx = await boutContext(bout, world, null);

    /* The limit must come from a source. resolveLimit refuses catchweight and
       open-weight, and returns a basis we can print. No basis, no weigh-in
       facts - the story then stands or falls on everything else. */
    const limit = resolveLimit({ weightClass: bout.weight_class, isTitle: bout.is_title });
    const m = `${it.title} ${it.summary || ''}`.match(/(\d{2,3}(?:\.\d)?)\s*(?:pounds|lbs?\b)/i);
    const readings = (limit?.limit_lbs && m) ? [{
      id: it.id, fighter_name: fighters[0].name, weight_lb: Number(m[1]),
      limit_lb: limit.limit_lbs, limit_basis: limit.basis, source_url: it.url,
      publisher: publisherOf(it.url), clock_time: it.published_at,
    }] : [];

    resetFactIds();
    const packet = buildPacket({
      storyType: 'weigh_in_miss',
      live: true,
      entities: { fighters: ctx.fighters, event: ctx.event, bout },
      parts: [
        sourceItemFacts({ item: { ...it, publisher: publisherOf(it.url) } }),
        weighInFacts({ readings }),
        coreFacts({ event: ctx.event, bout, fighters: ctx.fighters }),
        taleFacts({ fighters: ctx.fighters, eventDate: ctx.event?.event_date }),
        recentFormFacts({ fighters: ctx.fighters, bouts: ctx.form, asOf: null }),
        fightDnaFacts({ fighters: ctx.fighters, snapshots: ctx.snaps, asOf: null }),
      ],
      links: linksFor({ fighters: ctx.fighters, event: ctx.event, extra: [{ href: '/weigh-ins', label: 'Weigh-Ins', kind: 'surface' }] }),
    });
    packet.entities = { ...packet.entities, ...marketEntities(ctx) };
    return finish('weigh_in_miss', packet, {
      slug: slugify(it.title).slice(0, 70),
      metrics: taleMetrics({ fighters: ctx.fighters, eventDate: ctx.event?.event_date }),
      dna: dnaMetrics({ fighters: ctx.fighters, snapshots: ctx.snaps, asOf: null }),
    });
  }
  return null;
}

/**
 * The critical one. A source-driven item whose packet holds the source and a
 * couple of table facts. It must come back as WIRE.
 */
async function sampleSourceDriven(world) {
  const items = await q("ufc_news_items?select=id,title,summary,url,published_at,fighter_ids&order=published_at.desc&limit=60");
  for (const it of items) {
    const k = classifyStatus(it.title, it.summary || '')[0]?.type;
    if (['injury', 'withdrawal', 'replacement', 'weight_miss'].includes(k)) continue;
    const fighters = (it.fighter_ids || []).map((id) => world.fighters.get(id)).filter(Boolean);
    if (fighters.length !== 1) continue;

    resetFactIds();
    const packet = buildPacket({
      storyType: 'news_brief',
      live: true,
      entities: { fighters, event: null, bout: null },
      parts: [
        sourceItemFacts({ item: { ...it, publisher: publisherOf(it.url) } }),
        coreFacts({ event: null, bout: null, fighters }),
        [],
      ],
      links: linksFor({ fighters }),
    });
    return finish('news_brief', packet, { slug: slugify(it.title).slice(0, 70) });
  }
  return null;
}

/** The market table and the market paragraph must be one reading, not two. */
function marketEntities(ctx) {
  const sum = marketSummary({ observations: ctx.market, fighters: ctx.fighters, asOf: null });
  return sum ? { marketSides: sum.sides, marketObservedAt: sum.observedAt, marketStale: sum.stale } : {};
}

function publisherOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return { 'mmafighting.com': 'MMA Fighting', 'bloodyelbow.com': 'Bloody Elbow', 'espn.com': 'ESPN MMA', 'mmajunkie.usatoday.com': 'MMA Junkie', 'ufc.com': 'UFC.com' }[h] || h;
  } catch { return 'the source'; }
}

/* ---- compose + gate ----------------------------------------------------- */

function finish(storyType, packet, { slug, metrics = null, dna = null }) {
  /* Evidence sets the ceiling; the composed body sets the floor.
   *
   * A packet can carry enough families for a feature and still yield 690 words,
   * because the composer only writes what the facts support. The honest
   * response is to publish it as the class it actually reached, not to pad it
   * up to the one it was entitled to. So: compose, and if the body misses its
   * floor, drop a class and compose again, down to wire if that is where the
   * evidence lands. This loop is the mechanism behind "never pad to hit a
   * number". */
  const ladder = ['deep_dive', 'feature', 'brief', 'wire'];
  let decision = resolveClass(storyType, { families: packet.families, factCount: packet.fact_count });
  let composed = compose(packet, { slug, publicationClass: decision.publication_class, metrics, dna });
  let reconciled = null;
  if (process.env.PBE_DEBUG_LADDER) console.error(`[ladder] ${storyType} start=${decision.publication_class} words=${composed.word_count} headings=${composed.headings.join('|')} modules=${composed.modules.join(',')}`);
  for (let i = ladder.indexOf(decision.publication_class); i < ladder.length - 1; i++) {
    const floor = CLASS_BUDGET[ladder[i]].min;
    if (composed.word_count >= floor) break;
    const next = ladder[i + 1];
    reconciled = `${composed.word_count} words did not reach the ${ladder[i]} floor of ${floor}; published as ${next} rather than padded`;
    decision = {
      ...decision,
      publication_class: next,
      downgraded: true,
      reason: reconciled,
      budget: CLASS_BUDGET[next],
    };
    composed = compose(packet, { slug, publicationClass: next, metrics, dna });
  }
  const withLinks = decision.publication_class === 'wire'
    ? composed.body_md
    : weaveLinks(composed.body_md, packet.links);
  composed.body_md = withLinks;

  const headline = headlineFor(packet, { publicationClass: decision.publication_class });
  const dek = dekFor(packet, composed.body_md);
  const entities = (packet.entities.fighters ?? []).map((f) => f.name);

  const idx = isIndexable(decision.publication_class, composed.word_count);
  const schema = idx.indexable ? {
    '@type': 'NewsArticle',
    '@id': `https://ufc.propbetedge.ai/news/${slug}#article`,
    headline,
    description: dek,
    image: [`https://ufc.propbetedge.ai/news/${slug}/opengraph-image`],
    datePublished: new Date().toISOString(),
    dateModified: new Date().toISOString(),
    author: { '@type': 'Organization', name: 'PropBetEdge Editorial Desk', url: 'https://ufc.propbetedge.ai/about/editorial' },
    publisher: { '@type': 'Organization', name: 'PropBetEdge', logo: { '@type': 'ImageObject', url: 'https://ufc.propbetedge.ai/brand/logo.svg' } },
    mainEntityOfPage: `https://ufc.propbetedge.ai/news/${slug}`,
    articleSection: storyType.replace(/_/g, ' '),
    keywords: entities.join(', '),
    wordCount: composed.word_count,
    about: entities.map((n) => ({ '@type': 'Person', name: n })),
    isAccessibleForFree: true,
  } : null;

  const violations = runAllGates({
    composed, packet, headline, dek,
    publicationClass: decision.publication_class,
    storyDepth: decision.publication_class === decision.expected_class ? STORY_DEPTH[storyType] : null,
    entities, schema,
    dates: { publishedAt: new Date().toISOString() },
  });

  return {
    story_type: storyType,
    slug,
    decision,
    reconciled,
    indexable: idx,
    headline,
    dek,
    word_count: composed.word_count,
    headings: composed.headings,
    modules: composed.modules,
    internal_links: [...String(composed.body_md).matchAll(/\[([^\]]*)\]\((\/[^)]*)\)/g)].map((m) => ({ label: m[1], href: m[2] })),
    source_families: packet.families,
    fact_count: packet.fact_count,
    facts_cited: composed.used_fact_ids.length,
    body_md: composed.body_md,
    schema,
    gate: { ok: violations.length === 0, violations },
  };
}

/* ---- main --------------------------------------------------------------- */

const BUILDERS = {
  main_event_preview: (w) => samplePreview('main_event_preview', w),
  main_card_preview: (w) => samplePreview('main_card_preview', w),
  results: sampleResults,
  injury_withdrawal: sampleInjury,
  weigh_in_miss: sampleWeighIn,
  news_brief: sampleSourceDriven,
};

const main = async () => {
  const world = await loadWorld();
  const wanted = ONLY ? [ONLY] : Object.keys(BUILDERS);
  const out = [];
  for (const k of wanted) {
    process.stderr.write(`building ${k}...\n`);
    try {
      const r = await BUILDERS[k](world);
      if (!r) { out.push({ story_type: k, error: 'no eligible source material in the archive' }); continue; }
      out.push(r);
    } catch (e) { out.push({ story_type: k, error: e.message }); }
  }

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(out, null, 2)}\n`);

  for (const r of out) {
    console.log('\n' + '='.repeat(78));
    if (r.error) { console.log(`${r.story_type}: ${r.error}`); continue; }
    console.log(`${r.story_type.toUpperCase()}  ->  ${r.decision.publication_class.toUpperCase()}${r.decision.downgraded ? '  (DOWNGRADED)' : ''}`);
    console.log('='.repeat(78));
    if (r.decision.downgraded) console.log(`downgrade reason: ${r.decision.reason}`);
    console.log(`indexable: ${r.indexable.indexable}${r.indexable.reason ? ` — ${r.indexable.reason}` : ''}`);
    console.log(`words: ${r.word_count}   facts: ${r.facts_cited}/${r.fact_count}   families: ${r.source_families.join(', ')}`);
    console.log(`gate: ${r.gate.ok ? 'PASS' : `FAIL (${r.gate.violations.length})`}`);
    for (const v of r.gate.violations) console.log(`   - ${v.gate}: ${v.detail ?? `${v.value} in "${(v.context ?? '').trim()}"`}`);
    console.log(`\nHEADLINE: ${r.headline}   (${r.headline.length} chars)`);
    console.log(`DEK: ${r.dek}   (${r.dek.length} chars)`);
    if (r.headings.length) console.log(`H2s: ${r.headings.join(' | ')}`);
    if (r.modules.length) console.log(`modules: ${r.modules.join(', ')}`);
    if (r.internal_links.length) console.log(`links: ${r.internal_links.map((l) => l.href).join(' ')}`);
    console.log('\n--- BODY ---\n');
    console.log(r.body_md);
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
