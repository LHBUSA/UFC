#!/usr/bin/env node
/* Historical dry run over every stored news item. WRITES NOTHING, EVER.
 *
 *   node scripts/status/backfill_status_events.mjs [--since-days 3650] [--json out.json]
 *                                                  [--sample 25]
 *
 * There is no --write flag in this file and no insert anywhere in it. Its job
 * is to answer, before a single row exists, the only questions that decide
 * whether this system is worth applying a migration for:
 *
 *   how many status events does our own archive actually contain
 *   how many resolve to a fighter, an event, a bout
 *   how many are ambiguous or unattributable
 *   and what do the WRONG ones look like
 *
 * That last one is the point. A backfill report showing only what was found is
 * a sales document. The false-positive sample below is drawn from the highest
 * confidence rows — the ones most likely to be believed — and printed in full
 * so a human can read the headline that produced each claim.
 */
import { Supabase, loadEnv, sha256 } from '../news/lib.mjs';
import { extractStatus, fingerprintOf } from './lib/extract.mjs';
import { candidateItems, sourceKindFor } from './collect_status_events.mjs';

function parseCli(argv) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    sinceDays: Number(opt('--since-days', 3650)) || 3650,
    sample: Number(opt('--sample', 25)) || 25,
    json: opt('--json', null),
  };
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');

