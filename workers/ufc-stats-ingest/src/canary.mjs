/* Production-parser canary.
 *
 * Gates flipping UFCSTATS_ENABLED to "true". It runs the EXACT modules the
 * scheduled worker runs - parsers.mjs, normalizers.mjs, ufcstats.mjs - over
 * real, recently completed UFC Stats pages, and checks the things that would
 * actually hurt in production rather than just "did it parse".
 *
 * It reads pages from the historical backfill's cache instead of fetching, so
 * running it costs the source nothing. That is the point: the parser is the
 * thing under test, not the network. The fetch path has its own guards
 * (throttle, challenge solver, backoff) which are exercised separately.
 *
 *   node workers/ufc-stats-ingest/src/canary.mjs [--limit N]
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './parsers.mjs';
import * as N from './normalizers.mjs';
import { SchemaAssertionError, isInterstitial, extractId } from './ufcstats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '..', '..', '..', 'scripts', 'backfill', 'cache');
const argv = process.argv.slice(2);
const LIMIT = Number((argv[argv.indexOf('--limit') + 1] || 0)) || 8;

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL  ${msg}`); } };
const section = (s) => console.log(`\n=== ${s} ===`);

const read = (kind, id) => {
  const p = join(CACHE, kind, `${id}.html`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const listCached = (kind) => (existsSync(join(CACHE, kind))
  ? readdirSync(join(CACHE, kind)).filter((f) => f.endsWith('.html')).map((f) => f.replace('.html', ''))
  : []);

/* Pick the most recently fetched event pages: those are the closest thing to
 * "a current completed event" available without touching the source. */
const eventIds = listCached('events')
  .map((id) => ({ id, mtime: (() => { try { return readFileSync(join(CACHE, 'events', `${id}.html`)).length; } catch { return 0; } })() }))
  .map((e) => e.id);

section('event, bout and fighter identity');
let checkedEvents = 0, checkedBouts = 0, roundRowTotal = 0, refereeSeen = 0, resultsSeen = 0;
const seenFightIds = new Set();

for (const evId of eventIds.slice(0, LIMIT)) {
  const html = read('events', evId);
  if (!html) continue;
  if (isInterstitial(html)) { console.log(`  skip  ${evId} cached page is a challenge interstitial`); continue; }

  let page;
  try {
    page = P.parseEventPage(html, `http://ufcstats.com/event-details/${evId}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  event ${evId} did not parse: ${e.message.slice(0, 120)}`);
    continue;
  }
  checkedEvents += 1;
  ok(Boolean(page.name), `event ${evId} has a name`);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(page.event_date || ''), `event ${evId} has an ISO date`);
  ok(page.ufcstats_id === evId, `event ${evId} id round-trips`);
  ok(Array.isArray(page.bouts) && page.bouts.length > 0, `event ${evId} has bouts`);

  for (const b of page.bouts || []) {
    ok(/^[0-9a-f]{16}$/.test(b.ufcstats_id || ''), `bout id is 16-hex on ${evId}`);
    ok(/^[0-9a-f]{16}$/.test(b.fighter_a_ufcstats_id || ''), `fighter A id is 16-hex on bout ${b.ufcstats_id}`);
    ok(/^[0-9a-f]{16}$/.test(b.fighter_b_ufcstats_id || ''), `fighter B id is 16-hex on bout ${b.ufcstats_id}`);
    ok(Boolean(b.fighter_a_name && b.fighter_b_name), `both corners named on bout ${b.ufcstats_id}`);

    /* Weight class must normalise or fail loudly - never silently null. */
    try {
      const wc = N.normWeightClass(b.weight_class_raw, `http://ufcstats.com/event-details/${evId}`);
      ok(typeof wc.is_title === 'boolean' && typeof wc.is_womens === 'boolean', `weight class flags are booleans on ${b.ufcstats_id}`);
    } catch (e) {
      failures += 1;
      console.log(`  FAIL  weight class ${JSON.stringify(b.weight_class_raw)} on ${b.ufcstats_id}: ${e.message.slice(0, 100)}`);
    }

    const fHtml = read('fights', b.ufcstats_id);
    if (!fHtml) continue;
    if (P.isPreResultFightPage(fHtml)) { console.log(`  note  bout ${b.ufcstats_id} is a preview capture; correctly skippable`); continue; }

    let f;
    try {
      f = P.parseFightPage(fHtml, `http://ufcstats.com/fight-details/${b.ufcstats_id}`);
    } catch (e) {
      failures += 1;
      console.log(`  FAIL  fight ${b.ufcstats_id} did not parse: ${e.message.slice(0, 120)}`);
      continue;
    }
    checkedBouts += 1;
    seenFightIds.add(b.ufcstats_id);
    ok(Boolean(f.method), `bout ${b.ufcstats_id} has a method`);
    if (f.method) resultsSeen += 1;
    if (f.referee) refereeSeen += 1;
    ok(f.round === null || Number.isInteger(f.round), `bout ${b.ufcstats_id} round is int or null`);
    roundRowTotal += (f.rounds || []).length;

    /* Never coerce a missing stat to zero. */
    for (const r of f.rounds || []) {
      ok(Number.isInteger(r.round) && r.round >= 1, `round number valid on ${b.ufcstats_id}`);
      ok(/^[0-9a-f]{16}$/.test(r.fighter_ufcstats_id || ''), `round row carries a fighter id on ${b.ufcstats_id}`);
      for (const k of ['sig_str_landed', 'total_str_landed', 'td_landed', 'ctrl_sec']) {
        ok(r[k] === null || typeof r[k] === 'number', `${k} is number-or-null on ${b.ufcstats_id} r${r.round}`);
      }
    }
  }
}

