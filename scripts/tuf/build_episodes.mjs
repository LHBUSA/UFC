#!/usr/bin/env node
/**
 * The episode layer of the TUF archive, and the bracket facts the official
 * recaps add.
 *
 *   node scripts/tuf/build_episodes.mjs --import <scout-dir> <paramount-cache-dir>
 *   node scripts/tuf/build_episodes.mjs [--check]
 *
 * --import copies reviewed evidence into scripts/tuf/evidence/:
 *   recaps/<slug>.json      facts extracted from UFC.com episode recaps, every
 *                           value carrying the exact sentence it came from
 *                           (quotes were validated as verbatim substrings of
 *                           the page text when extracted, 2026-09-12)
 *   paramount_plus.json     episode numbers and titles from the Paramount+
 *                           episode listing (no descriptions copied)
 *   recap_urls.json         which UFC.com recap covers which episode
 *
 * The default run builds from that evidence, reading nothing from the network:
 *
 *   web/data/tuf/episodes/<slug>.json   one file per season: episode number,
 *       title, recap link, the bouts each recap reports with canonical ids,
 *       in-house weigh-ins, fight-pick control and tournament events.
 *   web/data/tuf/official_recap_repairs.json   bracket corrections generated
 *       from the recaps' official result lines, applied by
 *       scripts/tuf/apply_official_repairs.mjs like the hand-written ledger.
 *
 * Dates. episode_number is where a bout aired. air_date stays null: no recap
 * states one, and the Paramount+ listing date is a listing date (it dates TUF
 * 33's finale nine months after the event), kept only as listing_date.
 * fight_date is never derived from any of these. A photo caption that says a
 * bout was filmed on a day is recorded as caption evidence, not as fight_date.
 *
 * Generated repairs follow the ledger policy: a field the bracket lacks is
 * filled; a field the official result line states differently is corrected
 * with the sentence attached; a result line that is LESS specific than the
 * bracket ("by decision" against "Decision (unanimous)") changes nothing; a
 * different WINNER is never applied and fails the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameMatch, pairMatch } from './lib/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const EVIDENCE = path.join(ROOT, 'scripts', 'tuf', 'evidence');
const OUT_DIR = path.join(DATA, 'episodes');
const GENERATED_LEDGER = path.join(DATA, 'official_recap_repairs.json');
const argv = process.argv.slice(2);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };

/* ---- import --------------------------------------------------------------- */

if (argv[0] === '--import') {
  const [scout, ppCache] = [argv[1], argv[2]];
  if (!scout || !ppCache) { console.error('usage: --import <scout-dir> <paramount-cache-dir>'); process.exit(1); }
  const extractDir = path.join(scout, 'extract');
  for (const f of fs.readdirSync(extractDir).filter((x) => x.endsWith('.extract.json'))) {
    const slug = f.replace('.extract.json', '');
    const d = readJson(path.join(extractDir, f));
    writeJson(path.join(EVIDENCE, 'recaps', `${slug}.json`), {
      _about: `Facts from UFC.com episode recaps for ${slug}. Every value carries the exact sentence it came from; quotes were checked as verbatim substrings of the recap text on 2026-09-12. Names are as the recap printed them.`,
      source_family: 'ufc_com_recap',
      retrieved: '2026-09-12',
      ...d,
    });
    console.log(`evidence/recaps/${slug}.json  ${d.episodes.length} episodes`);
  }
  const pp = {};
  for (const f of fs.readdirSync(ppCache).filter((x) => /^season_\d+\.json$/.test(x))) {
    const n = Number(f.match(/\d+/)[0]);
    const j = JSON.parse(fs.readFileSync(path.join(ppCache, f), 'utf8'));
    pp[`tuf-${n}`] = (j.result?.data || []).map((e) => ({
      episode_number: Number(e.episode_number), title: e.title, listing_date: e.airdate_iso ? e.airdate_iso.slice(0, 10) : null, content_id: e.content_id,
    }));
  }
  writeJson(path.join(EVIDENCE, 'paramount_plus.json'), {
    _about: 'Episode numbers and titles from the Paramount+ episode listing for The Ultimate Fighter (keyless JSON, retrieved 2026-09-12). listing_date is the listing\'s own date field: it matches original broadcast dates for early seasons and is wrong for recent ones (TUF 33\'s finale is listed on 2026-05-25), so it is never used as an air date. Descriptions are not copied.',
    source: 'https://www.paramountplus.com/shows/the-ultimate-fighter/',
    retrieved: '2026-09-12',
    seasons: pp,
  });
  const hist = readJson(path.join(scout, 'historical', 'inventory.json'));
  const modern = readJson(path.join(scout, 'modern', 'recap_coverage.json'));
  const urls = {};
  for (const [slug, v] of Object.entries(hist)) if (Object.keys(v.recaps || {}).length) urls[slug] = Object.fromEntries(Object.entries(v.recaps).map(([ep, u]) => [ep, u]));
  for (const r of modern) (urls[`tuf-${r.season}`] ||= {})[String(r.episode)] = r.url;
  writeJson(path.join(EVIDENCE, 'recap_urls.json'), {
    _about: 'Which UFC.com recap covers which episode, from the ufc.com sitemap and /tuf hub (2026-09-12). A season absent here had no recap found; an episode absent from a season had none.',
    retrieved: '2026-09-12',
    seasons: urls,
  });
  console.log(`evidence/paramount_plus.json  ${Object.keys(pp).length} seasons; evidence/recap_urls.json  ${Object.keys(urls).length} seasons`);
  process.exit(0);
}

