#!/usr/bin/env node
/* Seed and verify ufc_news_sources. Idempotent: upserts on (kind, name).
 *
 * A source is not healthy merely because an RSS endpoint still returns 200.
 * Production proved that failure mode on 2026-09-16: multiple enabled feeds
 * kept returning parseable but day-old bodies while the publishers themselves
 * had fresh UFC coverage. The newsroom looked "green" and stopped detecting
 * news. Verification therefore checks CONTENT FRESHNESS as well as transport.
 *
 * Every RSS candidate URL is fetched and parsed before it is written. A source
 * whose feed is unreachable, empty, materially undated, or whose newest dated
 * item is older than MAX_NEWEST_ITEM_AGE_HOURS is not trusted. Known alternate
 * URLs are tried before a source is disabled.
 *
 * One `internal` source, propbetedge-tables, represents stories generated from
 * our own tables.
 *
 *   node scripts/news/seed_sources.mjs [--dry-run]
 *
 * Worker-callable on the same terms as the other control-plane phases: env
 * injected, options explicit, and NOTHING runs on import.
 */
import { Supabase, fetchText, parseFeed, parseDate } from './lib.mjs';

export const MAX_NEWEST_ITEM_AGE_HOURS = 24;
export const MIN_DATED_RATIO = 0.5;

/* This is the production source catalog. Keep the control plane responsible for
 * the same registry the two-minute detector actually reads; previously the
 * daily source pass knew only five feeds while ufc-news-ingest had thirteen,
 * leaving most enabled feeds effectively unmanaged forever. */
export const RSS_SOURCES = [
  { name: 'MMA Fighting', urls: ['https://www.mmafighting.com/rss/current', 'https://www.mmafighting.com/rss/index.xml'], weight: 1 },
  { name: 'MMA Junkie', urls: ['https://mmajunkie.usatoday.com/feed', 'https://mmajunkie.usatoday.com/feed/', 'https://mmajunkie.usatoday.com/category/ufc/feed'], weight: 1 },
  { name: 'ESPN MMA', urls: ['https://www.espn.com/espn/rss/mma/news'], weight: 1 },
  { name: 'Bloody Elbow', urls: ['https://www.bloodyelbow.com/feed', 'https://bloodyelbow.com/feed/'], weight: 0.9 },
  { name: 'UFC.com News', urls: ['https://www.ufc.com/rss/news'], weight: 1.2 },
  { name: 'MMA Mania', urls: ['https://www.mmamania.com/rss/current', 'https://www.mmamania.com/rss/index.xml'], weight: 0.8 },
  { name: 'Sherdog', urls: ['https://www.sherdog.com/rss/news.xml', 'https://www.sherdog.com/rss/news'], weight: 0.9 },
  { name: 'Cageside Press', urls: ['https://cagesidepress.com/feed/'], weight: 0.7 },
  { name: 'The Mac Life', urls: ['https://themaclife.com/feed/'], weight: 0.6 },
  { name: 'MMA News', urls: ['https://www.mmanews.com/feed/'], weight: 0.7 },
  { name: 'BJPenn.com', urls: ['https://www.bjpenn.com/feed/'], weight: 0.6 },
  { name: 'Combat Press', urls: ['https://combatpress.com/feed/'], weight: 0.6 },
  { name: 'MMA Weekly', urls: ['https://www.mmaweekly.com/feed'], weight: 0.6 },
  { name: 'LowKick MMA', urls: ['https://www.lowkickmma.com/feed/'], weight: 0.5 },
  { name: 'MiddleEasy', urls: ['https://middleeasy.com/feed/'], weight: 0.5 },
];

const INTERNAL_SOURCE = { kind: 'internal', name: 'propbetedge-tables', url: null, weight: 2, enabled: true };

export function parseCliOptions(argv = []) {
  return { dry: argv.includes('--dry-run') };
}

export function resolveOptions(options = {}) {
  return {
    dry: Boolean(options.dry),
    now: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
  };
}

/** Fetch and grade one candidate feed. Never throws: a broken or stale source
 * is a fact about that source, not a failure of the source pass. */
