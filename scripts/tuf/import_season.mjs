#!/usr/bin/env node
// Draft a TUF season file from its source article.
//
//   node scripts/tuf/import_season.mjs --slug tuf-2 [--page "..."] [--write]
//
// The source article is looked up from web/data/tuf/source_pages.json; --page
// overrides it for a one-off.
//
// Forty of the forty-four seasons carry metadata only — no bracket, no roster,
// no house bouts. Transcribing them by hand is how the first four were built
// and is not a plan for the other forty. This drafts them instead.
//
// It is a drafter, not an oracle. The rules it works under are the ones the
// hand-built files already follow:
//
//   Two independent parts of the article describe the same fights. The bracket
//   templates say which stage a bout belongs to and who advanced. The episode
//   prose says how it ended — method, round, time, and the episode it aired in.
//   Both are parsed and then joined on the pair of names. Where they agree, the
//   bout is recorded with the detail from the prose and the stage from the
//   bracket. Where they disagree about who won, nothing is chosen: the bout is
//   recorded with no winner and the disagreement is written into _conflicts.
//
//   Structural impossibilities are detected, not smoothed over. A fighter who
//   appears twice in one round, or who turns up in the semi-finals without a
//   bout that got him there, marks that round 'unverified' with a note — the
//   same treatment season one already gets, arrived at the same way.
//
//   Nothing is invented. A bout whose time the source does not give keeps a
//   null time. A stage the article does not contain does not appear.
//
// Classification is deliberately narrow, because a blanket rule is the thing to
// avoid here. A bout is 'exhibition' only when the article places it in a
// numbered episode — that is per-bout evidence that it was filmed during
// production rather than contested on a card. A bout is never marked
// 'professional' by this script; the finale bouts are verified against our own
// result rows separately, by the reconciler that already does that job.
// Anything else is 'unverified' with no source, which is what it is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairMatch } from './lib/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'web', 'data', 'tuf', 'seasons');
const UA = 'PropBetEdgeUFC/1.1 (https://ufc.propbetedge.ai; sales@localhomebuyersusa.com)';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const SLUG = opt('--slug');
const WRITE = argv.includes('--write');
if (!SLUG) { console.error('--slug is required'); process.exit(1); }

/* The article a season is drafted from is looked up, not guessed. Deriving a
 * title from a season name would quietly import the wrong show for at least
 * three of these — see the note in source_pages.json. */
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'source_pages.json'), 'utf8'));

/* Identities no spelling rule can derive, each carrying the bout it was
 * checked against. Applied as a second name on the bout rather than replacing
 * the source's, so both spellings survive and the page can still show what the
 * season actually printed. */
const ALIAS_FILE = path.join(ROOT, 'web', 'data', 'tuf', 'name_aliases.json');
const ALIASES = fs.existsSync(ALIAS_FILE) ? JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')).aliases : [];
const aliasFor = (name) => {
  const hit = ALIASES.find(
    (a) => (!a.seasons || a.seasons.includes(SLUG)) && fold(a.source_name) === fold(name),
  );
  return hit ? hit.records_name : null;
};
const PAGE = opt('--page') || SOURCES.pages[SLUG];
if (!PAGE) { console.error(`no source article recorded for ${SLUG} in web/data/tuf/source_pages.json`); process.exit(1); }

/* ---------- wikitext helpers ---------- */

/* Templates come in two kinds and must not be treated alike.
 *
 * Most are decoration — a flag, a coloured square — and the whole thing goes.
 * A few WRAP the text they are given, and {{nowrap}} is the one that matters
 * here: the source writes
 *
 *   {{nowrap|{{flagicon|CAN}} '''Oliver Aubin-Mercier'''}}
 *
 * so deleting every template outright deletes the fighter. Surveying the
 * bracket blocks of all forty-four articles turns up exactly five wrappers —
 * nowrap, center, nobold, small, nts — against nine hundred-odd decorations,
 * so the wrappers are unwrapped by name and everything else is dropped.
 *
 * Both passes repeat until the string stops changing, because these nest and a
 * single left-to-right scan only ever reaches the innermost one. That is what
 * left "{{nowrap| Olivier Aubin-Mercier}}" sitting in the archive as a
 * fighter's name: the inner {{flagicon}} was removed and the outer wrapper was
 * then behind the scan position and never reconsidered.
 */
const WRAPPERS = /\{\{\s*(?:nowrap|center|nobold|small|nts)\s*\|([^{}]*)\}\}/gi;

const stripTemplates = (s) => {
  let out = String(s || '');
  for (let i = 0; i < 8; i += 1) {
    const before = out;
    out = out.replace(WRAPPERS, '$1').replace(/\{\{[^{}]*\}\}/g, ' ');
    if (out === before) break;
  }
  return out;
};

const clean = (s) =>
  stripTemplates(s)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Cut a trailing clause the prose sometimes puts inside a fighter's name.
 *
 *   "Amir Sadollah defeated C. B. Dollaway in the second semifinal bout by
 *    submission (armbar) at 2:50 in the third round."
 *
 * The name capture runs to " by ", so it swallowed "in the second semifinal
 * bout". No fighter's name contains " in the ", so the clause is cut — narrow
 * on purpose, and only at the end of a name.
 */
const stripTrailingClause = (n) => String(n || '').replace(/\s+in the\s.*$/i, '').trim();