/* ---- build ---------------------------------------------------------------- */

const CHECK = argv.includes('--check');
const inventory = readJson(path.join(DATA, 'seasons.json'));
const identity = readJson(path.join(DATA, 'identity.index.json'));
const pp = readJson(path.join(EVIDENCE, 'paramount_plus.json')).seasons;
const recapUrls = readJson(path.join(EVIDENCE, 'recap_urls.json')).seasons;
const recapDir = path.join(EVIDENCE, 'recaps');
const recaps = Object.fromEntries(fs.readdirSync(recapDir).filter((f) => f.endsWith('.json')).map((f) => [f.replace('.json', ''), readJson(path.join(recapDir, f))]));

const METHOD_FAMILY = (m) => {
  const s = String(m || '').toLowerCase();
  if (!s) return null;
  if (/technical\s+submission/.test(s)) return 'technical_submission';
  if (/verbal\s+submission/.test(s)) return 'submission';
  if (/submission|tap/.test(s)) return 'submission';
  if (/\btko\b|technical knockout/.test(s)) return 'tko';
  if (/\bko\b|knockout/.test(s)) return 'ko';
  if (/disqualif|\bdq\b/.test(s)) return 'dq';
  if (/decision/.test(s)) return 'decision';
  if (/draw/.test(s)) return 'draw';
  if (/no contest/.test(s)) return 'nc';
  return 'other';
};
const detail = (m) => (String(m || '').match(/\(([^)]+)\)/) || [])[1]?.toLowerCase().trim() || null;
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* Does the official method say something the bracket's does not, or say it
 * differently? A less specific official wording never overrides. */
function methodVerdict(bracketMethod, officialMethod, formalLine) {
  if (!officialMethod) return 'keep';
  if (!bracketMethod) return 'fill';
  const fb = METHOD_FAMILY(bracketMethod);
  const fo = METHOD_FAMILY(officialMethod);
  if (fb !== fo) return 'correct';
  const db = detail(bracketMethod);
  const dox = detail(officialMethod);
  if (!dox) return 'keep';                         // official is less specific
  if (!db) return 'fill';                          // official adds the detail
  /* Same outcome, both detailed. Scorecards are never traded for a bare
   * "unanimous", and a paraphrase of recap prose ("kicks" for "head kick")
   * never replaces a detail; only a formal "Official Result" line that names
   * a different technique does. */
  if (/\d/.test(db)) return 'keep';
  if (!formalLine) return 'keep';
  const aw = new Set(fold(db).split(' '));
  const bw = new Set(fold(dox).split(' '));
  const overlap = [...bw].filter((w) => aw.has(w) && w.length > 2).length;
  return overlap >= Math.min(aw.size, bw.size) ? 'keep' : 'correct';
}

