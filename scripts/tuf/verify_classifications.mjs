#!/usr/bin/env node
/**
 * Check every classified TUF bout against our own professional records.
 *
 *   node scripts/tuf/verify_classifications.mjs [--season tuf-2] [--write]
 *
 * The archive now carries 726 bouts whose classification came from reading a
 * source article. That is one source, and the whole point of the exhibition
 * rule is that it decides what does and does not reach a professional record —
 * so it should not rest on one source when we hold a second.
 *
 * The check runs in the direction where being wrong actually costs something.
 * A bout marked 'exhibition' is EXCLUDED from professional aggregates. If such
 * a bout turns out to sit in ufc_bouts with a result, then either the archive
 * is hiding a real professional result or our fight database has a bout it
 * should not. Both are worth knowing and neither is visible from inside one of
 * the two datasets. The same lookup catches the opposite error: a bout marked
 * 'professional' that no result row supports.
 *
 * What it deliberately does NOT do is promote 'unverified' to 'exhibition'
 * because the bout is absent from our records. Absence is not evidence. Our
 * fight database is still being backfilled, it does not claim to hold
 * unsanctioned bouts, and "we looked and did not find it" is a search result,
 * not a finding. Those bouts stay unverified, which is what they are, and
 * unverified is already treated as "does not count".
 *
 * READ-ONLY against the fight database — it issues selects and nothing else,
 * so it is safe to run while the historical backfill is loading. With --write
 * it annotates the season files in this repository, and only for bouts where
 * a real result row was found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameMatch, pairMatch, cornerNames } from './lib/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'web', 'data', 'tuf', 'seasons');

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const ONLY = opt('--season');
const WRITE = argv.includes('--write');

for (const f of ['.env', '.env.local', path.join('web', '.env.local')]) {
  const file = path.join(ROOT, f);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.trimStart().startsWith('#')) continue;
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }

async function rest(q) {
  const res = await fetch(`${URL_}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`supabase ${res.status} on ${q.split('?')[0]}`);
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

const fold = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();

/**
 * Reduce a method to the family both datasets can be compared on. The archive
 * writes "Decision (majority)" and our results write "Decision - Majority";
 * neither spelling matters, the family does.
 */
const methodFamily = (m) => {
  const t = String(m || '').toLowerCase();
  if (!t) return null;
  if (/unanimous/.test(t)) return 'decision-unanimous';
  if (/split/.test(t)) return 'decision-split';
  if (/majority/.test(t)) return 'decision-majority';
  if (/draw/.test(t)) return 'draw';
  if (/no contest|^nc$/.test(t)) return 'no-contest';
  if (/decision/.test(t)) return 'decision';
  if (/submission|\bsub\b/.test(t)) return 'submission';
  if (/tko|\bko\b|knockout/.test(t)) return 'ko-tko';
  if (/disqual|dq/.test(t)) return 'dq';
  return t.slice(0, 20);
};

/**
 * Does this result row identify the same bout the archive is describing?
 *
 * Answered from sourced fields only — who fought, and when and where the
 * source says they fought — never from what kind of round it was. An earlier
 * version took "a tournament final was on the finale card by definition" as a
 * premise, which is an assumption about how the show works rather than
 * evidence about a bout, and it decided cases the data should decide. TUF 22's
 * final was not on a card called a finale at all; several international finals
 * sit on ordinary numbered events months apart. A rule that reasons from the
 * stage gets those wrong for the same reason it got TUF 5 right: by luck.
 *
 * So identity comes from the date the SOURCE gives for the bout:
 *
 *   Sourced date present, row on that date  -> the same bout. If the results
 *     also disagree, that is two descriptions of one fight and is reported as
 *     a method disagreement, kept separate from anything about identity.
 *   Sourced date present, row on another date -> a different meeting.
 *   No sourced date (a house bout, which the source dates by episode and not
 *     by day) -> identity cannot be established from dates, so it falls back
 *     to the result itself: method and round agreeing is the only remaining
 *     evidence, and disagreement is reported as undecided rather than
 *     asserted either way.
 */