export async function verify(url, { now = Date.now() } = {}) {
  try {
    const r = await fetchText(url);
    if (!r.ok) return { ok: false, reason: `http ${r.status}` };

    const items = parseFeed(r.body);
    if (!items.length) return { ok: false, reason: 'no items parsed' };

    const sample = items.slice(0, 25);
    const dated = sample.map((i) => parseDate(i.published)).filter(Boolean);
    const datedRatio = dated.length / sample.length;
    if (datedRatio < MIN_DATED_RATIO) {
      return {
        ok: false,
        reason: `only ${dated.length}/${sample.length} sampled items carry a parseable date`,
        items: items.length,
        finalUrl: r.finalUrl,
      };
    }

    const newestMs = Math.max(...dated.map((d) => d.getTime()));
    const newestItemAgeHours = (now - newestMs) / 3600e3;
    if (newestItemAgeHours > MAX_NEWEST_ITEM_AGE_HOURS) {
      return {
        ok: false,
        reason: `stale feed: newest dated item is ${newestItemAgeHours.toFixed(1)}h old (max ${MAX_NEWEST_ITEM_AGE_HOURS}h)`,
        items: items.length,
        finalUrl: r.finalUrl,
        newest_item_at: new Date(newestMs).toISOString(),
        newest_item_age_hours: Number(newestItemAgeHours.toFixed(1)),
      };
    }

    return {
      ok: true,
      items: items.length,
      finalUrl: r.finalUrl,
      dated_ratio: Number(datedRatio.toFixed(2)),
      newest_item_at: new Date(newestMs).toISOString(),
      newest_item_age_hours: Number(newestItemAgeHours.toFixed(1)),
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Verify every candidate and choose a URL per source.
 *
 * Each source is resolved independently. A stale primary URL is treated the
 * same as a dead primary URL: try the alternate before disabling the source.
 */
export async function verifySources(sources = RSS_SOURCES, { log = console.log, now = Date.now() } = {}) {
  const chosen = [];
  const dropped = [];
  const attempts = [];

  for (const src of sources) {
    let selected = null;
    for (const candidate of src.urls) {
      const v = await verify(candidate, { now });
      attempts.push({ name: src.name, url: candidate, ...v });
      log(`${v.ok ? 'ok  ' : 'fail'} ${src.name} ${candidate} -> ${v.ok ? `${v.items} items; newest ${v.newest_item_age_hours}h ago` : v.reason}`);
      if (v.ok) { selected = candidate; break; }
    }

    if (selected) chosen.push({ kind: 'rss', name: src.name, url: selected, weight: src.weight, enabled: true });
    else dropped.push(src.name);
  }

  return { chosen, dropped, attempts };
}

export async function main(injectedEnv, options = {}) {
  const opts = resolveOptions(options);
  const sb = new Supabase(injectedEnv);

  const { chosen, dropped } = await verifySources(RSS_SOURCES, { now: opts.now });
  const rows = [INTERNAL_SOURCE, ...chosen];

  console.log(`\nseeding ${rows.length} sources${dropped.length ? `; dropped: ${dropped.join(', ')}` : ''}`);
  if (opts.dry) {
    console.log(JSON.stringify(rows, null, 2));
    return { verified: chosen.length, dropped: dropped.length, disabled: 0, enabled_total: null, dry: true };
  }

  const written = await sb.upsert('ufc_news_sources', rows, 'kind,name');
  for (const r of written) console.log(`  ${r.kind.padEnd(8)} ${r.name.padEnd(20)} weight=${r.weight} enabled=${r.enabled} ${r.url || ''}`);

  /* Previously trusted feeds that no longer verify are switched off, never
   * deleted, preserving provenance for historical ufc_news_items rows. */
  let disabled = 0;
  for (const name of dropped) {
    const off = await sb.patch(
      'ufc_news_sources',
      `kind=eq.rss&name=eq.${encodeURIComponent(name)}&enabled=is.true`,
      { enabled: false },
    );
    if (off && off.length) {
      disabled += 1;
      console.log(`  disabled ${name} (feed unavailable or stale)`);
    }
  }

  const all = await sb.select('ufc_news_sources', 'select=id,kind,name,enabled');
  const enabledTotal = all.filter((s) => s.enabled).length;
  console.log(`\nufc_news_sources: ${all.length} rows, ${enabledTotal} enabled`);
  return { verified: chosen.length, dropped: dropped.length, disabled, enabled_total: enabledTotal, dry: false };
}

/* CLI only. Importing this module must never write a source row. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('seed_sources.mjs');
if (isCli) main(undefined, parseCliOptions(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