const isBold = (s) => /'''/.test(String(s || ''));
const fold = (n) => clean(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();
const pairKey = (a, b) => [fold(a), fold(b)].sort().join(' :: ');

/**
 * Split a bracket body into its entries.
 *
 * Three conventions appear across these articles for the same kind of bracket:
 * "||" starting a line, "||" closing the previous one, and a bare "|" per cell
 * with one entry spread over several lines. Season 28 uses the second, seasons
 * 29 and 31 use the third for their final only — which is how each of the
 * three lost exactly one bout, and always the last one, and was then reported
 * as a verified final missing from the bracket. A parser defect wearing a
 * source gap's clothes.
 *
 * So the separator is not what gets matched. See the note inside.
 */
function splitEntries(body) {
  /* Chasing the separator turned out to be the wrong model, and so did simply
   * discarding every empty cell.
   *
   * Splitting the body on single pipes produces two KINDS of empty cell: the
   * one "||" leaves behind between entries, and a genuinely blank value. TUF
   * 18's male bracket has both on one line —
   *
   *     ||Davey Grant|**|Anthony Gutierrez|
   *
   * where the last cell is empty because Gutierrez never fought; Bollinger
   * missed weight and Gutierrez walked into the semi-final. Dropping all
   * empties removed that blank, shifted every later cell by one, and cost the
   * division its final. Keeping all empties instead breaks the layouts that
   * omit the separator.
   *
   * The two are told apart by position rather than by appearance: an empty
   * where a NAME belongs is a separator and is skipped, an empty where a
   * RESULT belongs is a value and is kept. So the body is read as a stream —
   * name, result, name, result — skipping blanks only when looking for a name.
   * That reads all three of the layouts these articles use without needing to
   * know which one it is looking at.
   */
  const cells = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < body.length; i += 1) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth += 1; buf += two; i += 1; continue; }
    if (two === '}}' || two === ']]') { depth -= 1; buf += two; i += 1; continue; }
    if (body[i] === '|' && depth === 0) { cells.push(buf); buf = ''; continue; }
    buf += body[i];
  }
  cells.push(buf);

  const stream = cells
    .slice(1)                                                   // the "RoundN" header token
    .filter((c) => !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(c));  // widescore=yes, RD1=..., 3rdplace=no

  const entries = [];
  let i = 0;
  const isBlank = (c) => clean(c) === '';
  const nextName = () => { while (i < stream.length && isBlank(stream[i])) i += 1; return i < stream.length ? stream[i++] : null; };
  const nextResult = () => (i < stream.length ? stream[i++] : '');

  for (;;) {
    const a = nextName();
    if (a === null) break;
    const aScore = nextResult();
    const b = nextName();
    if (b === null) break;
    const bScore = nextResult();
    entries.push([a, aScore, b, bScore].join('|'));
  }
  return entries;
}

/** Both name slots of an entry have to hold a name for the chunking to be trusted. */
const entryLooksSane = (cells) =>
  /[A-Za-z]/.test(clean(cells[0])) && /[A-Za-z]/.test(clean(cells[2]));

/** Split a template body on its top-level pipes, respecting nesting. */
function splitPipes(body) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < body.length; i += 1) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth += 1; buf += two; i += 1; continue; }
    if (two === '}}' || two === ']]') { depth -= 1; buf += two; i += 1; continue; }
    if (body[i] === '|' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += body[i];
  }
  out.push(buf);
  return out;
}

/** Extract a balanced template body starting at the opening braces. */
function templateAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text.slice(i, i + 2) === '{{') { depth += 1; i += 1; continue; }
    if (text.slice(i, i + 2) === '}}') { depth -= 1; i += 1; if (depth === 0) return text.slice(start + 2, i - 1); }
  }
  return null;
}

function sliceSection(wt, headRe) {
  const lines = wt.split(/\n/);
  const start = lines.findIndex((l) => headRe.test(l));
  if (start < 0) return null;
  const level = (lines[start].match(/^=+/) || ['=='])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(=+)[^=]/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

/* ---------- method vocabulary ---------- */

const METHODS = {
  UD: 'Decision (unanimous)', SD: 'Decision (split)', MD: 'Decision (majority)',
  KO: 'KO', TKO: 'TKO', SUB: 'Submission', DEC: 'Decision', DQ: 'Disqualification',
  DRAW: 'Draw', NC: 'No contest',
};

const expandMethod = (s) => {
  const t = clean(s).replace(/\.$/, '');
  if (!t) return null;
  const up = t.toUpperCase().replace(/[^A-Z]/g, '');
  if (METHODS[up]) return METHODS[up];
  if (/^\d+$/.test(t)) return null;
  /* A result cell holding only a footnote marker — "*", "**" — is a pointer to
   * a note, not a method. Recorded as no method rather than as a method called
   * "*", which is what the page was rendering. */
  if (!/[a-z0-9]/i.test(t)) return null;
  return t;
};

const titleMethod = (m) => {
  const t = m.replace(/\.$/, '').trim();
  if (/^unanimous decision$/i.test(t)) return 'Decision (unanimous)';
  if (/^split decision$/i.test(t)) return 'Decision (split)';
  if (/^majority decision$/i.test(t)) return 'Decision (majority)';
  if (/^submission/i.test(t)) return t.replace(/^submission/i, 'Submission');
  if (/^(technical knockout|tko)/i.test(t)) return t.replace(/^(technical knockout|tko)/i, 'TKO');
  if (/^(knockout|ko)\b/i.test(t)) return t.replace(/^(knockout|ko)/i, 'KO');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/* ---------- episode prose ---------- */

const ROUND_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, one: 1, two: 2, three: 3 };

/**
 * Pull the fight results out of the episode summaries.
 *
 * The convention across these articles is a bullet naming the winner in bold:
 *   *'''Brad Imes''' defeated Rob MacDonald by submission (triangle choke) at 4:07 of the first round.
 *   *'''Rashad Evans''' defeated Tom Murphy by unanimous decision after three rounds.
 * Anything that does not match that shape is left alone rather than guessed at.
 */
/* The connectives these articles put between the loser and the method. "via"
 * is as common as "by", and some lines use none at all. */
const CONNECTIVE = /\s+(?:by|with|via|through)\s+(?:a\s+)?/i;

/* Method words a line may begin with when it names no connective — "Richie
 * Hightower defeats Blake Bowman TKO (strikes) at 0:49". Listed rather than
 * inferred, so a loser whose name happens to read like a method word cannot
 * cause the split to land in the wrong place. */
const METHOD_HEAD = /^(TKO|KO|SUB|Submission|Decision|Unanimous|Split|Majority|Technical|Doctor|Disqualification|DQ|Draw|No contest)\b/i;

/** Take the round and the time off the end of a method phrase. */
function splitMethodTail(phrase) {
  let method = phrase;
  let time = null;
  let round = null;

  const at = method.match(/\s+at\s+(:?\d{1,2}:\d{2})\s+(?:of|in)\s+the\s+(\w+)\s+round\b/i);
  if (at) {
    time = at[1].replace(/^:/, '0:');
    round = ROUND_WORDS[at[2].toLowerCase()] ?? null;
    method = method.slice(0, at.index);
  } else {
    const after = method.match(/\s+after\s+(\w+)\s+rounds?\b/i);
    if (after) {
      round = ROUND_WORDS[after[1].toLowerCase()] ?? null;
      method = method.slice(0, after.index);
    } else {
      const inRound = method.match(/\s+in\s+the\s+(\w+)\s+round\b/i);
      if (inRound) {
        round = ROUND_WORDS[inRound[1].toLowerCase()] ?? null;
        method = method.slice(0, inRound.index);
      }
    }
  }
  return { method: method.replace(/[\s.]+$/, '').trim(), time, round };
}

/**
 * Pull the fight results out of the episode summaries.
 *
 * Two stages rather than one regex, because one regex is what made this miss
 * 378 of the 616 result lines across these articles. Every one of those was a
 * bout left with no evidence that it was filmed in an episode, so it stayed
 * 'unverified' — which read as the sources being silent about it. They were
 * not silent. The sentence shapes simply vary more than a single pattern
 * allows: some write "via" where others write "by", one bolds the loser too,
 * one leaves a stray space inside the bold markers, and some name no
 * connective at all and go straight from the loser to "TKO".
 *
 * So: take the bolded winner and the verb; split what remains on a connective
 * if there is one, and otherwise at the first word that starts a method. A
 * line matching neither is left alone rather than guessed at.
 */
function parseEpisodes(wt) {
  const bouts = [];
  const section = sliceSection(wt, /^==\s*Episodes?/im);
  if (!section) return bouts;
  let episode = null;

  for (const raw of section.split(/\n/)) {
    const head = raw.match(/'''Episode\s+(\d+)/i);
    if (head) { episode = Number(head[1]); continue; }
    if (!/^\*/.test(raw)) continue;

    const m = raw.match(/^\*+\s*'''\s*(?<w>[^']+?)\s*'''\s*(?:defeated|defeats|def\.)\s+(?<rest>.+?)\s*$/i);
    if (!m) continue;

    const rest = m.groups.rest;
    let loserRaw = null;
    let methodRaw = null;

    const conn = rest.match(CONNECTIVE);
    if (conn) {
      loserRaw = rest.slice(0, conn.index);
      methodRaw = rest.slice(conn.index + conn[0].length);
    } else {
      const words = rest.split(/\s+/);
      for (let i = 1; i < words.length; i += 1) {
        if (METHOD_HEAD.test(clean(words.slice(i).join(' ')))) {
          loserRaw = words.slice(0, i).join(' ');
          methodRaw = words.slice(i).join(' ');
          break;
        }
      }
    }
    if (!loserRaw || !methodRaw) continue;

    const tail = splitMethodTail(clean(methodRaw));
    const method = titleMethod(tail.method);
    if (!method) continue;

    bouts.push({
      winner: clean(m.groups.w),
      /* "Amir Sadollah defeated C. B. Dollaway in the second semifinal bout by
       * submission" — the prose sometimes says WHICH bout between the loser's
       * name and the method, and the name capture swallowed it. A fighter's
       * name does not contain " in the ", so the clause is cut. */
      loser: stripTrailingClause(clean(loserRaw).replace(/\s*\(.*\)\s*$/, '')),
      method,
      round: tail.round,
      time: tail.time,
      episode,
    });
  }
  return bouts;
}

