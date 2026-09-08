#!/usr/bin/env node
/**
 * Read-only: does every referee packet describe the record we actually hold?
 *
 *   node scripts/referees/verify-packet-metrics.mjs [--json]
 *
 * Reads ufc_referee_directory and the checked-in packets and compares them.
 * Writes nothing, calls no provider, and touches no external source — it is
 * safe to run before a refresh to size the problem and after one to prove it
 * is gone.
 *
 * A packet is CURRENT when metrics.sample_bouts equals the directory's bout
 * count for that referee. That is the same test the page applies at runtime
 * (web/lib/packet-freshness.ts); this is the build-time half of it, so the two
 * cannot drift apart in what they consider fresh.
 */
import { readPacket, rest } from '../media/lib/subjects.mjs';

/* Read argv directly rather than through cli(), which returns a fixed set of
 * keys and would silently hand back undefined for a flag it does not know. */
const asJson = process.argv.slice(2).includes('--json');

const main = async () => {
  const refs = await rest('ufc_referee_directory?select=slug,display_name,bouts&order=bouts.desc&limit=1000');
  const live = new Map(refs.map((r) => [r.slug, r]));

  const rows = [];
  for (const r of refs) {
    const pk = readPacket('referees', r.slug);
    if (!pk) continue;
    const sample = pk.metrics?.sample_bouts ?? null;
    rows.push({
      slug: r.slug,
      name: r.display_name,
      live_bouts: r.bouts,
      packet_sample: sample,
      current: sample === r.bouts,
      method_total: pk.metrics ? Object.values(pk.metrics.method_distribution || {}).reduce((a, b) => a + b, 0) : null,
      round_total: pk.metrics ? Object.values(pk.metrics.round_distribution || {}).reduce((a, b) => a + b, 0) : null,
      packet_bout_count: pk.facts?.ufc_bout_count?.value ?? null,
    });
  }

  /* A packet whose slug is not in the directory at all: the referee was merged
   * away or renamed, and the file is now describing nobody. */
  const { readdirSync } = await import('node:fs');
  const orphans = readdirSync(new URL('../../data/referees/', import.meta.url))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((s) => !live.has(s));

  const stale = rows.filter((r) => !r.current);
  const methodMismatch = rows.filter((r) => r.method_total != null && r.method_total !== r.packet_sample);
  const countMismatch = rows.filter((r) => r.packet_bout_count !== r.live_bouts);

  if (asJson) {
    console.log(JSON.stringify({ packets: rows.length, orphans, stale, methodMismatch, countMismatch, rows }, null, 2));
  } else {
    console.log(`packets: ${rows.length}   orphaned: ${orphans.length}${orphans.length ? ` (${orphans.join(', ')})` : ''}`);
    console.log(`stale (sample != live bouts): ${stale.length}`);
    for (const s of stale) console.log(`  ${s.slug.padEnd(28)} packet ${String(s.packet_sample ?? '-').padStart(5)}  live ${String(s.live_bouts).padStart(5)}`);
    console.log(`method distribution not summing to sample: ${methodMismatch.length}`);
    for (const s of methodMismatch) console.log(`  ${s.slug.padEnd(28)} methods ${s.method_total} vs sample ${s.packet_sample}`);
    console.log(`headline bout count disagreeing with directory: ${countMismatch.length}`);
    for (const s of countMismatch) console.log(`  ${s.slug.padEnd(28)} packet ${s.packet_bout_count} vs live ${s.live_bouts}`);
  }

  process.exitCode = stale.length || orphans.length || methodMismatch.length || countMismatch.length ? 1 : 0;
};

main().catch((e) => { console.error('FATAL', e.message); process.exitCode = 2; });