const seasonFile = (slug) => path.join(DATA, 'seasons', `${slug}.json`);

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
/* Only for pairing a recap bout with its bracket row inside one season, and
 * only ever alongside an exact match on the other corner. Never used to decide
 * who a fighter is. */
function looseName(x, y) {
  const a = fold(x).split(' ');
  const b = fold(y).split(' ');
  if (a.length < 2 || b.length < 2) return false;
  const [ga, sa] = [a[0], a[a.length - 1]];
  const [gb, sb] = [b[0], b[b.length - 1]];
  const givenOk = ga === gb || (Math.min(ga.length, gb.length) >= 3 && (ga.startsWith(gb) || gb.startsWith(ga)))
    || (ga.slice(0, 4) === gb.slice(0, 4) && Math.min(ga.length, gb.length) >= 5);
  const surnameOk = sa === sb || (sa.length >= 5 && editDistance(sa, sb) <= 2);
  return givenOk && surnameOk;
}

function bracketBouts(detail) {
  const out = [];
  for (const div of detail.bracket || []) for (const st of div.stages) for (const b of st.bouts) out.push({ b, weight_class: div.weight_class, stage: st.stage });
  return out;
}

function idFor(slug, name, bout) {
  const direct = identity[slug]?.[name];
  if (direct) return direct;
  if (bout) {
    for (const side of ['a', 'b']) if (nameMatch(name, bout[side]).same) return bout[`${side}_fighter_id`] || identity[slug]?.[bout[side]] || null;
  }
  return null;
}

const generated = [];
const problems = [];
/* Idempotent: compare each bout as it stood BEFORE this generator's own
 * earlier repairs, so a second run regenerates the same ledger instead of
 * finding nothing left to change and emptying it. */
const previous = new Map((fs.existsSync(GENERATED_LEDGER) ? readJson(GENERATED_LEDGER).repairs : []).map((r) => [r.id, r]));
function beforeGenerated(id, bout) {
  const prev = previous.get(id);
  if (!prev) return bout;
  const applied = Object.entries(prev.set).every(([k, v]) => JSON.stringify(bout[k] ?? null) === JSON.stringify(v ?? null));
  return applied ? { ...bout, ...prev.expect } : bout;
}
const stats = { seasons: 0, episodes: 0, with_title: 0, with_recap: 0, recap_facts: 0, bouts: 0, matched: 0, weigh_ins: 0, weights: 0, misses: 0, events: 0, caption_dates: 0 };