/* ---------- brackets ---------- */

const STAGE_PLAN = {
  4: [['semi_final', 'Semi-finals', 2], ['final', 'Tournament final', 1]],
  8: [['quarter_final', 'Quarter-finals', 4], ['semi_final', 'Semi-finals', 2], ['final', 'Tournament final', 1]],
  16: [['round_of_16', 'First round', 8], ['quarter_final', 'Quarter-finals', 4], ['semi_final', 'Semi-finals', 2], ['final', 'Tournament final', 1]],
};

/**
 * Read one RoundN bracket.
 *
 * The cells hold a name and a result each. Which cell holds the method and
 * which holds the round the fight reached is not fixed — the winner's cell
 * carries the method and the loser's the round — so the bold marker decides,
 * and where bolding does not identify exactly one winner the bout is returned
 * with winner null and a reason attached.
 */
function parseBracket(body, weightClass) {
  const size = Number((body.match(/^\s*Round(\d+)/i) || [])[1] || 0);
  const plan = STAGE_PLAN[size];
  const parsed = splitEntries(body.replace(/<!--[\s\S]*?-->/g, ''))
    .map((e) => splitPipes(e))
    .filter((cells) => cells.length >= 4);
  const entries = parsed.filter(entryLooksSane);
  const malformed = parsed.length - entries.length;

  const bouts = entries.map((cells) => {
    const [aRaw, aScore, bRaw, bScore] = cells;
    const A = competitor(aRaw);
    const B = competitor(bRaw);
    const a = A.name;
    const b = B.name;
    const aWon = isBold(aRaw);
    const bWon = isBold(bRaw);
    let winner = null;
    let reason = null;
    if (!a || !b) reason = 'the source leaves one side of this bout empty';
    else if (aWon && !bWon) winner = a;
    else if (bWon && !aWon) winner = b;
    else reason = aWon && bWon ? 'the source marks both fighters as winners' : 'the source marks neither fighter as the winner';
    const winnerCell = winner === a ? aScore : bScore;
    const loserCell = winner === a ? bScore : aScore;
    return {
      a,
      b,
      winner,
      method: winner ? expandMethod(winnerCell) : null,
      round: winner && /^\d+$/.test(clean(loserCell)) ? Number(clean(loserCell)) : null,
      seeds: A.seed && B.seed ? `${A.seed} vs ${B.seed}` : null,
      empty: !a || !b,
      reason,
    };
  });

  if (!plan) return { weightClass, stages: null, bouts, size, malformed };

  const stages = [];
  let i = 0;
  for (const [stage, label, count] of plan) {
    const slice = bouts.slice(i, i + count);
    i += count;
    if (slice.length) stages.push({ stage, label, bouts: slice });
  }
  return { weightClass, stages, bouts, size, malformed };
}

/**
 * Find the per-division brackets.
 *
 * Anchored on the bracket templates rather than on headings, because the
 * headings are not consistent enough to search for. Some articles label the
 * division "Welterweight bracket", some nest "Light Heavyweights" and
 * "Lightweights" under a parent "Tournament bracket" that holds nothing
 * itself, and season eighteen splits its two divisions as "Female Fighters"
 * and "Male Fighters". Every one of those has a Round template, so the
 * template is what gets found and the nearest heading above it names the
 * division it belongs to.
 *
 * The heading is used as the source writes it. A plural is folded to the
 * singular only when the singular is one of the weight classes this season is
 * already recorded as having — that is a match against something we hold, not
 * a grammar rule applied to a label whose meaning we are guessing at.
 */