function boutIdentity(archiveBout, row, result, ctx = {}) {
  const rowDate = row?.ufc_events?.event_date || null;
  const rowEvent = row?.ufc_events?.name || null;
  const sourcedDate = ctx.sourcedDate || archiveBout.fight_date || null;
  const sourcedEvent = ctx.sourcedEvent || null;

  if (sourcedDate && rowDate) {
    if (sourcedDate !== rowDate) return { same: false, why: 'different date' };
    /* Same day. If the source also names the event, it has to be that event —
     * two cards can run on one date. */
    if (sourcedEvent && rowEvent && fold(sourcedEvent) !== fold(rowEvent)) {
      return { same: false, why: 'same date, different event' };
    }
    const mA = methodFamily(archiveBout.method);
    const mB = methodFamily(result?.method_raw);
    const disagrees = Boolean(mA && mB && mA !== mB)
      || Boolean(archiveBout.round && result?.round && archiveBout.round !== result.round);
    return { same: true, why: 'sourced date and event', methodDisagreement: disagrees };
  }

  const mA = methodFamily(archiveBout.method);
  const mB = methodFamily(result?.method_raw);
  if (!mA || !mB) return { same: null, why: 'no sourced date and no comparable result' };
  if (mA !== mB) return { same: null, why: 'no sourced date; results differ, so this may be a second meeting' };
  if (archiveBout.round && result?.round && archiveBout.round !== result.round) {
    return { same: null, why: 'no sourced date; rounds differ, so this may be a second meeting' };
  }
  return { same: true, why: 'no sourced date; result matches exactly' };
}

/* Aliases that no spelling rule derives, with the bout each was checked
 * against. Same file the importer reads, so the two cannot drift. */
const ALIAS_FILE = path.join(ROOT, 'web', 'data', 'tuf', 'name_aliases.json');
const ALIASES = fs.existsSync(ALIAS_FILE) ? JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')).aliases : [];

/**
 * Find the fighter row for a name, under any spelling either side uses.
 *
 * Candidates come from the database and the decision is made by the shared
 * matcher, so this cannot disagree with the importer or the summary about who
 * someone is. That mattered: with three private matchers, the same fighter was
 * simultaneously resolved by one and reported missing by another, and the
 * reports were being read as gaps in the data.
 */
const idCache = new Map();
async function fighterRows(name) {
  const k = fold(name);
  if (idCache.has(k)) return idCache.get(k);

  const hits = new Map();
  for (const r of await rest(`ufc_fighters?select=id,name&name=eq.${encodeURIComponent(name)}`)) hits.set(r.id, r);

  /* Candidate pool: anything sharing a token with the name, plus anything
   * sharing an alias' tokens. The shared matcher then decides, and EVERY row
   * it accepts is kept — see resolveAll for why the first is not enough. */
  const spellings = [name, ...ALIASES.filter((a) => fold(a.source_name) === k).map((a) => a.records_name)];
  const seen = new Map();
  for (const sp of spellings) {
    for (const tok of fold(sp).split(' ').filter((t) => t.length > 2)) {
      for (const r of await rest(`ufc_fighters?select=id,name&name=ilike.${encodeURIComponent(`%${tok}%`)}&limit=60`)) {
        seen.set(r.id, r);
      }
    }
  }
  for (const sp of spellings) {
    for (const r of seen.values()) if (nameMatch(r.name, sp).same) hits.set(r.id, r);
  }

  const out = [...hits.values()];
  idCache.set(k, out);
  return out;
}

/**
 * Every fighter row a corner could be, not just the first.
 *
 * Our roster sometimes holds one fighter twice — "Marcio Alexandre Jr." and
 * "Marcio Alexandre Junior" are both present, and only one of them carries the
 * TUF Brazil 3 final. Taking the first match therefore reported a verified
 * bout as unsupported: the name resolved, to the wrong one of two rows for the
 * same man. Collecting every candidate and asking for a bout between any of
 * them removes the coin-flip, and the duplicate itself is reported rather than
 * quietly worked around.
 */
async function resolveAll(names) {
  const out = new Map();
  for (const n of (Array.isArray(names) ? names : [names]).filter(Boolean)) {
    for (const r of await fighterRows(n)) out.set(r.id, r);
  }
  return [...out.values()];
}

