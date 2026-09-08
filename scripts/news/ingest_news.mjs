#!/usr/bin/env node
/* Pull every enabled RSS source into ufc_news_items.
 *
 *  - parses title / link / pubDate / description (HTML stripped, <=400 chars)
 *  - skips items older than 14 days
 *  - dedupes by url and by fingerprint = sha256(normalized title + domain)
 *  - classifies with keyword rules -> taxonomy {labels, confidence, matched}
 *  - links fighters (alias resolver), event (+-60 days by name), bout (both
 *    fighters of an announced bout named in the text)
 *  - inserts only new rows
 *
 *   node scripts/news/ingest_news.mjs [--dry-run] [--max-age-days 14] [--relink]
 *
 * --relink recomputes taxonomy + fighter/event/bout links for items captured in
 * the last --max-age-days and patches the rows whose links changed. Use it after
 * a fighter/event load lands so earlier items pick up entities that did not
 * exist when they were ingested.
 */
import { normalize } from '../../shared/alias_resolver.mjs';
import {
  Supabase, fetchText, parseFeed, parseDate, sha256, domainOf, classify,
  loadFighterIndex, findFighterMentions, dedupeEvents, surname,
} from './lib.mjs';

/* Options are an argument, not a module-scope constant read from argv at
 * import time. The Worker imports this module once per isolate and then calls
 * main() many times; anything decided at import is decided for the life of the
 * isolate, and process.argv in workerd is empty regardless. */
export function parseCliOptions(argv = []) {
  return {
    dry: argv.includes('--dry-run'),
    relink: argv.includes('--relink'),   /* re-run classification + entity links on recent items (fighters/bouts load continuously) */
    maxAgeDays: Number(argv[argv.indexOf('--max-age-days') + 1] || 14) || 14,
  };
}

export function resolveOptions(options = {}) {
  return {
    dry: Boolean(options.dry),
    relink: Boolean(options.relink),
    maxAgeDays: Number(options.maxAgeDays) || 14,
    /* Per invocation: the freshness cutoff and the +-60d event window both
     * move with the clock, and a scheduled Worker crosses midnight. */
    now: options.now ?? Date.now(),
  };
}

function fingerprintOf(title, url) {
  return sha256(`${normalize(title)}|${domainOf(url)}`);
}

/* Match keys for an event: the whole name, the "A vs B" tail, and "ufc 331"-style numbers. */
function eventKeys(e) {
  const keys = new Set();
  const n = normalize(e.name);
  if (n) keys.add(n);
  const m = String(e.name).match(/^([^:]+):\s*(.+)$/);
  if (m) {
    const tail = normalize(m[2]);
    if (tail.split(' ').length >= 3) keys.add(tail);           /* "silva vs delgado" */
    const num = normalize(m[1]).match(/^ufc (\d{2,3})$/);
    if (num) keys.add(`ufc ${num[1]}`);
  }
  return [...keys];
}

async function loadEventContext(sb, now) {
  const today = new Date(now);
  const lo = new Date(today.getTime() - 60 * 86400e3).toISOString().slice(0, 10);
  const hi = new Date(today.getTime() + 60 * 86400e3).toISOString().slice(0, 10);
  const events = await sb.select('ufc_events', `select=id,name,event_date,venue,city,country,card_status&event_date=gte.${lo}&event_date=lte.${hi}`);
  if (!events.length) return { events: [], bouts: [] };
  const ids = events.map((e) => e.id).join(',');
  const bouts = await sb.select('ufc_bouts', `select=id,event_id,fighter_a_id,fighter_b_id,status,bout_order&event_id=in.(${ids})`);
  const boutsByEvent = new Map();
  for (const b of bouts) {
    if (!boutsByEvent.has(b.event_id)) boutsByEvent.set(b.event_id, []);
    boutsByEvent.get(b.event_id).push(b);
  }
  const primaries = dedupeEvents(events, { boutsByEvent });
  /* Bouts of a duplicate copy count for the primary (same card, other source id). */
  const idMap = new Map();
  for (const p of primaries) { idMap.set(p.id, p.id); for (const a of p.alt_ids) idMap.set(a, p.id); }
  for (const b of bouts) b.event_id = idMap.get(b.event_id) || b.event_id;
  return { events: primaries.map((e) => ({ ...e, keys: eventKeys(e) })), bouts };
}