async function main() {
  const args = parseCli(process.argv.slice(2));
  const env = loadEnv();
  const sb = new Supabase(env);
  const now = Date.now();
  const since = new Date(now - args.sinceDays * 86400e3).toISOString();

  console.log(`fighter-status backfill — DRY RUN, no writes, window ${args.sinceDays}d\n`);

  const items = await sb.select('ufc_news_items',
    `select=id,url,title,summary,published_at,taxonomy,fighter_ids,bout_id,event_id,captured_at,source_id`
    + `&or=(published_at.gte.${since},and(published_at.is.null,captured_at.gte.${since}))`
    + `&order=published_at.desc.nullslast`);

  const candidates = candidateItems(items);
  const fighterIds = [...new Set(candidates.flatMap((i) => i.fighter_ids || []))];
  const fighters = fighterIds.length ? await sb.select('ufc_fighters', `select=id,name&id=in.(${fighterIds.join(',')})`) : [];
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const sources = new Map((await sb.select('ufc_news_sources', 'select=id,name,url')).map((s) => [s.id, s]));

  const events = [];
  const skipped = [];
  for (const it of candidates) {
    const src = sources.get(it.source_id);
    try {
      const out = extractStatus({
        ...it,
        fighters: (it.fighter_ids || []).map((id) => byId.get(id)).filter(Boolean),
        source_name: src?.name || null,
        source_kind: sourceKindFor(it.url, src?.name),
      }, { now });
      skipped.push(...out.skipped);
      for (const e of out.events) events.push({ ...e, fingerprint: fingerprintOf(e, sha256), _title: it.title, _url: it.url });
    } catch (e) {
      skipped.push({ id: it.id, title: it.title, reason: 'extractor_threw', detail: String(e?.message || e).slice(0, 160) });
    }
  }

  /* ---- counts ---------------------------------------------------------- */
  const byType = {};
  for (const e of events) byType[e.status_type] = (byType[e.status_type] || 0) + 1;
  const linkedFighter = events.filter((e) => e.fighter_id).length;
  const linkedEvent = events.filter((e) => e.event_id).length;
  const linkedBout = events.filter((e) => e.bout_id).length;
  const ambiguous = events.filter((e) => e.ambiguous).length;
  const withDiagnosis = events.filter((e) => e.injury_type).length;
  const withBodyPart = events.filter((e) => e.body_part && !e.injury_type).length;
  const clinicalNone = events.filter((e) => ['injury', 'illness', 'withdrawal'].includes(e.status_type) && !e.injury_type && !e.body_part).length;
  const uniqueFingerprints = new Set(events.map((e) => e.fingerprint)).size;
  const skipReasons = {};
  for (const s of skipped) skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1;

  console.log('CANDIDATE STATUS EVENTS');
  console.log(`  news items in window          ${items.length}`);
  console.log(`  passed the taxonomy prefilter ${candidates.length}  (${pct(candidates.length, items.length)})`);
  console.log(`  candidate status events       ${events.length}`);
  console.log(`  distinct fingerprints         ${uniqueFingerprints}${uniqueFingerprints !== events.length ? `  (${events.length - uniqueFingerprints} would collapse on insert)` : ''}`);
  console.log('\n  by type');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`    ${t.padEnd(14)} ${String(n).padStart(5)}`);

  console.log('\nLINKAGE');
  console.log(`  linked to a fighter           ${linkedFighter}  (${pct(linkedFighter, events.length)})`);
  console.log(`  linked to an event            ${linkedEvent}  (${pct(linkedEvent, events.length)})`);
  console.log(`  linked to a bout              ${linkedBout}  (${pct(linkedBout, events.length)})`);
  console.log(`  ambiguous subject             ${ambiguous}  (${pct(ambiguous, events.length)})`);

  console.log('\nCLINICAL DETAIL — the rule is that most of these are empty');
  console.log(`  named injury (quoted)         ${withDiagnosis}`);
  console.log(`  body part only, no diagnosis  ${withBodyPart}`);
  console.log(`  no clinical detail stated     ${clinicalNone}`);
  const unquoted = events.filter((e) => (e.injury_type || e.body_part) && !e.clinical_quote).length;
  console.log(`  clinical claim with NO quote  ${unquoted}${unquoted ? '   <-- BUG: the database would reject these' : '   (correct: none)'}`);

  console.log('\nUNLINKED / AMBIGUOUS / REJECTED');
  for (const [r, n] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) console.log(`  ${r.padEnd(24)} ${String(n).padStart(5)}`);

  /* ---- the false-positive sample --------------------------------------- */
  console.log('\nFALSE-POSITIVE SAMPLE — highest confidence first, i.e. the ones most likely to be believed');
  console.log('Read the headline. If the claim is not in it, the rule that fired is wrong.\n');
  const sample = [...events].sort((a, b) => b.confidence - a.confidence).slice(0, args.sample);
  for (const e of sample) {
    console.log(`  [${e.confidence}] ${e.status_type.padEnd(12)} ${String(e.fighter_name).padEnd(22)} ${e.injury_type || e.body_part || '(no diagnosis stated)'}`);
    console.log(`         "${String(e._title).slice(0, 140)}"`);
    console.log(`         matched ${JSON.stringify(e.provenance.matched)} in ${e.provenance.matched_in}${e.ambiguous ? '  AMBIGUOUS' : ''}`);
    console.log(`         ${e._url}`);
  }

  console.log('\nREJECTED SAMPLE — what the negators and the subject rule threw away');
  for (const s of skipped.filter((s) => s.reason !== 'no_status_rule_matched').slice(0, Math.min(15, args.sample))) {
    console.log(`  ${s.reason.padEnd(22)} ${String(s.title).slice(0, 110)}${s.detail ? `\n         ${s.detail}` : ''}`);
  }

  if (args.json) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.json, JSON.stringify({
      generated_at: new Date(now).toISOString(),
      window_days: args.sinceDays,
      counters: { items: items.length, candidates: candidates.length, events: events.length, uniqueFingerprints, linkedFighter, linkedEvent, linkedBout, ambiguous, withDiagnosis, withBodyPart, clinicalNone, unquoted },
      by_type: byType, skip_reasons: skipReasons, events, skipped,
    }, null, 2));
    console.log(`\nfull report -> ${args.json}`);
  }

  console.log('\nNOTHING WAS WRITTEN. This file has no insert path and the migration has not been applied.');
}

main().catch((e) => { console.error(e); process.exit(1); });
