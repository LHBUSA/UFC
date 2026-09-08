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
  if (/submission|sub/.test(t)) return 'submission';
  if (/tko|ko|knockout/.test(t)) return 'ko-tko';
  if (/disqual|dq/.test(t)) return 'dq';
  return t.slice(0, 20);
};

/**
 * Is this result row plausibly the bout the archive is describing, or another
 * meeting of the same two fighters?
 *
 * TUF 6 is the case that forced this. Ben Saunders beat Dan Barrera twice: by
 * majority decision over two rounds in the house, and by unanimous decision
 * over three on the finale card eight weeks later. Both fall inside the
 * season's window, so the window alone cannot separate them — but the results
 * can, and they disagree in both fields.
 *
 * Undecidable stays undecidable: with no method or round recorded on our side
 * the answer is null, and the caller reports rather than resolves.
 */
function sameBout(archiveBout, row, result) {
  const mA = methodFamily(archiveBout.method);
  const mB = methodFamily(result?.method_raw);
  if (!mA || !mB) return null;
  if (mA !== mB) return false;
  if (archiveBout.round && result?.round && archiveBout.round !== result.round) return false;
  return true;
}

/* One lookup per fighter name, cached, because the same contestants recur
 * across a season's rounds and across seasons. */
const idCache = new Map();
async function fighterId(name) {
  const k = fold(name);
  if (idCache.has(k)) return idCache.get(k);
  const rows = await rest(`ufc_fighters?select=id,name&name=eq.${encodeURIComponent(name)}`);
  let hit = rows[0] || null;
  if (!hit) {
    /* Second try, accent-folded on BOTH sides. The archive spells names as its
     * sources do — "Patrick Côté", "Vinny Magalhães" — and our fighter rows
     * generally do not. Searching on the accented surname finds nothing in a
     * table that stores it plain, so the search term is folded too and the
     * comparison is made after folding. */
    const surname = fold(name).split(' ').pop();
    const loose = await rest(`ufc_fighters?select=id,name&name=ilike.${encodeURIComponent(`%${surname}%`)}&limit=60`);
    hit = loose.find((r) => fold(r.name) === k) || null;
  }
  idCache.set(k, hit);
  return hit;
}

/** The bout between these two, either corner order, inside the season's window. */
async function boutBetween(a, b, window) {
  const [x, y] = [await fighterId(a), await fighterId(b)];
  if (!x || !y) return { found: false, why: `no fighter row for ${!x ? a : b}` };
  const rows = await rest(
    `ufc_bouts?select=id,weight_class,ufc_events!inner(name,event_date),ufc_bout_results(method_raw,round,winner_id)` +
      `&or=(and(fighter_a_id.eq.${x.id},fighter_b_id.eq.${y.id}),and(fighter_a_id.eq.${y.id},fighter_b_id.eq.${x.id}))`,
  );
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
  const inWindow = [];
  const later = [];
  for (const r of withResult) {
    const d = r.ufc_events?.event_date || '';
    (window && d && d >= window.from && d <= window.to ? inWindow : later).push(r);
  }
  return { found: Boolean(inWindow.length), rows: inWindow, later, x, y };
}

const main = async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).filter((f) => !ONLY || f === `${ONLY}.json`);
  const findings = [];
  const tally = {
    checked: 0, exhibition: 0, professional: 0, unverified: 0,
    confirmed_pro: 0, contradicted: 0, unsupported_pro: 0,
    later_meetings: 0, name_unresolved: 0,
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

          const hit = await boutBetween(bout.a, bout.b, window);

          /* Split the in-window rows by whether they can be this bout at all.
           * A row whose result disagrees with the archive's is another meeting
           * of the same two fighters, not a contradiction about this one. */
          const resultOf = (r) => (Array.isArray(r.ufc_bout_results) ? r.ufc_bout_results[0] : r.ufc_bout_results);
          const matching = (hit.rows || []).filter((r) => sameBout(bout, r, resultOf(r)) !== false);
          const rematches = (hit.rows || []).filter((r) => sameBout(bout, r, resultOf(r)) === false);
          const inWindowMatch = matching.length > 0;

          if (rematches.length) {
            tally.later_meetings += 1;
            findings.push({
              kind: 'second-meeting',
              slug, stage: st.stage, bout: `${bout.a} vs ${bout.b}`,
              detail: `also met on a sanctioned card inside this season, with a different result — ${rematches.map((r) => `${r.ufc_events.name} (${r.ufc_events.event_date}, ${resultOf(r)?.method_raw} R${resultOf(r)?.round})`).join('; ')} — against the archive's ${bout.method}${bout.round ? ` R${bout.round}` : ''}. Two fights, not one.`,
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
