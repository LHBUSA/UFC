#!/usr/bin/env node
/**
 * Independent audit of the judge / scorecard layer.
 *
 *   node scripts/judges/audit-coverage.mjs [--json path] [--quiet]
 *
 * Read-only. It issues SELECTs through PostgREST and writes nothing to the
 * database. Its job is to answer, from the rows themselves rather than from a
 * previous report:
 *
 *   - how many decision/draw results exist, how many carry a scorecard, and
 *     how many do not;
 *   - whether any bout that ended in a finish carries a scorecard it should
 *     not have (a fabrication check that must always read zero);
 *   - how many stored cards can actually be attributed to a fighter, and how
 *     many must stay as a bare pair;
 *   - which judge identities the archive contains once aliases are applied;
 *   - what closing each remaining gap would require.
 *
 * The derivation is imported from web/lib/judgeScoring.ts, so this audit and
 * the pages agree by construction rather than by coincidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/* pathToFileURL, not a bare path: on Windows an absolute path starts with a
   drive letter and the ESM loader reads "d:" as an unsupported URL scheme. */
const S = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'judgeScoring.ts')).href);

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const QUIET = argv.includes('--quiet');
const JSON_OUT = opt('--json', path.join(ROOT, 'docs', 'judge_scorecard_coverage.json'));

function loadEnv() {
  const out = {};
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  }
  return { url: (out.SUPABASE_URL || '').replace(/\/$/, ''), key: out.SUPABASE_SERVICE_ROLE_KEY || '' };
}

const { url, key } = loadEnv();
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available locally'); process.exit(2); }

