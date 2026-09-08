#!/usr/bin/env node
/* Fighter status collector — reads news, writes status events, publishes nothing.
 *
 *   node scripts/status/collect_status_events.mjs [--dry-run] [--since-hours 6]
 *                                                 [--limit N] [--min-confidence 0.6]
 *
 * DEFAULT IS DRY RUN. `--write` is required to store anything, and the
 * migration this depends on has not been applied, so the write path is
 * currently unreachable in every environment. That is deliberate: the read
 * path, the extraction and the report are what get reviewed first.
 *
 * WHY IT IS ITS OWN PHASE AND NOT PART OF THE WRITER
 *
 * Article publication and status detection want opposite cadences and have
 * opposite failure modes. Publication is expensive, occasionally calls a
 * model, and is fine running every couple of hours. A withdrawal is worth
 * knowing within minutes and costs one query and some regexes. Coupling them
 * would mean either paying for the writer every five minutes or learning about
 * a main-event withdrawal on the writer's schedule.
 *
 * They also fail differently. If the editorial desk is down, the newsroom
 * should still know who is out. If status extraction throws on a malformed
 * feed item, the day's articles must still publish. So this is a separate
 * entry point with its own window, its own idempotency and its own counters:
 * ufc-newsroom can call `collectStatusEvents(env, opts)` from a 5-15 minute
 * trigger, and NOTHING in the article path imports it or waits on it.
 *
 * The overlapping-window design is what makes that cadence safe. Every pass
 * re-reads the last `--since-hours` of news, so an item that arrives late, is
 * edited, or is linked to a fighter only after a later fighter load still gets
 * a second look. Re-reading is free because the fingerprint makes a repeat a
 * no-op at the database rather than a judgement in the client.
 */
import { Supabase, loadEnv, sha256 } from '../news/lib.mjs';
import { extractStatus, fingerprintOf, CANDIDATE_LABELS } from './lib/extract.mjs';

export function parseCliOptions(argv = []) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    write: flag('--write'),
    sinceHours: Number(opt('--since-hours', 6)) || 6,
    limit: Number(opt('--limit', 0)) || 0,
    minConfidence: Number(opt('--min-confidence', 0.6)) || 0.6,
    verbose: flag('--verbose'),
  };
}

export function resolveOptions(options = {}) {
  return {
    /* Writing is opt-in. A collector whose default is "store it" is one bad
     * regex away from asserting that a healthy fighter is injured. */
    write: Boolean(options.write),
    sinceHours: Math.min(24 * 30, Math.max(1, Number(options.sinceHours) || 6)),
    limit: Number(options.limit) || 0,
    minConfidence: Math.min(1, Math.max(0, Number(options.minConfidence) ?? 0.6)),
    verbose: Boolean(options.verbose),
    now: options.now ?? Date.now(),
  };
}

/* Official promotion surfaces outrank the wire for card changes: when UFC.com
 * says a bout is off, that is the promotion amending its own card rather than
 * a report about it. Kind drives both confidence and display. */
const OFFICIAL_HOSTS = ['ufc.com', 'www.ufc.com', 'ufcespanol.com'];
const COMMISSION_HOSTS = ['nevadaathleticcommission.com', 'usada.org', 'ufc.usada.org', 'combatsports.ca.gov'];

export function sourceKindFor(url, sourceName) {
  const host = (() => { try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; } })();
  if (OFFICIAL_HOSTS.includes(host)) return 'official';
  if (COMMISSION_HOSTS.includes(host)) return 'commission';
  if (/^ufc\.com/i.test(String(sourceName || ''))) return 'official';
  return 'news';
}

/** Items worth opening: the taxonomy prefilter, applied to a page of news. */
export function candidateItems(items) {
  return items.filter((it) => {
    const labels = it?.taxonomy?.labels || [];
    return labels.some((l) => CANDIDATE_LABELS.has(l));
  });
}