async function boutBetween(a, b, window) {
  const xs = await resolveAll(a);
  const ys = await resolveAll(b);
  if (!xs.length || !ys.length) {
    const missing = !xs.length ? (Array.isArray(a) ? a[0] : a) : (Array.isArray(b) ? b[0] : b);
    return { found: false, why: `no fighter row for ${missing}` };
  }
  const ids = (rows) => `(${rows.map((r) => r.id).join(',')})`;
  const rows = await rest(
    `ufc_bouts?select=id,weight_class,ufc_events!inner(name,event_date),ufc_bout_results(method_raw,round,winner_id)` +
      `&or=(and(fighter_a_id.in.${ids(xs)},fighter_b_id.in.${ids(ys)}),and(fighter_a_id.in.${ids(ys)},fighter_b_id.in.${ids(xs)}))`,
  );
  const x = xs[0];
  const y = ys[0];
  const dupes = [xs, ys].filter((g) => g.length > 1).map((g) => g.map((r) => r.name).join(' / '));
  /* The result embed comes back as an object for a one-to-one relationship and
   * as an array for a one-to-many. Reading only one shape silently drops every
   * row and turns "verified" into "unsupported", which is exactly the wrong
   * direction for a check whose whole job is to contradict the data. */
  const resultsOf = (r) => {
    const e = r.ufc_bout_results;
    if (!e) return [];
    return Array.isArray(e) ? e : [e];
  };
  const withResult = rows.filter((r) => resultsOf(r).length);

  /* A pair of names is not a bout. Two fighters can meet more than once, and
   * across this archive they frequently do — a house bout in 2005 and a UFC
   * card in 2007 are the same two men and different fights. Matching on the
   * pairing alone is the same mistake that once linked two seasons to the
   * wrong finale card, so the window decides: a result dated after the season
   * finished is a later meeting and is reported as one, never as evidence
   * about this bout. */
  /* The window is a fallback, not a filter on everything. When the source
   * names the date, that date decides and the window has no business
   * overruling it — TUF China's featherweight final was contested five months
   * after the card its own season is dated by, and a window closing at the
   * season's finale threw the correct row away and then called the bout
   * unsupported. So a sourced date widens the search to the whole record; only
   * a bout with no sourced date falls back to the season's span. */
  if (window?.sourcedDate) return { found: Boolean(withResult.length), rows: withResult, later: [], x, y, dupes };

  const inWindow = [];
  const later = [];
  for (const r of withResult) {
    const d = r.ufc_events?.event_date || '';
    (window && d && d >= window.from && d <= window.to ? inWindow : later).push(r);
  }
  return { found: Boolean(inWindow.length), rows: inWindow, later, x, y, dupes };
}

/* The inventory is where a verified final's event and date live. The bracket
 * file holds the bout; the inventory holds what it was checked against. */
const INVENTORY = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons.json'), 'utf8'));
const inventoryBySlug = new Map(INVENTORY.seasons.map((s) => [s.slug, s]));

/**
 * The source's own event and date for this bout, if it has one.
 *
 * Matched on the pair of fighters, not on the bout's position in the bracket,
 * and returning nothing when the inventory does not carry this pairing — a
 * house bout the source dates only by episode has no sourced date, and
 * inventing one from the season's finale would be exactly the assumption this
 * is replacing.
 */
function sourcedFinal(seasonRow, bout, stage) {
  /* Only a bout the SOURCE labels a final may take its event and date from the
   * inventory's list of finals. Not because finals happen anywhere in
   * particular — that assumption is gone — but because those inventory entries
   * describe the season's finals and nothing else, so lending their date to a
   * different bout misidentifies it.
   *
   * TUF 7 is why this matters. Amir Sadollah beat C. B. Dollaway twice in one
   * season, in the house semi-final and again in the final. Matching on names
   * alone handed the semi-final the final's date, which then matched the
   * finale card's result row and reported the house bout as a professional
   * result the archive was wrongly excluding. Two fights, one pairing.
   *
   * The stage label is the source's own statement about the bout, not an
   * inference about how the show works. */
  if (stage !== 'final') return null;
  const finals = seasonRow?.final_bouts || [];
  const A = cornerNames(bout, 'a');
  const B = cornerNames(bout, 'b');
  for (const f of finals) {
    const fa = [f.a, f.name_in_archive].filter(Boolean);
    const fb = [f.b, f.name_in_archive].filter(Boolean);
    for (const a1 of A) for (const b1 of B) {
      for (const a2 of fa) for (const b2 of fb) {
        if (a2 === b2) continue;
        if (pairMatch(a1, b1, a2, b2).same) return { event: f.event || null, date: f.date || null };
      }
    }
  }
  return null;
}

