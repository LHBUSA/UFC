#!/usr/bin/env node
// Hall of Fame inductee enrichment.
//
//   curated seed (web/lib/hof.ts, wing + induction class per the official UFC
//   Hall of Fame) -> Wikipedia summary (context-checked and name-locked) ->
//   Wikidata identity facts -> data/hall-of-fame/<slug>.json
//
// Fighter-specific fields are never forced onto contributors: an executive,
// matchmaker or broadcaster gets role/organisation fields instead of a record.
// Every claim carries value, source, method and verified_at; an unknown
// induction year stays null rather than being guessed.
//
// Usage: node scripts/hof/enrich.mjs [--dry-run] [--limit N] [--slug s]
//                                     [--resume] [--report] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, claim, cli, identityFacts, nowIso, readPacket, resolveWiki, writeCombined, writePacket } from '../media/lib/subjects.mjs';

const args = cli();
/* Fighters must read as martial artists; contributors as sport figures. */
const FIGHTER_CONTEXT = /mixed martial art|\bMMA\b|UFC|kickbox|jiu-jitsu|wrestler|fighter/i;
const CONTRIBUTOR_CONTEXT = /Ultimate Fighting|UFC|mixed martial art|\bMMA\b|promoter|executive|matchmaker|commentator|referee|producer|commission/i;

/* Read the curated seed straight out of the TypeScript module so the web and
 * these scripts can never drift apart. */
function loadSeed() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'lib', 'hof.ts'), 'utf8');
  const start = src.indexOf('export const HOF_INDUCTEES');
  const end = src.indexOf('export const HOF_BY_SLUG');
  if (start < 0 || end < 0) throw new Error('HOF_INDUCTEES block not found in web/lib/hof.ts');
  const body = src.slice(start, end).replace('export const HOF_INDUCTEES: HofInductee[] =', 'return');
  const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[“”"]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const W = (name, wing, inducted, nationality, weightClasses, legacy, extra = {}) => ({ slug: slugify(name), name, wing, inducted, nationality, weightClasses, titles: [], achievements: [], signatureFights: [], legacy, ...extra });
  // eslint-disable-next-line no-new-func
  return new Function('W', body)(W);
}

async function enrichOne(seed) {
  const existing = readPacket('hall-of-fame', seed.slug);
  if (args.resume && existing?.identity?.checked_at && !args.force) return { slug: seed.slug, status: 'skipped' };
  const isContributor = seed.wing === 'contributor';
  const ctx = isContributor ? CONTRIBUTOR_CONTEXT : FIGHTER_CONTEXT;
  const wiki = await resolveWiki(seed.name.replace(/[“”"]/g, ''), ctx).catch(() => null);
  const qid = wiki?.wikibase_item || null;
  const facts = qid ? await identityFacts(qid).catch(() => null) : null;
  const wikiUrl = wiki?.content_urls?.desktop?.page || (wiki?.title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.title.replace(/ /g, '_'))}` : null);
  const seedSrc = 'PropBetEdge curated Hall of Fame seed (official UFC Hall of Fame wings)';
  const HOF_URL = 'https://www.ufc.com/ufc-hall-of-fame';

  const common = {
    full_name: claim(wiki?.title ? wiki.title.replace(/\s*\(.*\)$/, '') : seed.name, wikiUrl || seedSrc, wiki ? 'wikipedia_title' : 'curated'),
    wing: claim(seed.wing, HOF_URL, 'official_hof_wing'),
    induction_year: claim(seed.inducted, HOF_URL, 'official_hof_class'),
    nationality: claim(facts?.nationality || seed.nationality, facts?.nationality ? `https://www.wikidata.org/wiki/${qid}` : seedSrc, facts?.nationality ? 'wikidata_P27' : 'curated'),
    date_of_birth: claim(facts?.date_of_birth, qid ? `https://www.wikidata.org/wiki/${qid}` : null, 'wikidata_P569'),
    description: claim(facts?.description, qid ? `https://www.wikidata.org/wiki/${qid}` : null, 'wikidata_description'),
    occupations: claim(facts?.occupations, qid ? `https://www.wikidata.org/wiki/${qid}` : null, 'wikidata_P106'),
    legacy_summary: claim(seed.legacy, seedSrc, 'curated'),
    official_hof_url: claim(HOF_URL, HOF_URL, 'official'),
  };
  /* Contributors get role fields; fighters get competitive fields. Neither
   * inherits the other's shape. */
  const role = isContributor
    ? { role: claim(seed.role, seedSrc, 'curated'), contributions: claim(seed.achievements, seedSrc, 'curated') }
    : {
      weight_classes: claim(seed.weightClasses, seedSrc, 'curated'),
      championships: claim(seed.titles, seedSrc, 'curated'),
      notable_achievements: claim(seed.achievements, seedSrc, 'curated'),
      signature_fights: claim(seed.signatureFights, seedSrc, 'curated'),
    };

  const packet = {
    subject_type: 'hof_inductee', slug: seed.slug, name: seed.name, wing: seed.wing,
    identity: { checked_at: nowIso(), wikipedia: wikiUrl, wikidata: qid, resolved: Boolean(wiki), note: wiki ? null : 'No English Wikipedia article passed the name lock and context check.' },
    facts: { ...common, ...role },
    bio: { text: wiki?.extract || null, source_url: wikiUrl, source_name: wiki ? 'English Wikipedia' : null, license: wiki ? 'CC BY-SA 4.0' : null, verified_at: wiki ? nowIso() : null },
    archive: existing?.archive || null,
    media: existing?.media || null,
    media_search: existing?.media_search || null,
    sources: [HOF_URL, wikiUrl, qid ? `https://www.wikidata.org/wiki/${qid}` : null].filter(Boolean),
  };
  if (!args.dry) writePacket('hall-of-fame', seed.slug, packet);
  return { slug: seed.slug, status: wiki ? 'enriched' : 'curated_only', qid, bio: Boolean(wiki?.extract) };
}

const main = async () => {
  let seeds = loadSeed();
  if (args.slug) seeds = seeds.filter((s) => s.slug === args.slug);
  seeds = seeds.slice(0, args.limit === Infinity ? seeds.length : args.limit);
  console.log(`hall of fame enrichment: ${seeds.length} inductees${args.dry ? ' (dry run)' : ''}`);
  const counts = {}; const rows = [];
  for (const s of seeds) {
    try {
      const out = await enrichOne(s);
      counts[out.status] = (counts[out.status] || 0) + 1;
      rows.push(out);
      console.log(`  ${out.status.padEnd(13)} ${s.name}${out.qid ? ` (${out.qid})` : ''}${out.bio ? ' +bio' : ''}`);
    } catch (e) {
      counts.error = (counts.error || 0) + 1;
      console.log(`  error         ${s.name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (!args.dry) { const c = writeCombined(); console.log(`combined -> ${c.dest} (referees ${c.referees}, hof ${c.hof})`); }
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (args.report) console.log(JSON.stringify(rows, null, 2));
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