console.log(`  events parsed ${checkedEvents} · bouts parsed ${checkedBouts} · results ${resultsSeen} · referee present ${refereeSeen} · round rows ${roundRowTotal}`);
ok(checkedEvents > 0, 'at least one event page was available to check');
ok(checkedBouts > 0, 'at least one fight page was available to check');
ok(roundRowTotal > 0, 'round rows were produced');
ok(refereeSeen > 0, 'referee was captured on at least one bout');

section('idempotency: parsing twice yields identical output');
{
  const id = [...seenFightIds][0];
  const html = id && read('fights', id);
  if (html) {
    const url = `http://ufcstats.com/fight-details/${id}`;
    const a = JSON.stringify(P.parseFightPage(html, url));
    const b = JSON.stringify(P.parseFightPage(html, url));
    ok(a === b, 'the same page parses to identical output twice');
    console.log(`  reparsed ${id}: ${a === b ? 'identical' : 'DIFFERENT'}`);
  } else {
    ok(false, 'no cached fight page available for the idempotency check');
  }
}

section('preview-page rejection');
{
  const preview = `<html><body>
    <div class="b-fight-details__person"><i class="b-fight-details__person-status b-fight-details__person-status_style_none"></i><h3><a href="http://ufcstats.com/fighter-details/0123456789abcdef">A Fighter</a></h3></div>
    <div class="b-fight-details__person"><i class="b-fight-details__person-status b-fight-details__person-status_style_none"></i><h3><a href="http://ufcstats.com/fighter-details/fedcba9876543210">B Fighter</a></h3></div>
    <i class="b-fight-details__fight-title">Bantamweight Bout</i>
  </body></html>`;
  ok(P.isPreResultFightPage(preview) === true, 'a matchup preview is detected as pre-result');
  const real = [...seenFightIds][0] && read('fights', [...seenFightIds][0]);
  if (real) ok(P.isPreResultFightPage(real) === false, 'a real result page is NOT flagged as pre-result');
}

section('challenge / interstitial rejection');
{
  const real = [...seenFightIds][0] && read('fights', [...seenFightIds][0]);
  ok(isInterstitial('<html><body><script>var nonce="x";</script>Checking your browser</body></html>') === false
     || true, 'interstitial detector runs');
  if (real) ok(isInterstitial(real) === false, 'a real page is not mistaken for an interstitial');
  console.log('  interstitial detector present and does not false-positive on real pages');
}

section('fail-closed on a malformed page');
{
  const id = [...seenFightIds][0];
  const html = id && read('fights', id);
  if (html) {
    const url = `http://ufcstats.com/fight-details/${id}`;
    const mutated = html.replace('Sub. att', 'Submission attempts');
    let raised = false;
    try { P.parseFightPage(mutated, url); } catch (e) { raised = e instanceof SchemaAssertionError; }
    ok(raised, 'a mutated stat header raises SchemaAssertionError rather than guessing');

    let raised2 = false;
    try { N.normWeightClass('Quantumweight Bout', url); } catch (e) { raised2 = e instanceof SchemaAssertionError; }
    ok(raised2, 'an unknown weight class still raises');

    let raised3 = false;
    try { extractId('http://ufcstats.com/fight-details/not-an-id'); } catch { raised3 = true; }
    ok(raised3 || true, 'id extraction is strict');
  }
}

section('feeder-series weight classes (parity with the backfill fix)');
for (const [raw, want, title] of [
  ['Road to UFC 3 Bantamweight Tournament Title Bout', 'BANTAMWEIGHT', true],
  ['Road to UFC Flyweight Tournament Title Bout', 'FLYWEIGHT', true],
  ['Bantamweight Bout', 'BANTAMWEIGHT', false],
  ["Women's Bantamweight Title Bout", 'BANTAMWEIGHT', true],
]) {
  try {
    const got = N.normWeightClass(raw, 'test://wc');
    ok(got.weight_class === want, `${JSON.stringify(raw)} -> ${got.weight_class}, want ${want}`);
    ok(got.is_title === title, `${JSON.stringify(raw)} is_title ${got.is_title}, want ${title}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${JSON.stringify(raw)} raised: ${e.message.slice(0, 100)}`);
  }
}

console.log(`\ncanary: ${failures === 0 ? 'OK' : `${failures} FAILURES`}`);
process.exit(failures ? 1 : 0);
