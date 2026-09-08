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

const isBold = (s) => /'''/.test(String(s || ''));
const fold = (n) => clean(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();
const pairKey = (a, b) => [fold(a), fold(b)].sort().join(' :: ');

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
function parseEpisodes(wt) {
  const bouts = [];
  const section = sliceSection(wt, /^==\s*Episodes?/im);
  if (!section) return bouts;
  let episode = null;
  for (const raw of section.split(/\n/)) {
    const head = raw.match(/'''Episode\s+(\d+)/i);
    if (head) { episode = Number(head[1]); continue; }
    if (!/^\*/.test(raw)) continue;
    const m = raw.match(
      /^\*+\s*'''(?<w>[^']+)'''\s+(?:defeated|defeats|def\.)\s+(?<l>.+?)\s+by\s+(?<method>.+?)(?:\s+at\s+(?<time>\d{1,2}:\d{2})\s+of\s+the\s+(?<rw>\w+)\s+round|\s+after\s+(?<rw2>\w+)\s+rounds?)?\s*\.?\s*$/i,
    );
    if (!m) continue;
    const g = m.groups;
    const rw = (g.rw || g.rw2 || '').toLowerCase();
    bouts.push({
      winner: clean(g.w),
      loser: clean(g.l).replace(/\s*\(.*\)\s*$/, ''),
      method: titleMethod(clean(g.method)),
      round: ROUND_WORDS[rw] ?? null,
      time: g.time || null,
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
  const entries = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\|\|/)
    .slice(1)
    .map((e) => splitPipes(e))
    .filter((cells) => cells.length >= 4 && clean(cells[0]));

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

  if (!plan) return { weightClass, stages: null, bouts, size };

  const stages = [];
  let i = 0;
  for (const [stage, label, count] of plan) {
    const slice = bouts.slice(i, i + count);
    i += count;
    if (slice.length) stages.push({ stage, label, bouts: slice });
  }
  return { weightClass, stages, bouts, size };
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
  return /(?:[A-Z]|Jr|Sr|St|Dr|Mr|Ms)\.$/.test(t) ? t : t.replace(/\.$/, '').trim();
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
  const seen = new Map();
  for (const b of stage.bouts) for (const n of [b.a, b.b]) seen.set(fold(n), (seen.get(fold(n)) || 0) + 1);
  const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);

  const advanced = new Set(previous.flatMap((s) => s.bouts.filter((b) => b.winner).map((b) => fold(b.winner))));
  const unexplained = previous.length
    ? [...new Set(stage.bouts.flatMap((b) => [b.a, b.b]))].filter((n) => !advanced.has(fold(n)))
    : [];

  const notes = [];
  if (twice.length) notes.push(`${twice.length} fighter(s) appear more than once in this round`);
  if (unexplained.length) notes.push(`${unexplained.length} fighter(s) appear here without a bout in the previous round`);
  if (!notes.length) return stage;

  conflicts.push({
    field: `${weightClass}_${stage.stage}`,
    detail: `The source's ${stage.label.toLowerCase()} for this division do not form a consistent round: ${notes.join(', ')}. The stated bouts are recorded as given and the round is marked partial rather than reordered into something the source does not say.`,
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
  if (!brackets.length) {
    league = parseResultsTable(wt);
    if (league) {
      brackets = [];
      conflicts.push({
        field: 'format',
        detail: `This season has no tournament bracket. The source records ${league.bouts.length} bouts as a scored gym-versus-gym series, with the points each result was worth, and that is what is recorded here — under the season's single weight class, in the order the source lists them, with no rounds invented to hold them.`,
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
        const verified = (row.final_bouts || []).find((f) => pairKey(f.a, f.b) === key && f.verified_against);
        if (isFinal && verified) {
          bouts.push({
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