/**
 * One pass. Returns counters and the events it would write (or wrote).
 *
 * Never throws for one bad item: an item that breaks extraction is counted and
 * skipped, because a single malformed summary must not stop the newsroom
 * learning that a main event is off.
 */
export async function collectStatusEvents(injectedEnv, options = {}) {
  const opts = resolveOptions(options);
  const env = injectedEnv || loadEnv();
  const sb = new Supabase(env);

  const since = new Date(opts.now - opts.sinceHours * 3600e3).toISOString();
  const items = await sb.select('ufc_news_items',
    `select=id,url,title,summary,published_at,taxonomy,fighter_ids,bout_id,event_id,captured_at,source_id`
    + `&or=(published_at.gte.${since},and(published_at.is.null,captured_at.gte.${since}))`
    + `&order=published_at.desc.nullslast`);

  const candidates = candidateItems(items);
  const fighterIds = [...new Set(candidates.flatMap((i) => i.fighter_ids || []))];
  const fighters = fighterIds.length
    ? await sb.select('ufc_fighters', `select=id,name&id=in.(${fighterIds.join(',')})`)
    : [];
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const sources = new Map((await sb.select('ufc_news_sources', 'select=id,name,url')).map((s) => [s.id, s]));

  const counters = {
    window_hours: opts.sinceHours, items_read: items.length, candidates: candidates.length,
    events: 0, below_confidence: 0, extraction_errors: 0, written: 0, duplicates: 0,
  };
  const events = [];
  const skipped = [];

  for (const it of candidates) {
    const src = sources.get(it.source_id);
    let out;
    try {
      out = extractStatus({
        ...it,
        fighters: (it.fighter_ids || []).map((id) => byId.get(id)).filter(Boolean),
        source_name: src?.name || null,
        source_kind: sourceKindFor(it.url, src?.name),
      }, { now: opts.now });
    } catch (e) {
      counters.extraction_errors += 1;
      skipped.push({ id: it.id, title: it.title, reason: 'extractor_threw', detail: String(e?.message || e).slice(0, 160) });
      continue;
    }
    skipped.push(...out.skipped);
    for (const evt of out.events) {
      if (evt.confidence < opts.minConfidence) { counters.below_confidence += 1; skipped.push({ id: it.id, title: it.title, reason: 'below_confidence', detail: String(evt.confidence) }); continue; }
      events.push({ ...evt, fingerprint: fingerprintOf(evt, sha256) });
      counters.events += 1;
    }
    if (opts.limit && events.length >= opts.limit) break;
  }

  if (!opts.write) {
    console.log(`[status] dry run: ${counters.events} event(s) from ${counters.candidates} candidate(s) of ${counters.items_read} item(s) in the last ${opts.sinceHours}h`);
    return { ...counters, events, skipped, wrote: false };
  }

  /* The write path. Unreachable until the migration is applied, and shaped so
   * that a repeat pass is a database no-op rather than a client decision:
   * on_conflict names the real unique index, never the surrogate primary key. */
  for (const evt of events) {
    const row = { ...evt };
    delete row.fighter_name; delete row.ambiguous;
    try {
      await sb.insert('ufc_fighter_status_events', [row], { onConflict: 'fingerprint', ignoreDuplicates: true, returning: false });
      counters.written += 1;
    } catch (e) {
      if (/23505|duplicate/i.test(String(e?.message))) counters.duplicates += 1;
      else throw e;
    }
  }
  console.log(`[status] wrote ${counters.written}, ${counters.duplicates} already known`);
  return { ...counters, events, skipped, wrote: true };
}

/* CLI only. Importing this module must never read or write anything. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('collect_status_events.mjs');
if (isCli) {
  collectStatusEvents(undefined, parseCliOptions(process.argv.slice(2)))
    .then((r) => {
      if (r.events.length) {
        console.log('\nevents:');
        for (const e of r.events) {
          console.log(`  ${e.status_type.padEnd(12)} ${String(e.fighter_name).padEnd(24)} conf=${e.confidence} ${e.injury_type || e.body_part || '(no diagnosis stated)'}`);
        }
      }
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