function linkEntities(item, ctx, index, now) {
  const text = `${item.title}. ${item.summary || ''}`;
  const norm = ` ${normalize(text)} `;
  const fighterIds = new Set(findFighterMentions(text, index).map((m) => m.fighter_id));

  /* Event: longest key match wins; ties go to the event closest to today. */
  let event = null;
  let bestLen = 0;
  for (const e of ctx.events) {
    for (const k of e.keys) {
      if (!norm.includes(` ${k} `)) continue;
      const dist = Math.abs(new Date(e.event_date).getTime() - now);
      if (k.length > bestLen || (k.length === bestLen && event && dist < Math.abs(new Date(event.event_date).getTime() - now))) {
        event = e; bestLen = k.length;
      }
    }
  }

  /* Bout: both fighters named in the TITLE, in full or by surname ("Hooker vs. Parnasse").
   * Summaries routinely mention the main event of whatever card the item is about, so a
   * summary-only match would tag every fight-week item with the headliner. */
  let bout = null;
  const titleNorm = ` ${normalize(item.title)} `;
  const titleFighters = new Set(findFighterMentions(item.title, index).map((m) => m.fighter_id));
  const pool = event ? ctx.bouts.filter((b) => b.event_id === event.id) : ctx.bouts;
  const candidates = [];
  for (const b of pool) {
    const fa = index.byId.get(b.fighter_a_id);
    const fb = index.byId.get(b.fighter_b_id);
    if (!fa || !fb) continue;
    const full = titleFighters.has(fa.id) && titleFighters.has(fb.id);
    const sa = surname(fa.name); const sbn = surname(fb.name);
    const bySurname = sa.length >= 4 && sbn.length >= 4 && titleNorm.includes(` ${sa} `) && titleNorm.includes(` ${sbn} `);
    if (full || bySurname) candidates.push({ b, fa, fb, full });
  }
  if (candidates.length) {
    candidates.sort((x, y) => Number(y.full) - Number(x.full) || (y.b.bout_order || 0) - (x.b.bout_order || 0));
    const c = candidates[0];
    if (c.full || candidates.filter((x) => x.b.event_id === c.b.event_id).length === 1 || event) {
      bout = c.b;
      fighterIds.add(c.fa.id); fighterIds.add(c.fb.id);
      if (!event) event = ctx.events.find((e) => e.id === bout.event_id) || null;
    }
  }
  return { fighter_ids: [...fighterIds], event_id: event ? event.id : null, bout_id: bout ? bout.id : null };
}

/* `injectedEnv` lets a non-Node host (the ufc-newsroom Worker) supply its own
 * bindings. Passing nothing keeps the CLI behaviour exactly: Supabase's own
 * default parameter falls back to loadEnv() and reads .env as before. */
