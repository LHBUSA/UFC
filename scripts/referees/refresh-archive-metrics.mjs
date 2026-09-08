#!/usr/bin/env node
/**
 * Refresh ONLY the archive-derived half of each referee packet.
 *
 *   node scripts/referees/refresh-archive-metrics.mjs [--dry-run] [--slug s] [--limit N]
 *
 * The packets mix two kinds of claim and they age at completely different
 * rates. Identity, biography and media come from Wikipedia, Wikidata and a
 * licensed image search: expensive to obtain, externally sourced, and stable
 * for years. Everything else is computed from our own bout rows and goes out
 * of date every time the archive grows or two referee identities are merged.
 *
 * The existing enrich.mjs refreshes both, which makes routine recomputation
 * expensive and risky — a metrics refresh would re-resolve every identity and
 * could quietly replace a sourced biography because an article moved. So this
 * command does the archive half and nothing else.
 *
 * It does NOT call Wikipedia. It does NOT call Wikidata. It does not touch
 * identity, bio, media, media_search or sources, and it preserves every
 * externally sourced claim exactly as it found it — including the facts that
 * CAN come from either place, which are only rewritten when the packet says
 * they came from the archive.
 *
 * It fails closed per referee: if the number of bout rows fetched is not the
 * number the directory reports, nothing is written for that referee. A packet
 * that is honestly old beats one that is quietly short.
 */
import { cli, nowIso, readPacket, rest, writeCombined, writePacket } from '../media/lib/subjects.mjs';
import { archiveMetricsFor } from './lib/archive-metrics.mjs';

const args = cli(); // --dry-run, --limit, --slug

const SELECT = 'name,display_name,slug,bouts,title_bouts,five_round_bouts,first_event_date,last_event_date,country,bio_source_url';
const ARCHIVE_SRC = 'PropBetEdge UFC archive (ufc_referee_directory)';
const yearOf = (d) => (d ? new Date(`${d}T00:00:00Z`).getUTCFullYear() : null);

/** A claim in the packet's shape. */
const claim = (value, source, method) => ({ value: value ?? null, source: value == null ? null : source, method: value == null ? null : method, verified_at: nowIso() });

/**
 * Was this claim derived from our archive, or from an external source?
 *
 * Some facts can come from either — full_name is the Wikipedia article title
 * when one was resolved and the display name otherwise; nationality is
 * Wikidata P27 or the archive's country column. Rewriting those blindly would
 * quietly discard a sourced value, so the packet's own recorded method decides
 * whether this command owns the field.
 */
const isArchiveClaim = (c) => !c || c.method == null || String(c.method).startsWith('archive');

const main = async () => {
  let refs = await rest(`ufc_referee_directory?select=${SELECT}&order=bouts.desc&limit=1000`);
  if (args.slug) refs = refs.filter((r) => r.slug === args.slug);
  if (args.limit !== Infinity) refs = refs.slice(0, args.limit);

  console.log(`archive metrics refresh: ${refs.length} referee(s)${args.dry ? ' (dry run)' : ''}`);
  console.log('identity, biography, media and external sources are not touched.\n');

  const counts = { updated: 0, skipped_no_packet: 0, unchanged: 0, failed: 0 };
  const failures = [];

  for (const r of refs) {
    const existing = readPacket('referees', r.slug);
    if (!existing) { counts.skipped_no_packet += 1; continue; }

    let metrics;
    try {
      metrics = await archiveMetricsFor(r.slug, r.bouts, (q) => rest(q));
    } catch (e) {
      counts.failed += 1;
      failures.push(`${r.slug}: ${e.message}`);
      console.log(`  FAILED   ${r.slug.padEnd(26)} ${e.message}`);
      continue;
    }

    const firstYear = yearOf(r.first_event_date);
    const lastYear = yearOf(r.last_event_date);
    const before = existing.metrics?.sample_bouts ?? null;

    /* Rebuilt field by field, so anything not named here survives untouched. */
    const next = {
      ...existing,
      /* The display name follows the directory, which is where an identity
       * merge lands. Everything else about who this person is stays put. */
      name: r.display_name,
      facts: {
        ...existing.facts,
        ...(isArchiveClaim(existing.facts?.full_name) ? { full_name: claim(r.display_name, ARCHIVE_SRC, 'archive') } : {}),
        ...(isArchiveClaim(existing.facts?.nationality) && r.country ? { nationality: claim(r.country, ARCHIVE_SRC, 'archive') } : {}),
        documented_since: claim(firstYear, ARCHIVE_SRC, 'archive_first_assignment'),
        documented_through: claim(lastYear, ARCHIVE_SRC, 'archive_last_assignment'),
        tenure_label: claim(
          firstYear && lastYear ? (firstYear === lastYear ? `Documented UFC assignments in ${firstYear}` : `Documented UFC assignments ${firstYear}–${lastYear}`) : null,
          ARCHIVE_SRC, 'archive_derived',
        ),
        status: claim(
          lastYear && lastYear >= new Date().getUTCFullYear() - 1 ? 'Active in the loaded archive' : lastYear ? `No loaded assignment since ${lastYear}` : null,
          ARCHIVE_SRC, 'archive_derived',
        ),
        ufc_bout_count: claim(r.bouts, ARCHIVE_SRC, 'archive_count'),
        title_fight_count: claim(r.title_bouts, ARCHIVE_SRC, 'archive_count'),
        five_round_count: claim(r.five_round_bouts, ARCHIVE_SRC, 'archive_count'),
        main_event_count: claim(metrics?.main_event_assignments, ARCHIVE_SRC, 'archive_count_card_position'),
      },
      metrics: metrics
        ? {
            ...metrics,
            origin: 'pbe_derived',
            computed_at: nowIso(),
            note: 'Historical distribution across loaded assignments. Descriptive only; a referee does not choose the matchup, styles or scheduled length.',
          }
        : null,
      /* Explicitly carried through untouched, so a future edit to this file
       * has to decide to break them rather than forget to keep them. */
      identity: existing.identity,
      bio: existing.bio,
      media: existing.media ?? null,
      media_search: existing.media_search ?? null,
      sources: existing.sources ?? [],
    };

    const moved = before !== (metrics?.sample_bouts ?? null);
    if (moved) counts.updated += 1; else counts.unchanged += 1;
    console.log(`  ${moved ? 'updated ' : 'current '} ${r.slug.padEnd(26)} sample ${String(before ?? '-').padStart(5)} -> ${String(metrics?.sample_bouts ?? '-').padStart(5)}  (directory ${r.bouts})`);

    if (!args.dry) writePacket('referees', r.slug, next);
  }

  if (!args.dry) {
    const c = writeCombined();
    console.log(`\ncombined -> ${c.dest}`);
  }

  console.log(`\nupdated=${counts.updated} already-current=${counts.unchanged} no-packet=${counts.skipped_no_packet} failed=${counts.failed}`);
  if (failures.length) {
    console.log('\nnothing was written for these:');
    for (const f of failures) console.log(`  ${f}`);
  }
  process.exitCode = counts.failed ? 1 : 0;
};

main().catch((e) => { console.error('FATAL', e.message); process.exitCode = 2; });