function findBrackets(wt, weightClasses = []) {
  const out = [];
  const seen = new Set();
  const known = new Map(weightClasses.map((w) => [fold(w), w]));
  const re = /\{\{Round\d+/gi;
  let m;
  while ((m = re.exec(wt))) {
    const before = wt.slice(0, m.index);
    const h = [...before.matchAll(/^(={2,6})\s*(.+?)\s*\1\s*$/gm)].pop();
    if (!h) continue;
    let name = titleCase(h[2].replace(/\s*brackets?\s*$/i, ''));
    if (!name) continue;
    const singular = name.replace(/s$/, '');
    if (!known.has(fold(name)) && known.has(fold(singular))) name = known.get(fold(singular));
    else if (known.has(fold(name))) name = known.get(fold(name));
    if (seen.has(fold(name))) continue;
    const body = templateAt(wt, m.index);
    if (!body) continue;
    seen.add(fold(name));
    out.push(parseBracket(body, name));
  }
  return out;
}

/**
 * Read a results table for a season fought as a scored series rather than a
 * tournament. The header names the columns, so the table is only read when it
 * actually declares a Method column and two competitor columns — anything else
 * is some other table on the page and is left alone.
 */
/**
 * The standings of a season decided by points rather than by a bracket.
 *
 * Worth reading rather than inferring from the bouts, because the two do not
 * agree in the way you would expect: season 21 was won by the gym with FEWER
 * wins. Blackzilians took seven of the twelve, American Top Team took five and
 * won the season 400-300, because a result late in the series was worth four
 * times one from the start. Counting wins would produce a confident wrong
 * answer, so the totals are taken from the table that states them.
 */
function parseOverallTable(wt) {
  /* Anchored on the section, not on a header search across the whole article.
   * A lazy scan for "!Teams" starts at the FIRST wikitable and runs forward
   * until it finds one, which meant it opened at the per-bout results table
   * and read twelve fighters as twelve teams. The heading is what identifies
   * this table; the header row only describes it. */
  const section = sliceSection(wt, /^===+\s*Overall table/im);
  if (!section) return null;
  const start = section.search(/\{\|[^\n]*wikitable/i);
  if (start < 0) return null;
  const end = section.indexOf('\n|}', start);
  const table = section.slice(start, end < 0 ? undefined : end);

  const header = table.split(/\n/).filter((l) => /^!/.test(l)).flatMap((l) => l.replace(/^!/, '').split('!!')).map((h) => clean(h).toLowerCase());
  const col = (n) => header.findIndex((h) => h.startsWith(n));
  const iPoints = col('total point') >= 0 ? col('total point') : col('point');
  const iWins = col('win');
  if (iPoints < 0) return null;

  const rows = [];
  for (const rowText of table.split(/\n\|-/).slice(1)) {
    const cells = rowText.split(/\n\|/).slice(1);
    const team = clean(cells[0] || '');
    if (!team) continue;
    const num = (i) => (i >= 0 && /^\d+$/.test(clean(cells[i] || '')) ? Number(clean(cells[i])) : null);
    rows.push({ team, points: num(iPoints), wins: num(iWins) });
  }
  return rows.length ? rows : null;
}

function parseResultsTable(wt) {
  const start = wt.search(/\{\|[^\n]*wikitable[^\n]*\n(?:[^\n]*\n)*?!\s*Home Gym/i);
  if (start < 0) return null;
  const end = wt.indexOf('\n|}', start);
  const table = wt.slice(start, end < 0 ? undefined : end);

  /* The header is its own row, so it is read from the lines that declare it
   * rather than from a positional guess about which block it lands in. */
  const header = table
    .split(/\n/)
    .filter((l) => /^!/.test(l))
    .flatMap((l) => l.replace(/^!/, '').split('!!'))
    .map((h) => clean(h).toLowerCase());
  const col = (name) => header.findIndex((h) => h.startsWith(name));
  const iMethod = col('method');
  const iRound = col('round');
  const iPoints = col('points');
  if (iMethod < 0) return null;

  const bouts = [];
  for (const rowText of table.split(/\n\|-/).slice(1)) {
    const cells = rowText.split(/\n\|/).slice(1);
    if (cells.length <= iMethod) continue;
    const aRaw = cells[0];
    const bRaw = cells[1];
    const a = clean(aRaw);
    const b = clean(bRaw);
    if (!a || !b) continue;
    const aWon = isBold(aRaw);
    const bWon = isBold(bRaw);
    const winner = aWon && !bWon ? a : bWon && !aWon ? b : null;
    const round = iRound >= 0 && /^\d+$/.test(clean(cells[iRound] || '')) ? Number(clean(cells[iRound])) : null;
    const points = iPoints >= 0 && /^\d+$/.test(clean(cells[iPoints] || '')) ? Number(clean(cells[iPoints])) : null;
    bouts.push({ a, b, winner, method: expandMethod(cells[iMethod]), round, points });
  }
  return bouts.length ? { bouts } : null;
}

/* ---------- cast ---------- */

const titleCase = (s) => clean(s).replace(/\b([a-z])/g, (c) => c.toUpperCase());

/**
 * Read one competitor cell into a name and, where the source gives one, a seed.
 *
 * Seeded seasons write the seed into the cell — "1 Roxanne Modafferi", "14
 * Nicco Montaño" — and some cells carry a footnote asterisk. Left in, those
 * become part of the name, and a name with a number welded to the front
 * matches no fighter row and reads as a typo on the page. The seed is real
 * information, so it is separated out rather than thrown away, and recorded
 * the way the hand-built seasons already record it.
 */
/**
 * Final tidy for a name, applied after link resolution rather than before it.
 * Sources sometimes put the sentence's full stop inside the link text —
 * "[[Richard Walsh (MMA)|Richard Walsh.]]" — so the period only appears once
 * the link is unwrapped, which is after any splitting has happened. A real
 * suffix keeps its period: Leonard Gabriel Jr. is not a sentence.
 */
const tidyName = (n) => {
  /* A trailing asterisk is the source's own footnote marker on a roster entry,
   * not part of anybody's name. */
  const t = String(n || '').replace(/\s*\*+\s*$/, '').trim();
  return /(?:[A-Z]|Jr|Sr|St|Dr|Mr|Ms)\.$/.test(t) ? t : t.replace(/\.$/, '').trim();
};

function competitor(cellRaw) {
  let name = tidyName(clean(cellRaw).replace(/\s*\*+\s*$/, ''));
  let seed = null;
  const m = name.match(/^(\d{1,2})\s+(\p{L}.*)$/u);
  if (m) { seed = Number(m[1]); name = m[2].trim(); }
  return { name, seed };
}

function parseCoaches(wt) {
  const sec = sliceSection(wt, /^===\s*Coaches/im);
  if (!sec) return [];
  const out = [];
  for (const line of sec.split(/\n/)) {
    if (!/^\*/.test(line)) continue;
    const txt = clean(line.replace(/^\*+/, ''));
    if (!txt) continue;
    const m = txt.match(/^(.+?)\s*,\s*(.*)$/);
    const name = clean(m ? m[1] : txt);
    const rest = m ? m[2] : '';
    const teamM = rest.match(/(?:head coach of|coach of|assistant coach of)\s+(.+?)(?:\s+team)?$/i);
    out.push({
      team: teamM ? titleCase(teamM[1]) : '',
      name,
      role: /assistant/i.test(rest) ? 'assistant' : 'head',
      ...(rest && !teamM ? { note: rest } : {}),
    });
  }
  return out;
}

/** Split a comma list without breaking inside links or parentheses. */
function splitList(s) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (s.slice(i, i + 2) === '[[') { depth += 1; buf += '[['; i += 1; continue; }
    if (s.slice(i, i + 2) === ']]') { depth -= 1; buf += ']]'; i += 1; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if ((c === ',' || c === '.') && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);

  /* English lists end "A, B and C", so the comma split leaves the conjunction
   * welded to the last name — the archive was carrying 46 contestants called
   * "and Sheldon Westcott". Split on it too, and drop a trailing full stop
   * from the sentence the list sat in. Not from every name, though: "Leonard
   * Gabriel Jr." ends in a period because that is his name, so suffixes and
   * single initials keep theirs. */
  return out
    .flatMap((x) => x.split(/\s+(?:and|&)\s+/i))
    .map((x) => x.trim().replace(/^(?:and|&)\s+/i, '').trim())
    .map((x) => (/\b(?:[A-Z]|Jr|Sr|St|Dr|Mr|Ms)\.$/.test(x) ? x : x.replace(/\.$/, '')))
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Rosters come as nested bullets: a team, then one line per division listing
 * its fighters. A fighter given with a replacement in parentheses is recorded
 * as two entries, the replacement carrying a note, rather than as one entry
 * with a name nobody has.
 */
function parseRosters(wt) {
  const sec = sliceSection(wt, /^===\s*(Fighters|Contestants|Teams)/im);
  if (!sec) return [];
  const teams = [];
  let current = null;
  for (const line of sec.split(/\n/)) {
    const one = line.match(/^\*(?!\*)\s*(.+)$/);
    const two = line.match(/^\*\*+\s*(.+)$/);
    if (one) {
      const name = tidyName(clean(one[1]).replace(/:$/, ''));
      if (!name) continue;
      current = { name, roster: [] };
      teams.push(current);
      continue;
    }
    if (two && current) {
      const txt = two[1];
      const divM = txt.match(/^\s*([^:]+?)\s*:\s*(.+)$/);
      const division = divM ? clean(divM[1]).replace(/s$/, '') : null;
      const listRaw = divM ? divM[2] : txt;
      for (const part of splitList(listRaw)) {
        const repl = part.match(/^(.+?)\s*\(\s*(.+?)\s*\)\s*$/);
        const base = tidyName(clean(repl ? repl[1] : part));
        if (!base) continue;
        current.roster.push({ name: base, ...(division ? { weight_class: division } : {}) });
        if (repl) {
          const sub = tidyName(clean(repl[2]));
          if (sub && /^[A-Z]/.test(sub)) {
            current.roster.push({
              name: sub,
              ...(division ? { weight_class: division } : {}),
              note: `Named by the source as ${base}'s replacement.`,
            });
          }
        }
      }
    }
  }
  return teams.filter((t) => t.roster.length);
}

/* ---------- integrity ---------- */

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A round is only as trustworthy as its shape. Two appearances by one fighter
 * in a single round, or a fighter who reaches a later round without a bout,
 * means the source is internally inconsistent — which gets said, not fixed.
 */
function withIntegrity(previous, stage, weightClass, conflicts) {
  /* The elimination stage is not a round and must not be checked as one.
   *
   * It is defined as "bouts the episode summaries record but the bracket does
   * not include" — a bag, gathered from prose, spanning many episodes. Two
   * things follow, and getting them wrong produced most of this archive's
   * false flags:
   *
   *   A fighter may legitimately appear in it more than once. Rashad Evans
   *   fought twice before season 2's bracket; Tecia Torres fought again after
   *   a second chance. That is the format, not an inconsistency.
   *
   *   A fighter entering the bracket need not appear in it at all, because it
   *   holds only the bouts the bracket left out. Requiring a bracket entrant
   *   to have fought there asks the wrong question of the wrong list.
   *
   * So the shape checks apply between bracket rounds only. */
  const isElimination = stage.stage === 'elimination';
  const bracketPrevious = previous.filter((s) => s.stage !== 'elimination');

  const seen = new Map();
  for (const b of stage.bouts) for (const n of [b.a, b.b]) seen.set(fold(n), (seen.get(fold(n)) || 0) + 1);
  const twice = isElimination ? [] : [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);

  const advanced = new Set(bracketPrevious.flatMap((s) => s.bouts.filter((b) => b.winner).map((b) => fold(b.winner))));
  const unexplained = (!isElimination && bracketPrevious.length)
    ? [...new Set(stage.bouts.flatMap((b) => [b.a, b.b]))].filter((n) => !advanced.has(fold(n)))
    : [];

  const notes = [];
  if (twice.length) notes.push(`${twice.length} fighter(s) appear more than once in this round`);
  if (unexplained.length) notes.push(`${unexplained.length} fighter(s) enter this round without a recorded win in the previous one`);
  if (!notes.length) return stage;

  /* Deliberately describing what was observed rather than declaring the source
   * wrong. A fighter entering a round without a win in the previous one is
   * what a wildcard, a second chance or an injury replacement looks like — all
   * of which these seasons really have — and it is also what an omission looks
   * like. We cannot tell which from the bracket alone, so the round says so
   * and stays unverified instead of picking one. */
  conflicts.push({
    field: `${weightClass}_${stage.stage}`,
    detail: `The source's ${stage.label.toLowerCase()} for this division do not close as a self-contained round: ${notes.join(', ')}. That is what a wildcard, second chance or replacement entry looks like, and also what a missing bout looks like; the bracket alone does not say which. The stated bouts are recorded as given and the round is left unverified rather than reordered into something the source does not say.`,
    retrieved: today(),
  });
  return { ...stage, status: 'unverified', note: `Partial. ${notes.join('; ')}. See conflicts.` };
}

function eliminationStage(bouts) {
  return {
    stage: 'elimination',
    label: 'Elimination round',
    note: "Bouts the episode summaries record but the source's bracket does not include.",
    bouts: bouts.map((e) => ({
      a: e.winner,
      b: e.loser,
      winner: e.winner,
      method: e.method,
      round: e.round,
      time: e.time,
      episode: e.episode,
      classification: e.episode ? 'exhibition' : 'unverified',
      classification_source: e.episode
        ? `filmed during production and broadcast in episode ${e.episode}, not contested on a sanctioned card`
        : null,
    })),
  };
}

function finalBoutFor(row, w) {
  const f = (row.final_bouts || []).find((b) => b.weight_class === w.weight_class);
  if (!f) return null;
  return { a: f.a, b: f.b, event: f.event, date: f.date, verified_against: f.verified_against };
}

/* ---------- assembly ---------- */

const main = async () => {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(PAGE)}&prop=wikitext&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`wikipedia: ${json.error.info}`);
  const wt = json.parse.wikitext;
  const title = json.parse.title;

  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons.json'), 'utf8'));
  const row = inv.seasons.find((s) => s.slug === SLUG);
  if (!row) throw new Error(`${SLUG} is not in seasons.json`);

  const conflicts = [];
  const episodes = parseEpisodes(wt);
  let brackets = findBrackets(wt, row.weight_classes || []);
  const coaches = parseCoaches(wt);
  const teams = parseRosters(wt);

  /* Season twenty-one was not a tournament. Two gyms fought a scored series,
   * points rising as the season went on, and its article carries a results
   * table where every other season carries a bracket. Falling back to that
   * table only when no bracket exists keeps it from touching the seasons that
   * have one, and keeps twenty-one from being filed as "no data" when what it
   * actually has is a different shape of data. */
  let league = null;
  let standings = null;
  if (!brackets.length) {
    league = parseResultsTable(wt);
    if (league) {
      brackets = [];
      standings = parseOverallTable(wt);
      conflicts.push({
        field: 'format',
        detail: `This season has no tournament bracket, and recording one would misdescribe it. The source records ${league.bouts.length} bouts as a scored gym-versus-gym series: results were worth points to a gym rather than a place in a next round, and what a win was worth rose as the season went on. The bouts are kept in the order the source lists them, with no rounds invented to hold them.`,
        retrieved: today(),
      });
    }
  }

  /* The coaches section names a team by its colour — "head coach of blue team"
   * — while the rosters name it after the coach. Neither is wrong, but the
   * archive should not carry a team called "Blue" that matches no roster. A
   * colour resolves to the roster whose name carries the coach's own surname,
   * which is the only link the article actually supports. Where it does not,
   * the source's wording is kept as a note rather than replaced by a guess. */
  for (const c of coaches) {
    if (teams.some((t) => fold(t.name) === fold(c.team))) continue;
    const surname = fold(c.name).split(' ').pop();
    const hit = teams.find((t) => fold(t.name).split(' ').includes(surname));
    if (hit) {
      if (c.team) c.team_in_source = c.team;
      c.team = hit.name;
    } else if (c.team) {
      c.team_in_source = c.team;
      c.team = '';
    }
  }

  const byPair = new Map();
  for (const e of episodes) byPair.set(pairKey(e.winner, e.loser), e);
  const usedPairs = new Set();

  /* Which division the source puts each contestant in. Used only to place
   * bouts the bracket omits, and only when both fighters agree. */
  const division = new Map();
  for (const t of teams) {
    for (const r of t.roster) {
      if (!r.weight_class) continue;
      const k = fold(r.name);
      const v = fold(r.weight_class);
      if (division.has(k) && division.get(k) !== v) division.set(k, null);
      else if (!division.has(k)) division.set(k, v);
    }
  }

  const bracket = [];
  for (const b of brackets) {
    if (!b.stages) {
      conflicts.push({
        field: `${b.weightClass}_bracket`,
        detail: `The source uses a Round${b.size || '?'} bracket, a shape this import does not map to named stages. The division is left out rather than assigned to invented rounds.`,
        retrieved: today(),
      });
      continue;
    }
    if (b.malformed) {
      conflicts.push({
        field: `${b.weightClass}_bracket`,
        detail: `${b.malformed} entr${b.malformed === 1 ? 'y' : 'ies'} in this division's bracket did not read as a bout — a cell where a fighter's name should be was empty or numeric. Those entries are left out rather than recorded as bouts whose participants we guessed at, and the rest of the division is recorded as normal.`,
        retrieved: today(),
      });
    }

    const stages = [];
    for (const st of b.stages) {
      const bouts = [];
      for (const raw of st.bouts) {
        /* A bracket cell with only one side filled in is not a bout. It is
         * usually a bye or a walkover the source did not spell out, and
         * recording it as a contest against nobody would put an empty name on
         * the page and in the archive. */
        if (raw.empty) {
          conflicts.push({
            field: `${b.weightClass}_${st.stage}`,
            detail: `The source's bracket has a slot holding only ${raw.a || raw.b || 'an unnamed competitor'}, with no opponent. It is left out of the round rather than recorded as a bout against nobody.`,
            retrieved: today(),
          });
          continue;
        }

        const key = pairKey(raw.a, raw.b);
        const ep = byPair.get(key);
        if (ep) usedPairs.add(key);

        /* The two sources are allowed to complete each other but not to
         * overrule each other. A disagreement about the winner is the one
         * thing that cannot be reconciled by preferring a field. */
        let winner = raw.winner;
        if (ep && raw.winner && fold(ep.winner) !== fold(raw.winner)) {
          conflicts.push({
            field: `${b.weightClass}_${st.stage}`,
            detail: `The bracket and the episode summary disagree about ${raw.a} versus ${raw.b}: the bracket advances ${raw.winner}, the episode text says ${ep.winner} won. Recorded with no winner.`,
            retrieved: today(),
          });
          winner = null;
        } else if (!winner && ep) {
          winner = ep.winner;
        }
        if (raw.reason && !ep) {
          conflicts.push({
            field: `${b.weightClass}_${st.stage}`,
            detail: `For ${raw.a} versus ${raw.b}, ${raw.reason}, and no episode summary settles it. Recorded with no winner.`,
            retrieved: today(),
          });
        }

        const isFinal = st.stage === 'final';

        /* The one place a bout here can be called professional. Not because it
         * sits in the final slot — that is the blanket reasoning to avoid —
         * but because seasons.json already holds this exact pairing as a bout
         * checked against one of our own result rows. The evidence is the
         * verification, and it is quoted rather than summarised. */
        /* Matched with the shared name matcher, not a strict fold. The two
         * files spell the same fighter differently often enough that a strict
         * comparison left twelve verified finals sitting in the bracket as
         * 'unverified' — the evidence existed and the lookup could not see it,
         * which reads as missing verification rather than as a failed match. */
        const aliasA = aliasFor(raw.a);
        const aliasB = aliasFor(raw.b);
        const verified = (row.final_bouts || []).find((f) => {
          if (!f.verified_against) return false;
          for (const x of [raw.a, aliasA].filter(Boolean)) {
            for (const y of [raw.b, aliasB].filter(Boolean)) {
              if (pairMatch(f.a, f.b, x, y).same) return true;
            }
          }
          return false;
        });
        if (isFinal && verified) {
          bouts.push({
            ...(aliasA ? { a_in_records: aliasA } : {}),
            ...(aliasB ? { b_in_records: aliasB } : {}),
            a: raw.a,
            b: raw.b,
            winner: verified.winner,
            method: verified.method || raw.method || null,
            round: verified.round ?? raw.round ?? null,
            time: verified.time || null,
            episode: null,
            fight_date: verified.date || null,
            classification: 'professional',
            classification_source: `contested on a sanctioned UFC card; verified against ${verified.verified_against}`,
            on_finale_card: true,
            tournament_deciding: true,
          });
          continue;
        }

        const classified = !isFinal && ep && ep.episode
          ? {
              classification: 'exhibition',
              classification_source: `filmed during production and broadcast in episode ${ep.episode}, not contested on a sanctioned card`,
            }
          : { classification: 'unverified', classification_source: null };

        bouts.push({
          ...(aliasA ? { a_in_records: aliasA } : {}),
          ...(aliasB ? { b_in_records: aliasB } : {}),
          a: raw.a,
          b: raw.b,
          winner: winner || null,
          method: (ep && ep.method) || raw.method || null,
          round: (ep && ep.round) ?? raw.round ?? null,
          time: (ep && ep.time) || null,
          episode: (ep && ep.episode) ?? null,
          ...classified,
          ...(raw.seeds ? { seeds: raw.seeds } : {}),
          ...(isFinal ? { on_finale_card: true, tournament_deciding: true } : {}),
        });
      }
      stages.push({ stage: st.stage, label: st.label, bouts });
    }

    /* Bouts the prose records that the bracket does not contain are the
     * elimination round. They are labelled for what they are — bouts the
     * bracket omits — not slotted into a round the source never named.
     *
     * Placing one in a division needs evidence, and the rosters are it: the
     * source lists every contestant under a weight class, so a bout between
     * two fighters the source puts in this division belongs to this division.
     * A bout whose two fighters are listed under different divisions, or whose
     * fighters the rosters do not cover, stays unplaced and is reported. */
    const leftovers = episodes.filter((e) => {
      const k = pairKey(e.winner, e.loser);
      if (usedPairs.has(k)) return false;
      if (brackets.length === 1) {
        const names = new Set(b.stages.flatMap((s) => s.bouts.flatMap((x) => [fold(x.a), fold(x.b)])));
        return names.has(fold(e.winner)) || names.has(fold(e.loser));
      }
      const dw = division.get(fold(e.winner));
      const dl = division.get(fold(e.loser));
      return dw && dl && dw === dl && dw === fold(b.weightClass);
    });
    if (leftovers.length) {
      for (const e of leftovers) usedPairs.add(pairKey(e.winner, e.loser));
      stages.unshift(eliminationStage(leftovers));
    }

    /* Integrity is checked here, over the finished ordered list, and not as
     * each stage is built. The elimination round is prepended after the
     * bracket rounds exist, so a check that ran during construction would ask
     * whether the semi-finalists came from somewhere while the round they came
     * from was not yet in the list — and conclude, wrongly, that nothing was
     * out of place. */
    const checked = [];
    for (const st of stages) checked.push(withIntegrity(checked, st, b.weightClass, conflicts));
    bracket.push({ weight_class: b.weightClass, stages: checked });
  }

  /* The scored series, if this is one of those seasons. Its bouts go in as a
   * single stage under the season's own weight class. They are not called a
   * round of anything, because they were not one. */
  if (league) {
    bracket.push({
      weight_class: row.weight_classes?.[0] || 'Tournament',
      stages: [{
        stage: 'elimination',
        label: 'Gym versus gym',
        note: 'This season was scored, not bracketed: each result was worth points to a gym rather than a place in a next round, and the points rose as the season went on. The bouts are listed in the order the source gives them.',
        bouts: league.bouts.map((b) => ({
          a: b.a,
          b: b.b,
          winner: b.winner,
          method: b.method,
          round: b.round,
          time: null,
          episode: null,
          points: b.points,
          classification: 'exhibition',
          classification_source: 'contested inside the season as part of the scored gym-versus-gym series, not on a sanctioned card',
        })),
      }],
    });
  }

  /* The season's actual shape, recorded as itself.
   *
   * A scored series has two things a bracket does not: standings, and a
   * concluding bout that is not the last node of a tree. Season 21 makes the
   * difference concrete — American Top Team won it 400-300 having won FIVE of
   * the twelve bouts to Blackzilians' seven, because a result late in the
   * series was worth four times one from the start. Anything that reads the
   * winner off the bout list gets that backwards.
   *
   * The concluding bout is taken from the inventory's verified final, which is
   * where the checked-against-our-records version lives. It is deliberately
   * NOT pushed into the bracket: it was contested on the finale card, months
   * after the series, and filing it as the last rung of a ladder the season
   * did not have is exactly the misdescription this block exists to avoid. */
  let teamCompetition = null;
  if (league) {
    const finals = row.final_bouts || [];
    const concluding = finals.find((f) => f.verified_against) || finals[0] || null;
    teamCompetition = {
      format: 'gym versus gym, decided on points',
      note: "Two gyms rather than two coaches, and no tournament bracket. Each result was worth points to a gym — 25 early in the season, then 50, then 100 — so the season was won on points rather than by a last fighter standing. American Top Team took it with fewer wins than Blackzilians.",
      ...(standings ? { standings } : {}),
      ...(concluding
        ? {
            concluding_bout: {
              a: concluding.a,
              b: concluding.b,
              winner: concluding.winner,
              method: concluding.method ?? null,
              round: concluding.round ?? null,
              weight_class: concluding.weight_class ?? null,
              event: concluding.event ?? null,
              date: concluding.date ?? null,
              verified_against: concluding.verified_against ?? null,
              note: 'Contested on the finale card, on a sanctioned UFC card, months after the series it concluded. It decided the individual contract; the gym competition was already decided on points.',
            },
          }
        : {}),
    };
  }

  /* Any remaining prose bout belongs to no division we could place it in. */
  const orphans = episodes.filter((e) => !usedPairs.has(pairKey(e.winner, e.loser)));
  if (orphans.length && bracket.length) {
    conflicts.push({
      field: 'unplaced_bouts',
      detail: `${orphans.length} bout(s) appear in the episode summaries but in no bracket: ${orphans.map((o) => `${o.winner} def. ${o.loser}`).join('; ')}. Left unplaced rather than assigned to a division by guesswork.`,
      retrieved: today(),
    });
  }

  const detail = {
    slug: SLUG,
    name: row.name,
    edition: row.edition,
    number: row.number,
    year: row.year,
    weight_classes: row.weight_classes,
    _provenance: {
      primary: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      retrieved: today(),
      note: 'Drafted from the source article by scripts/tuf/import_season.mjs, which reads the bracket templates and the episode summaries separately and joins them. Where the two disagree the bout carries no winner and the disagreement is recorded in _conflicts. Finale results are not asserted here; they are verified against our own result rows in seasons.json.',
    },
    ...(conflicts.length ? { _conflicts: conflicts } : {}),
    ...(coaches.length ? { coaches } : {}),
    ...(teams.length ? { teams } : {}),
    ...(teamCompetition ? { team_competition: teamCompetition } : {}),
    ...(bracket.length ? { bracket } : {}),
    ...(row.finale_event
      ? {
          finale: {
            event_name: row.finale_event,
            event_date: row.finale_date,
            link_policy: 'Linked to our own event row. The final is verified in seasons.json against a real result, not restated here.',
          },
        }
      : {}),
    ...(row.winners?.length
      ? {
          champions: row.winners.map((w) => {
            const fb = finalBoutFor(row, w);
            return {
              weight_class: w.weight_class,
              fighter: w.fighter,
              won_tournament: true,
              received_contract: true,
              ...(fb ? { winning_bout: { a: fb.a, b: fb.b, event: fb.event, date: fb.date }, verified_against: fb.verified_against } : {}),
            };
          }),
        }
      : {}),
  };

  const counts = {
    bouts: bracket.reduce((n, d) => n + d.stages.reduce((m, s) => m + s.bouts.length, 0), 0),
    unverified_stages: bracket.reduce((n, d) => n + d.stages.filter((s) => s.status === 'unverified').length, 0),
    no_winner: bracket.reduce((n, d) => n + d.stages.reduce((m, s) => m + s.bouts.filter((x) => !x.winner).length, 0), 0),
  };
  console.log(`${SLUG}  <-  ${title}`);
  console.log(`  divisions ${bracket.length}   bouts ${counts.bouts}   episodes parsed ${episodes.length}`);
  console.log(`  coaches ${coaches.length}   teams ${teams.length}   conflicts ${conflicts.length}`);
  console.log(`  stages flagged unverified ${counts.unverified_stages}   bouts with no winner ${counts.no_winner}`);
  for (const c of conflicts) console.log(`    ! ${c.field}: ${c.detail.slice(0, 160)}`);

  /* Coverage is a claim about how good the bracket is, so it is derived from
   * the bracket rather than asserted. Full means every division has a final
   * and no round was flagged; partial means a bracket exists but something in
   * it is unresolved. A season with no bracket at all keeps metadata_only. */
  const everyDivisionComplete =
    bracket.length === (row.weight_classes?.length || bracket.length) &&
    bracket.every((d) => d.stages.some((s) => s.stage === 'final' && s.bouts.length));
  const nothingFlagged =
    counts.unverified_stages === 0 && counts.no_winner === 0 && conflicts.length === 0;
  const nextCoverage = !bracket.length
    ? 'metadata_only'
    : everyDivisionComplete && nothingFlagged
      ? 'bracket_full'
      : 'bracket_partial';

  const file = path.join(OUT, `${SLUG}.json`);
  console.log(`  coverage ${row.coverage} -> ${nextCoverage}`);
  if (!WRITE) { console.log(`\n(dry run — pass --write to save ${path.relative(ROOT, file)})`); return; }
  if (fs.existsSync(file)) {
    console.error(`refusing to overwrite ${path.relative(ROOT, file)} — hand-built files are not regenerated`);
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify(detail, null, 2) + '\n');

  /* The inventory row points at the detail file. A season that claims bracket
   * coverage without that pointer renders from its metadata alone, so the two
   * are written together rather than left to be remembered separately. */
  if (row.coverage !== nextCoverage || (bracket.length && row.detail !== SLUG)) {
    row.coverage = nextCoverage;
    if (bracket.length) row.detail = SLUG;
    fs.writeFileSync(path.join(ROOT, 'web', 'data', 'tuf', 'seasons.json'), JSON.stringify(inv, null, 2) + '\n');
  }
  console.log(`\nwrote ${path.relative(ROOT, file)}`);
};

main().catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