/* Say which field actually separated two rows, rather than asserting
 * "different dates" when it was the event name that differed on a shared
 * date. */
const differentWhy = (verdicts) =>
  [...new Set(verdicts.filter((x) => x.v.same === false).map((x) => x.v.why))].join('; ');

const main = async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).filter((f) => !ONLY || f === `${ONLY}.json`);
  const findings = [];
  const tally = {
    checked: 0, exhibition: 0, professional: 0, unverified: 0,
    confirmed_pro: 0, contradicted: 0, unsupported_pro: 0,
    later_meetings: 0, name_unresolved: 0, method_disagreements: 0, undecided: 0, duplicate_rows: 0,
  };

  for (const file of files) {
    const slug = file.replace(/\.json$/, '');
    const season = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    let touched = false;

    /* The season's own span: from the start of the year it aired to the day
     * its finale was contested. House bouts are filmed before the finale and
     * the finale is the last thing the season produces, so nothing dated after
     * it can be one of this season's bouts. Where no finale date is recorded,
     * the window closes at the end of the following year rather than staying
     * open — an unbounded window would let any later rematch count. */
    const window = {
      from: `${season.year}-01-01`,
      to: season.finale?.event_date || `${season.year + 1}-12-31`,
    };

    for (const div of season.bracket || []) {
      for (const st of div.stages) {
        for (const bout of st.bouts) {
          tally[bout.classification] = (tally[bout.classification] || 0) + 1;
          if (bout.classification === 'unverified') continue;   // absence proves nothing; leave it alone
          tally.checked += 1;

          const sourcedPre = sourcedFinal(inventoryBySlug.get(slug), bout, st.stage);
          const hit = await boutBetween(
            cornerNames(bout, 'a'),
            cornerNames(bout, 'b'),
            { ...window, sourcedDate: sourcedPre?.date || bout.fight_date || null },
          );

          const resultOf = (r) => (Array.isArray(r.ufc_bout_results) ? r.ufc_bout_results[0] : r.ufc_bout_results);

          /* What the SOURCE says about when and where this bout happened. The
           * inventory's verified finals carry an event and a date; a bout the
           * source dates only by episode carries neither, and gets none here
           * rather than borrowing the season's. */
          const sourced = sourcedPre;
          const ctx = {
            sourcedDate: sourced?.date || bout.fight_date || null,
            sourcedEvent: sourced?.event || null,
          };

          const verdicts = (hit.rows || []).map((r) => ({ row: r, v: boutIdentity(bout, r, resultOf(r), ctx) }));
          const matching = verdicts.filter((x) => x.v.same === true).map((x) => x.row);
          const different = verdicts.filter((x) => x.v.same === false).map((x) => x.row);
          const undecided = verdicts.filter((x) => x.v.same === null);
          const inWindowMatch = matching.length > 0;

          /* A method disagreement about a bout whose identity IS established
           * is a difference of description, not of fact, and is recorded on
           * its own rather than being allowed to look like a second fight. */
          for (const x of verdicts.filter((y) => y.v.same === true && y.v.methodDisagreement)) {
            tally.method_disagreements += 1;
            findings.push({
              kind: 'method-disagreement',
              slug, stage: st.stage, bout: `${bout.a} vs ${bout.b}`,
              detail: `same bout — ${x.row.ufc_events.name} on ${x.row.ufc_events.event_date}, matched on the date the source gives — described differently: our records say ${resultOf(x.row)?.method_raw} R${resultOf(x.row)?.round}, the season says ${bout.method}${bout.round ? ` R${bout.round}` : ''}.`,
            });
          }

          if (different.length) {
            tally.later_meetings += 1;
            findings.push({
              kind: 'second-meeting',
              slug, stage: st.stage, bout: `${bout.a} vs ${bout.b}`,
              detail: `the source places this bout at ${ctx.sourcedEvent || '(event not named)'} on ${ctx.sourcedDate}; our records hold this pairing at ${different.map((r) => `${r.ufc_events.name} (${r.ufc_events.event_date})`).join('; ')}. ${differentWhy(verdicts)} — so these are different fights.`,
            });
          }

          if (hit.dupes?.length) {
            tally.duplicate_rows += 1;
            findings.push({
              kind: 'duplicate-fighter-row',
              slug, stage: st.stage, bout: `${bout.a} vs ${bout.b}`,
              detail: `our roster holds more than one row for the same fighter — ${hit.dupes.join('; ')}. The bout was matched against all of them, so this did not affect the result, but the duplicate is in the fight database and is reported rather than worked around.`,
            });
          }

          if (undecided.length) {
            tally.undecided += 1;
            findings.push({
              kind: 'undecided',
              slug, stage: st.stage, bout: `${bout.a} vs ${bout.b}`,
              detail: `${undecided[0].v.why}. Our records hold ${undecided.map((x) => `${x.row.ufc_events.name} (${x.row.ufc_events.event_date}, ${resultOf(x.row)?.method_raw} R${resultOf(x.row)?.round})`).join('; ')} against the archive's ${bout.method}${bout.round ? ` R${bout.round}` : ''}. Reported, not resolved.`,
            });
          }

          if (bout.classification === 'exhibition' && inWindowMatch) {
            /* A bout we exclude from professional records that our own fight
             * database holds as a professional result. One of the two is
             * wrong, and which one is not something this script may decide. */
            findings.push({
              kind: 'contradicted',
              slug, stage: st.stage, bout: `${bout.a} vs ${bout.b}`,
              detail: matching.map((r) => `${r.ufc_events.name} (${r.ufc_events.event_date})`).join('; '),
            });
            tally.contradicted += 1;
            if (WRITE) {
              bout.classification_review = `Marked exhibition from the season source, but our own records hold a matching professional bout: ${matching.map((r) => `${r.ufc_events.name} on ${r.ufc_events.event_date}`).join('; ')}. Not resolved automatically — the two sources disagree about what this bout was.`;
              touched = true;
            }
          } else if (bout.classification === 'professional' && !inWindowMatch) {
            /* Two different things, kept apart. "No fighter row" means the
             * lookup never got far enough to be evidence about the bout — the
             * archive spells a name one way and our roster another. "No result
             * row" means we did look and the bout is not there, which is a
             * claim about the data rather than about the search. */
            const unresolvedName = Boolean(hit.why);
            findings.push({
              kind: unresolvedName ? 'name-unresolved' : 'unsupported',
              slug, stage: st.stage, bout: `${bout.a} vs ${bout.b}`,
              detail: hit.why || 'marked professional, but no matching result row inside the season window',
            });
            if (unresolvedName) tally.name_unresolved += 1;
            else tally.unsupported_pro += 1;
          } else if (bout.classification === 'professional') {
            tally.confirmed_pro += 1;
          }
        }
      }
    }
    if (touched) fs.writeFileSync(path.join(DIR, file), JSON.stringify(season, null, 2) + '\n');
  }

  console.log(`bouts: exhibition ${tally.exhibition}  professional ${tally.professional}  unverified ${tally.unverified}`);
  console.log(`checked against our records: ${tally.checked}  (unverified skipped on purpose — absence is not evidence)`);
  console.log(`professional confirmed by a result row: ${tally.confirmed_pro}`);
  console.log(`professional with no result row:        ${tally.unsupported_pro}`);
  console.log(`not checked, name not resolvable:        ${tally.name_unresolved}  (a search result, not a finding)`);
  console.log(`exhibition contradicted by a result row: ${tally.contradicted}`);
  if (findings.length) {
    console.log('\nfindings');
    for (const f of findings) console.log(`  [${f.kind}] ${f.slug}/${f.stage}  ${f.bout}\n      ${f.detail}`);
  } else {
    console.log('\nNo bout marked exhibition appears in our professional records, and every bout marked professional has one.');
  }
  if (!WRITE && findings.length) console.log('\n(dry run — pass --write to annotate the contradicted bouts)');
};

main().catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