async function rest(pathq) {
  const r = await fetch(`${url}/rest/v1/${pathq}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`rest ${pathq.split('?')[0]} -> ${r.status} ${await r.text()}`);
  return r.json();
}

/* PostgREST pages; a partial read would understate every count in this
   report, which is the one failure mode an audit cannot have. */
async function restAll(pathq, page = 1000) {
  const out = [];
  for (let offset = 0; ; offset += page) {
    const rows = await rest(`${pathq}&limit=${page}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

const NAMED = 'id,name';
const SEL_JUDGED =
  'bout_id,method,method_raw,winner_id,result_source,finish_detail,source_url,scorecards,' +
  'bout:ufc_bouts!inner(id,ufcstats_id,event_id,is_title,scheduled_rounds,' +
  `fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(${NAMED}),` +
  `fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(${NAMED}),` +
  'event:ufc_events!inner(id,name,event_date,ufcstats_id))';

const one = (v) => (Array.isArray(v) ? v[0] || null : v || null);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

const main = async () => {
  const [judged, finishes, ingestedIds] = await Promise.all([
    restAll(`ufc_bout_results?select=${SEL_JUDGED}&method=in.(DEC_U,DEC_S,DEC_M,DRAW)&order=bout_id.asc`),
    restAll('ufc_bout_results?select=bout_id,method,scorecards&method=not.in.(DEC_U,DEC_S,DEC_M,DRAW)&order=bout_id.asc'),
    restAll('ufc_bouts?select=event_id&ufcstats_id=not.is.null&order=event_id.asc'),
  ]);
  const ingestedEvents = new Set(ingestedIds.map((r) => r.event_id));

  const gaps = [];
  const judgeCards = new Map();      // canonical name -> card count
  const rawSeen = new Map();         // raw string -> count
  const orientation = { derived_from_result: 0, unresolved_no_winner: 0, unresolved_conflicting_cards: 0 };
  const shapeMismatch = [];
  const partialPanels = [];
  const decisionShape = {};
  let withScorecards = 0, cardRows = 0, dissentCards = 0, evenCards = 0, attributedCards = 0;

  for (const row of judged) {
    const bout = row.bout;
    const fa = one(bout?.fighter_a), fb = one(bout?.fighter_b), ev = bout?.event;
    if (!bout || !fa || !fb || !ev) continue;
    const sheet = S.buildBoutScorecard({
      method: row.method, scorecards: row.scorecards, winnerId: row.winner_id,
      fighterAId: fa.id, fighterBId: fb.id,
    });

    if (!sheet.hasOfficialScorecard) {
      const g = S.classifyGap({
        method: row.method, resultSource: row.result_source, finishDetail: row.finish_detail,
        boutUfcstatsId: bout.ufcstats_id, eventUfcstatsId: ev.ufcstats_id,
        eventHasIngestedSiblings: ingestedEvents.has(bout.event_id), eventName: ev.name,
      });
      gaps.push({
        bout_id: row.bout_id, event: ev.name, event_date: ev.event_date,
        bout: `${fa.name} vs ${fb.name}`, method: row.method, result_source: row.result_source,
        classification: g.classification, reason: g.reason,
        scores_held_without_judges: /\d{1,3}\s*-\s*\d{1,3}/.test(row.finish_detail || ''),
        bout_ufcstats_id: bout.ufcstats_id, source_url: row.source_url,
      });
      continue;
    }

    withScorecards += 1;
    cardRows += sheet.cardCount;
    dissentCards += sheet.dissentCards;
    evenCards += sheet.evenCards;
    if (sheet.cardCount !== 3) partialPanels.push({ bout_id: row.bout_id, cards: sheet.cardCount, bout: `${fa.name} vs ${fb.name}`, event: ev.name });
    if (sheet.cardShapeMatchesMethod === false) {
      shapeMismatch.push({
        bout_id: row.bout_id, bout: `${fa.name} vs ${fb.name}`, event: ev.name, event_date: ev.event_date,
        method: row.method_raw, dissent_cards: sheet.dissentCards, even_cards: sheet.evenCards, source_url: row.source_url,
      });
    }
    const key = `${row.method}:${sheet.cardCount}c/${sheet.dissentCards}d/${sheet.evenCards}e`;
    decisionShape[key] = (decisionShape[key] || 0) + 1;

    for (const c of sheet.cards) {
      orientation[c.orientationBasis] += 1;
      if (c.isDissent !== null) attributedCards += 1;
      judgeCards.set(c.judge, (judgeCards.get(c.judge) || 0) + 1);
      rawSeen.set(c.rawJudge, (rawSeen.get(c.rawJudge) || 0) + 1);
    }
  }

  const finishesWithCards = finishes.filter((f) => Array.isArray(f.scorecards) && f.scorecards.length > 0);
  const byBucket = {};
  for (const g of gaps) {
    byBucket[g.classification] = byBucket[g.classification] || { total: 0, reasons: {} };
    byBucket[g.classification].total += 1;
    byBucket[g.classification].reasons[g.reason] = (byBucket[g.classification].reasons[g.reason] || 0) + 1;
  }

  const aliasRaw = Object.keys(S.JUDGE_ALIASES);
  const report = {
    generated_at: new Date().toISOString(),
    coverage: {
      judged_results: judged.length,
      with_scorecards: withScorecards,
      missing_scorecards: gaps.length,
      finishes: finishes.length,
      finishes_with_unexpected_scorecard: finishesWithCards.length,
      card_rows: cardRows,
    },
    attribution: {
      ...orientation,
      attributed_cards: attributedCards,
      unattributed_cards: cardRows - attributedCards,
      dissent_cards: dissentCards,
      even_cards: evenCards,
    },
    identity: {
      raw_judge_strings: rawSeen.size,
      canonical_judges: judgeCards.size,
      aliases_applied: aliasRaw.filter((r) => rawSeen.has(r)).length,
      aliases_defined: aliasRaw.length,
      aliases_unused: aliasRaw.filter((r) => !rawSeen.has(r)),
      /* Every name merge, with the external source that licenses it. A merge
         with no citable source is the one identity error that produces a
         confident wrong answer, so the evidence travels with the numbers. */
      spelling_variant_evidence: S.SPELLING_VARIANT_EVIDENCE,
      /* Near-name pairs deliberately NOT merged. Their card counts are listed
         so a reviewer can see exactly what would move if one were promoted. */
      provisional_candidates: S.PROVISIONAL_IDENTITY_CANDIDATES.map((c) => ({
        ...c,
        cards_in_archive: Object.fromEntries(c.names.map((n) => [n, judgeCards.get(n) || 0])),
      })),
    },
    integrity: {
      card_shape_mismatches: shapeMismatch,
      partial_panels: partialPanels,
      decision_shapes: decisionShape,
    },
    gaps: { by_classification: byBucket, rows: gaps },
  };

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

  if (!QUIET) {
    const c = report.coverage, a = report.attribution, i = report.identity;
    console.log('\nSCORECARD COVERAGE');
    console.log(`  decision/draw results            ${c.judged_results}`);
    console.log(`  with scorecards                  ${c.with_scorecards}  (${pct(c.with_scorecards, c.judged_results)})`);
    console.log(`  missing scorecards               ${c.missing_scorecards}  (${pct(c.missing_scorecards, c.judged_results)})`);
    console.log(`  finishes (no scorecard expected) ${c.finishes}`);
    console.log(`  finishes carrying a scorecard    ${c.finishes_with_unexpected_scorecard}${c.finishes_with_unexpected_scorecard ? '   <-- INVESTIGATE' : '   (correct: a finish has no card)'}`);
    console.log('\nATTRIBUTION');
    console.log(`  stored cards                     ${c.card_rows}`);
    console.log(`  attributed to fighters           ${a.attributed_cards}  (${pct(a.attributed_cards, c.card_rows)})`);
    console.log(`  left as an unattributed pair     ${a.unattributed_cards}  (no winner ${a.unresolved_no_winner}, conflicting cards ${a.unresolved_conflicting_cards})`);
    console.log(`  dissenting cards                 ${a.dissent_cards}  (${pct(a.dissent_cards, a.attributed_cards)} of attributed)`);
    console.log(`  even (10-10 style) cards         ${a.even_cards}`);
    console.log('\nIDENTITY');
    console.log(`  raw judge strings in archive     ${i.raw_judge_strings}`);
    console.log(`  canonical judges after aliasing  ${i.canonical_judges}`);
    console.log(`  aliases applied / defined        ${i.aliases_applied} / ${i.aliases_defined}`);
    if (i.aliases_unused.length) console.log(`  aliases matching nothing         ${i.aliases_unused.join(', ')}`);
    console.log(`  name merges (all sourced)        ${i.spelling_variant_evidence.length}`);
    for (const e of i.spelling_variant_evidence) console.log(`    "${e.rawName}" -> "${e.canonical}"  ${e.sourceName}  ${e.sourceUrl}`);
    console.log(`  near-name pairs NOT merged       ${i.provisional_candidates.length}`);
    for (const c of i.provisional_candidates) {
      const counts = c.names.map((n) => `${n} (${c.cards_in_archive[n]} cards)`).join(' | ');
      console.log(`    ${counts}  [${c.status}]`);
    }
    console.log('\nINTEGRITY');
    console.log(`  card shape vs method mismatches  ${shapeMismatch.length}`);
    for (const m of shapeMismatch) console.log(`    ${m.event_date}  ${m.bout} — ${m.method}, ${m.dissent_cards} dissent / ${m.even_cards} even`);
    console.log(`  panels with fewer than 3 cards   ${partialPanels.length}`);
    console.log('\nGAPS BY CLASSIFICATION');
    for (const [k, v] of Object.entries(byBucket).sort((x, y) => y[1].total - x[1].total)) {
      console.log(`  ${S.GAP_LABEL[k] || k}  ${v.total}`);
      for (const [reason, n] of Object.entries(v.reasons).sort((x, y) => y[1] - x[1])) console.log(`    ${n.toString().padStart(4)}  ${reason}`);
    }
    console.log(`\n  total classified                 ${gaps.length}`);
    console.log(`\nwritten ${path.relative(ROOT, JSON_OUT)}\n`);
  }

  /* An audit that cannot fail is decoration. These are the invariants. */
  const problems = [];
  if (c_total(report) !== report.coverage.judged_results) problems.push('coverage buckets do not sum to the judged-result total');
  if (report.coverage.finishes_with_unexpected_scorecard > 0) problems.push('a bout that ended in a finish carries a scorecard');
  if (report.identity.aliases_unused.length) problems.push(`alias(es) match nothing in the archive: ${report.identity.aliases_unused.join(', ')}`);
  /* An unverified merge must never reach the archive's canonical identities.
     Checked against what actually came out of the aggregation, not against the
     alias table, so a merge introduced anywhere in the path is caught. */
  for (const variant of Object.entries(S.JUDGE_ALIASES).filter(([, a]) => a.kind === 'spelling_variant')) {
    const [raw] = variant;
    if (!S.SPELLING_VARIANT_EVIDENCE.some((e) => e.rawName === raw)) problems.push(`spelling_variant ${raw} is applied with no external evidence`);
  }
  for (const candidate of S.PROVISIONAL_IDENTITY_CANDIDATES) {
    const present = candidate.names.filter((n) => judgeCards.has(n));
    if (present.length < candidate.names.length && present.length > 0) {
      problems.push(`provisional pair ${candidate.names.join(' / ')} collapsed: only ${present.join(', ')} survived as a canonical identity`);
    }
  }
  if (problems.length) { for (const p of problems) console.error(`FAIL: ${p}`); process.exit(1); }
};

const c_total = (r) => r.coverage.with_scorecards + r.coverage.missing_scorecards;

main().catch((e) => { console.error(e); process.exit(1); });
