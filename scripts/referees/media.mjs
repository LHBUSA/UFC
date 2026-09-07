#!/usr/bin/env node
// Referee portrait sourcing. Same license gate as the fighter pipeline:
// Wikidata P18 or a name-locked Commons search hit, license restricted to
// CC0 / Public domain / CC BY / CC BY-SA, minimum source edge enforced, then
// sharp derivatives (avatar / card / profile, WebP, no aspect distortion)
// uploaded to the first-party ufc-media bucket. The packet records the full
// media metadata model plus every rejected candidate and its reason, so a
// monogram is provably "searched, nothing usable" rather than "not tried".
//
// Usage: node scripts/referees/media.mjs [--dry-run] [--limit N] [--slug s]
//                                         [--resume] [--report] [--force]
import { cli, deleteDerivatives, findLicensedImage, identityFacts, listPackets, makeDerivatives, mediaBlock, nowIso, readPacket, uploadDerivatives, wikiFetch, writeCombined, writePacket } from '../media/lib/subjects.mjs';

const args = cli();

async function mediaOne(packet) {
  if (packet.media?.derivatives && args.resume && !args.force) return { slug: packet.slug, status: 'skipped' };
  const facts = packet.identity?.wikidata ? await identityFacts(packet.identity.wikidata).catch(() => null) : null;
  const { image, rejected } = await findLicensedImage(packet.name, facts);
  const search = { searched_at: nowIso(), wikidata: packet.identity?.wikidata || null, rejected, found: Boolean(image) };
  if (!image) {
    /* Clear any derivative uploaded under an earlier, looser identity rule. */
    const purged = packet.media ? await deleteDerivatives("referees", packet.slug, { dry: args.dry }) : 0;
    packet.media = null;
    packet.media_search = search;
    if (!args.dry) writePacket('referees', packet.slug, packet);
    return { slug: packet.slug, status: 'no_licensed_image', rejected: rejected.length, purged };
  }
  const buf = await wikiFetch(image.url, { raw: true });
  if (!buf) return { slug: packet.slug, status: 'download_failed' };
  const derived = await makeDerivatives(buf, 'referees', packet.slug);
  const urls = await uploadDerivatives(derived.files, { dry: args.dry });
  packet.media = mediaBlock({ subjectType: 'referee', slug: packet.slug, name: packet.name, image, derived, urls, kind: 'portrait', confidence: image.method === 'wikidata_p18' ? 'high' : 'medium' });
  packet.media_search = search;
  if (!args.dry) writePacket('referees', packet.slug, packet);
  return { slug: packet.slug, status: 'ok', license: image.license, method: image.method, bytes: derived.files.reduce((n, f) => n + f.bytes, 0) };
}

const main = async () => {
  let packets = listPackets('referees');
  if (args.slug) packets = packets.filter((p) => p.slug === args.slug);
  packets = packets.slice(0, args.limit === Infinity ? packets.length : args.limit);
  console.log(`referee media: ${packets.length} subjects${args.dry ? ' (dry run)' : ''}`);
  const counts = {};
  const rows = [];
  for (const p of packets) {
    try {
      const fresh = readPacket('referees', p.slug) || p;
      const out = await mediaOne(fresh);
      counts[out.status] = (counts[out.status] || 0) + 1;
      rows.push(out);
      console.log(`  ${out.status.padEnd(18)} ${fresh.name}${out.license ? ` · ${out.license} (${out.method})` : ''}${out.rejected ? ` · ${out.rejected} rejected` : ''}`);
    } catch (e) {
      counts.error = (counts.error || 0) + 1;
      console.log(`  error              ${p.name}: ${String(e.message).slice(0, 140)}`);
    }
  }
  if (!args.dry) { const c = writeCombined(); console.log(`combined -> ${c.dest}`); }
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (args.report) console.log(JSON.stringify(rows, null, 2));
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