for (const row of inventory.seasons) {
  const slug = row.slug;
  const titles = pp[slug] || [];
  const urls = recapUrls[slug] || {};
  const facts = recaps[slug];
  if (!titles.length && !Object.keys(urls).length && !facts) continue;
  const detail = fs.existsSync(seasonFile(slug)) ? readJson(seasonFile(slug)) : {};
  const bouts = bracketBouts(detail);

  const numbers = new Set([
    ...titles.filter((t) => !/finale/i.test(t.title)).map((t) => t.episode_number),
    ...Object.keys(urls).map(Number),
    ...(facts?.episodes || []).map((e) => e.episode_number),
  ]);
  const finale = titles.find((t) => /finale/i.test(t.title));
  const episodes = [];
  for (const n of [...numbers].filter(Number.isFinite).sort((a, b) => a - b)) {
    const t = titles.find((x) => x.episode_number === n && !/finale/i.test(x.title));
    const f = facts?.episodes.find((e) => e.episode_number === n);
    const ep = {
      episode_number: n,
      title: t?.title ?? null,
      title_source: t ? 'paramount_plus' : null,
      air_date: null,
      listing_date: t?.listing_date ?? null,
      recap_url: f?.recap_url || urls[String(n)] || null,
      recap_published: f?.recap_published ? f.recap_published.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : null,
      recap_byline_date: f?.byline_date_text ?? null,
    };
    if (f) {
      ep.bouts = f.bouts.map((x) => {
        /* The same two people can meet twice in one season (Bryant and McCray
         * on TUF 11: episode 5, then the semifinal). A recap bout is matched to
         * the bracket bout of its stated stage, else of its episode, else to
         * the only candidate; two candidates and no way to choose is no match. */
        const xIds = [idFor(slug, x.a, null), idFor(slug, x.b, null)];
        let cands = bouts.filter(({ b }) => pairMatch(x.a, x.b, b.a, b.b).same || (b.a_fighter_id && b.b_fighter_id && xIds.every(Boolean) && [...xIds].sort().join() === [b.a_fighter_id, b.b_fighter_id].sort().join()));
        /* Recaps spell castmates their own way (Vincent/Vince Murdock,
         * Jeff/Jefferson Creighton, Chabaan/Chaaban). Inside one season's
         * bracket, with the other corner matching exactly and the stage
         * agreeing, that is the same bout. */
        if (!cands.length) {
          cands = bouts.filter(({ b, stage }) => (!x.stage || x.stage === stage) && (
            (nameMatch(x.a, b.a).same && looseName(x.b, b.b)) || (nameMatch(x.b, b.b).same && looseName(x.a, b.a))
            || (nameMatch(x.a, b.b).same && looseName(x.b, b.a)) || (nameMatch(x.b, b.a).same && looseName(x.a, b.b))));
        }
        const hit = cands.length === 1 ? cands[0]
          : cands.find((c) => x.stage && c.stage === x.stage) || cands.find((c) => c.b.episode === n) || null;
        const target = hit?.b || null;
        const aId = idFor(slug, x.a, target);
        const bId = idFor(slug, x.b, target);
        const out = {
          a: x.a, b: x.b,
          ...(aId ? { a_fighter_id: aId } : {}), ...(bId ? { b_fighter_id: bId } : {}),
          weight_class: x.weight_class ?? hit?.weight_class ?? null,
          stage: x.stage ?? null,
          bracket: hit ? { weight_class: hit.weight_class, stage: hit.stage, a: target.a, b: target.b } : null,
          result: x.result ? {
            winner: x.result.winner ?? null,
            ...(x.result.winner && idFor(slug, x.result.winner, target) ? { winner_fighter_id: idFor(slug, x.result.winner, target) } : {}),
            method: x.result.method ?? null, round: x.result.round ?? null, time: x.result.time ?? null,
            ...(x.result.contradiction ? { contradiction: x.result.contradiction } : {}),
          } : null,
          weigh_ins: (x.weigh_ins || []).map((w) => {
            const fid = idFor(slug, w.fighter, target);
            return {
              fighter: w.fighter, ...(fid ? { fighter_id: fid } : {}),
              weight_lbs: w.weight_lbs ?? null, ...(w.weight_text ? { weight_text: w.weight_text } : {}),
              missed_weight: Boolean(w.missed_weight), limit_lbs: w.limit_lbs ?? null,
              ...(w.made_weight_on_retry ? { made_weight_on_retry: true } : {}),
              episode_number: n, source_url: ep.recap_url,
            };
          }),
          fight_pick: x.fight_pick?.chosen_by ? { chosen_by: x.fight_pick.chosen_by } : null,
          caption_filming_dates: (x.caption_filming_dates || []).map((c) => c.date_text),
        };
        stats.bouts += 1;
        if (hit) stats.matched += 1;
        stats.weigh_ins += out.weigh_ins.length;
        stats.weights += out.weigh_ins.filter((w) => w.weight_lbs != null).length;
        stats.misses += out.weigh_ins.filter((w) => w.missed_weight).length;
        stats.caption_dates += out.caption_filming_dates.length;

        /* ---- bracket corrections from the official result line ---- */
        if (hit && x.result) {
          const r = x.result;
          const repairId = `recap/${slug}/ep${n}/${fold(target.a).replace(/ /g, '-')}-${fold(target.b).replace(/ /g, '-')}`;
          const b = beforeGenerated(repairId, target);
          if (r.winner && b.winner && !nameMatch(r.winner, b.winner).same && !looseName(r.winner, b.winner) && idFor(slug, r.winner, b) !== idFor(slug, b.winner, b)) {
            problems.push(`${slug} ep${n}: recap winner ${r.winner} vs bracket winner ${b.winner} (${b.a} vs ${b.b}) — not applied`);
          } else {
            const set = {};
            const expect = {};
            if (b.episode !== n) {
              set.episode = n; expect.episode = b.episode ?? null;
              if (b.episode != null) problems.push(`${slug}: ${b.a} vs ${b.b} bracket episode ${b.episode} -> recap episode ${n} (corrected)`);
            }
            const mv = methodVerdict(b.method, r.method, /^\s*official result/i.test(r.quote || ''));
            if (mv === 'fill' || mv === 'correct') { set.method = r.method; expect.method = b.method ?? null; }
            if (r.round != null && b.round !== r.round) { set.round = r.round; expect.round = b.round ?? null; }
            if (r.time && b.time !== r.time) { set.time = r.time; expect.time = b.time ?? null; }
            if (!b.winner && r.winner) problems.push(`${slug}: ${b.a} vs ${b.b} has no bracket winner; recap says ${r.winner} — left for review`);
            if (Object.keys(set).length) {
              generated.push({
                id: repairId,
                season: slug, op: 'patch_bout', kind: Object.keys(set).some((k) => expect[k] != null) ? 'official_correction' : 'official_addition',
                bout: { weight_class: hit.weight_class, stage: hit.stage, a: b.a, b: b.b },
                expect, set,
                source: {
                  url: f.recap_url, family: 'ufc_com_recap', published_on_site: ep.recap_published, retrieved: '2026-09-12',
                  quote: [r.quote, r.round_quote].filter(Boolean).join(' … ') || null,
                },
                ...(r.contradiction ? { add_conflict: { field: `${hit.weight_class}_${hit.stage}`, kind: 'official_source_contradicts_itself', detail: `${b.a} vs ${b.b}: ${r.contradiction}`, source_urls: [f.recap_url], retrieved: '2026-09-12' } } : {}),
              });
            }
          }
        }
        return out;
      });
      ep.fight_pick_control = f.bouts.map((x) => x.fight_pick?.chosen_by).filter(Boolean)[0] ?? null;
      ep.events = (f.events || []).map((e) => ({
        type: e.type, text: e.text,
        fighters: e.fighters || [],
        fighter_ids: (e.fighters || []).map((nm) => idFor(slug, nm, null)),
      }));
      stats.events += ep.events.length;
      stats.recap_facts += 1;
    }
    if (ep.title) stats.with_title += 1;
    if (ep.recap_url) stats.with_recap += 1;
    episodes.push(ep);
  }
  const file = path.join(OUT_DIR, `${slug}.json`);
  const doc = {
    slug,
    _about: 'Episode layer for this season. episode_number is where a bout aired; air_date is null because no source states one; listing_date is the Paramount+ listing date and is not a broadcast date; fight dates are never derived from episodes. Bouts reference the bracket bout they report; results in the bracket are the single copy, and differences found in the recaps are applied through the official ledger with the sentence attached.',
    sources: {
      titles: titles.length ? 'scripts/tuf/evidence/paramount_plus.json' : null,
      recaps: facts ? `scripts/tuf/evidence/recaps/${slug}.json` : Object.keys(urls).length ? 'scripts/tuf/evidence/recap_urls.json (links only; facts not extracted)' : null,
    },
    ...(finale ? { finale_broadcast: { title: finale.title, listing_date: finale.listing_date } } : {}),
    ...(facts?.missing_episodes?.length ? { missing_recaps: facts.missing_episodes.map((m) => ({ episode_number: m.episode_number, why: m.why })) } : {}),
    episodes,
  };
  stats.seasons += 1;
  stats.episodes += episodes.length;
  if (!CHECK) writeJson(file, doc);
}

const ledger = {
  _about: 'GENERATED by scripts/tuf/build_episodes.mjs from scripts/tuf/evidence/recaps — do not edit. Bracket corrections and additions taken from the official result lines of UFC.com episode recaps. Applied with the hand-written ledger by scripts/tuf/apply_official_repairs.mjs.',
  _policy: readJson(path.join(DATA, 'official_repairs.json'))._policy,
  repairs: generated,
};
if (!CHECK) writeJson(GENERATED_LEDGER, ledger);

console.log(JSON.stringify(stats));
console.log(`generated repairs: ${generated.length} (${generated.filter((g) => g.kind === 'official_correction').length} corrections, ${generated.filter((g) => g.kind === 'official_addition').length} additions)`);
for (const p of problems) console.log(`  ! ${p}`);
if (problems.some((p) => p.includes('recap winner'))) process.exitCode = 1;
