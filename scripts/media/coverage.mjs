#!/usr/bin/env node
// Media + bio coverage reports for the referee and Hall of Fame enrichment.
// Writes docs/REFEREE_MEDIA_COVERAGE.md and docs/HOF_MEDIA_COVERAGE.md with a
// per-subject row (photo status, source, license, derivative, bio status,
// canonical link, review status) and a summary block. Read-only over the
// packets — it never touches production data.
//
// Usage: node scripts/media/coverage.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, listPackets, nowIso } from './lib/subjects.mjs';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const yn = (b) => (b ? 'yes' : 'no');

function mediaCells(p) {
  const m = p.media;
  if (!m) {
    const n = p.media_search?.rejected?.length ?? 0;
    return { status: p.media_search ? `none (${n} rejected)` : 'not searched', source: '—', license: '—', derivative: '—', review: p.media_search ? 'searched · no free license' : 'pending' };
  }
  return {
    status: 'portrait',
    source: `[Commons](${m.source_page_url})`,
    license: `${m.license_type}${m.author ? ` · ${esc(m.author).slice(0, 40)}` : ''}`,
    derivative: Object.keys(m.derivatives || {}).join(', ') || '—',
    review: m.commercial_display_status,
  };
}

function refereeReport() {
  const ps = listPackets('referees').sort((a, b) => (b.facts?.ufc_bout_count?.value || 0) - (a.facts?.ufc_bout_count?.value || 0));
  const rows = ps.map((p) => {
    const mc = mediaCells(p);
    const bio = p.bio?.text ? `sourced (${p.bio.source_name})` : 'archive-derived';
    return `| ${esc(p.name)} | ${p.facts?.ufc_bout_count?.value ?? '—'} | ${mc.status} | ${mc.source} | ${mc.license} | ${mc.derivative} | ${bio} | ${p.identity?.resolved ? `[wiki](${p.identity.wikipedia})` : 'none'} | ${mc.review} |`;
  });
  const withPhoto = ps.filter((p) => p.media).length;
  const withBio = ps.filter((p) => p.bio?.text).length;
  const withMetrics = ps.filter((p) => p.metrics).length;
  const searched = ps.filter((p) => p.media_search).length;
  return `# Referee media and bio coverage

Generated ${nowIso()} by \`scripts/media/coverage.mjs\`.

Sourcing follows the same discipline as the fighter portrait pipeline: an image
is only stored when Wikidata P18 or a name-locked Wikimedia Commons search finds
a file under a commercially reusable license (CC0, Public domain, CC BY, CC BY-SA).
No Getty previews, no watermarked media, no news-site hotlinks, no social profile
images. Derivatives are generated with sharp and hosted first-party in the
\`ufc-media\` bucket; nothing hotlinks Wikimedia.

## Summary

| Metric | Count | Of |
| --- | --- | --- |
| Referees indexed | ${ps.length} | ${ps.length} |
| Media search attempted | ${searched} | ${ps.length} |
| Licensed portrait stored | ${withPhoto} | ${ps.length} |
| Externally sourced biography | ${withBio} | ${ps.length} |
| PBE-derived assignment metrics | ${withMetrics} | ${ps.length} |

**Why portrait coverage is low.** Professional MMA officials are rarely
photographed under a free license. Every referee below was searched against
Wikidata and Commons; the rejections are recorded per subject in
\`data/referees/<slug>.json\` under \`media_search.rejected\` with the reason
(usually "no freely licensed candidate" or a non-commercial license). Raising
coverage further requires licensed press media, not a weaker license gate.

## Subjects

| Referee | Bouts | Photo | Source | License | Derivatives | Bio | Reference | Review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function hofReport() {
  const ps = listPackets('hall-of-fame').filter((p) => p.subject_type === 'hof_inductee').sort((a, b) => a.wing.localeCompare(b.wing) || a.name.localeCompare(b.name));
  const rows = ps.map((p) => {
    const mc = mediaCells(p);
    const bio = p.bio?.text ? `sourced (${p.bio.source_name})` : 'curated legacy only';
    const link = p.archive?.archive_status === 'linked' ? `linked (${p.archive.method})` : 'missing · backfill candidate';
    return `| ${esc(p.name)} | ${p.wing} | ${mc.status} | ${mc.source} | ${mc.license} | ${mc.derivative} | ${bio} | ${link} | ${mc.review} |`;
  });
  const withPhoto = ps.filter((p) => p.media).length;
  const withBio = ps.filter((p) => p.bio?.text).length;
  const linked = ps.filter((p) => p.archive?.archive_status === 'linked').length;
  const fightsFile = path.join(ROOT, 'data', 'hall-of-fame', 'fights.json');
  const fights = fs.existsSync(fightsFile) ? JSON.parse(fs.readFileSync(fightsFile, 'utf8')).fights : [];
  const fightLinks = fights.reduce((n, f) => n + f.fighters.filter((x) => x.fighter_id).length, 0);
  const fightResults = fights.filter((f) => f.result).length;
  return `# Hall of Fame media and data coverage

Generated ${nowIso()} by \`scripts/media/coverage.mjs\`.

Same license gate as the fighter and referee pipelines (CC0, Public domain,
CC BY, CC BY-SA only), same first-party hosting, same name-locked identity
check — an article title has to carry the inductee's surname and an agreeing
given name, so "Royce Gracie" can never bind to "Rickson Gracie".

## Summary

| Metric | Count | Of |
| --- | --- | --- |
| Inductees | ${ps.length} | ${ps.length} |
| Licensed portrait stored | ${withPhoto} | ${ps.length} |
| Externally sourced biography | ${withBio} | ${ps.length} |
| Linked to a canonical fighter row | ${linked} | ${ps.filter((p) => p.wing !== 'contributor').length} fighters |
| Fight Wing bouts modelled | ${fights.length} | ${fights.length} |
| Fight Wing fighter links resolved | ${fightLinks} | ${fights.length * 2} |
| Fight Wing results verified from our archive | ${fightResults} | ${fights.length} |

Inductees marked *missing* have no canonical row in the loaded fighter archive.
They are recorded as backfill candidates in
\`data/hall-of-fame/_fighter-map.json\`; no fighter row was ever created to
satisfy a link.

## Inductees

| Inductee | Wing | Photo | Source | License | Derivatives | Bio | Archive link | Review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

const out = [];
for (const [file, body] of [['REFEREE_MEDIA_COVERAGE.md', refereeReport()], ['HOF_MEDIA_COVERAGE.md', hofReport()]]) {
  const dest = path.join(ROOT, 'docs', file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  out.push(dest);
}
console.log(out.map((o) => `wrote ${path.relative(ROOT, o)}`).join('\n'));