export async function main(injectedEnv, options = {}) {
  const opts = resolveOptions(options);
  const sb = new Supabase(injectedEnv);
  const sources = await sb.select('ufc_news_sources', 'select=id,kind,name,url,weight&kind=eq.rss&enabled=is.true&order=name.asc');
  if (!sources.length) { console.log('no enabled rss sources; run seed_sources.mjs first'); return; }

  const [index, ctx] = await Promise.all([loadFighterIndex(sb), loadEventContext(sb, opts.now)]);
  console.log(`index: ${index.fighters.length} fighters, ${ctx.events.length} events within +-60d, ${ctx.bouts.length} bouts`);

  const cutoff = opts.now - opts.maxAgeDays * 86400e3;
  const totals = { fetched: 0, parsed: 0, stale: 0, dup: 0, inserted: 0, failed: 0, linked_fighters: 0, linked_event: 0, linked_bout: 0 };
  const seenThisRun = new Set();

  for (const src of sources) {
    let items = [];
    try {
      const r = await fetchText(src.url);
      if (!r.ok) throw new Error(`http ${r.status}`);
      items = parseFeed(r.body);
    } catch (e) {
      console.log(`fail ${src.name}: ${e.message}`);
      totals.failed += 1;
      continue;
    }
    totals.fetched += 1;
    totals.parsed += items.length;

    const fresh = [];
    for (const it of items) {
      const d = parseDate(it.published);
      if (d && d.getTime() < cutoff) { totals.stale += 1; continue; }
      const fp = fingerprintOf(it.title, it.link);
      if (seenThisRun.has(fp) || seenThisRun.has(it.link)) { totals.dup += 1; continue; }
      seenThisRun.add(fp); seenThisRun.add(it.link);
      fresh.push({ ...it, published_at: d ? d.toISOString() : null, fingerprint: fp });
    }
    if (!fresh.length) { console.log(`${src.name}: ${items.length} items, nothing new`); continue; }

    /* check-then-insert: url and fingerprint are separate unique constraints, so a single
     * on_conflict target cannot cover both. */
    const urls = fresh.map((f) => `"${f.link.replace(/"/g, '')}"`).join(',');
    const fps = fresh.map((f) => f.fingerprint).join(',');
    const existing = await sb.select('ufc_news_items', `select=url,fingerprint&or=(url.in.(${encodeURIComponent(urls)}),fingerprint.in.(${fps}))`);
    const known = new Set(existing.flatMap((e) => [e.url, e.fingerprint]));

    let inserted = 0;
    for (const it of fresh) {
      if (known.has(it.link) || known.has(it.fingerprint)) { totals.dup += 1; continue; }
      const taxonomy = classify(it.title, it.summary);
      const links = linkEntities(it, ctx, index, opts.now);
      const row = {
        source_id: src.id,
        url: it.link,
        title: it.title.slice(0, 500),
        published_at: it.published_at,
        summary: it.summary || null,
        taxonomy,
        fighter_ids: links.fighter_ids,
        bout_id: links.bout_id,
        event_id: links.event_id,
        fingerprint: it.fingerprint,
      };
      if (links.fighter_ids.length) totals.linked_fighters += 1;
      if (links.event_id) totals.linked_event += 1;
      if (links.bout_id) totals.linked_bout += 1;
      const tagLine = `[${taxonomy.labels.slice(0, 3).join(',')} ${taxonomy.confidence}] f=${links.fighter_ids.length} e=${links.event_id ? 'y' : '-'} b=${links.bout_id ? 'y' : '-'}`;
      if (opts.dry) { console.log(`  would insert ${tagLine} ${it.title}`); inserted += 1; continue; }
      try {
        await sb.insert('ufc_news_items', [row], { onConflict: 'fingerprint', ignoreDuplicates: true, returning: false });
        inserted += 1;
        console.log(`  + ${tagLine} ${it.title}`);
      } catch (e) {
        if (/23505|duplicate/i.test(e.message)) totals.dup += 1;
        else { totals.failed += 1; console.log(`  ! ${it.title}: ${e.message.slice(0, 200)}`); }
      }
    }
    totals.inserted += inserted;
    console.log(`${src.name}: ${items.length} items, ${fresh.length} fresh, ${inserted} ${opts.dry ? 'would be ' : ''}inserted`);
  }

  if (opts.relink) {
    const since = new Date(cutoff).toISOString();
    const items = await sb.select('ufc_news_items', `select=id,title,summary,fighter_ids,event_id,bout_id,taxonomy&captured_at=gte.${since}&order=captured_at.desc`);
    let changed = 0;
    for (const it of items) {
      const links = linkEntities({ title: it.title, summary: it.summary }, ctx, index, opts.now);
      const taxonomy = classify(it.title, it.summary);
      const same = JSON.stringify([...it.fighter_ids].sort()) === JSON.stringify([...links.fighter_ids].sort())
        && it.event_id === links.event_id && it.bout_id === links.bout_id
        && JSON.stringify(it.taxonomy.labels) === JSON.stringify(taxonomy.labels) && it.taxonomy.confidence === taxonomy.confidence;
      if (same) continue;
      changed += 1;
      if (opts.dry) { console.log(`  would relink ${it.title.slice(0, 70)} -> f=${links.fighter_ids.length} e=${links.event_id ? 'y' : '-'} b=${links.bout_id ? 'y' : '-'}`); continue; }
      await sb.patch('ufc_news_items', `id=eq.${it.id}`, { ...links, taxonomy });
    }
    console.log(`relink: ${items.length} items checked, ${changed} ${opts.dry ? 'would change' : 'patched'}`);
  }

  console.log(`\nsources fetched=${totals.fetched} failed=${totals.failed} | items parsed=${totals.parsed} stale=${totals.stale} dup=${totals.dup} inserted=${totals.inserted}`);
  console.log(`linked: fighters on ${totals.linked_fighters}, event on ${totals.linked_event}, bout on ${totals.linked_bout} of the inserted items`);
  /* Returned rather than logged-and-grepped: the GitHub workflow parsed
   * `inserted=N` out of stdout and read 0 whenever the line moved. */
  return totals;
}

/* Only self-execute as a CLI. Imported by the Worker, this file must define
 * and export, never run: an import that ingests would make merely loading the
 * module a production write. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('ingest_news.mjs');
if (isCli) main(undefined, parseCliOptions(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
