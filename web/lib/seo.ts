/* Search snippet copy built from verified structured facts. Run: npm run test:seo
 *
 * Search Console shows the historical fight archive already ranking on page
 * one (positions 3-10) for "fight result + stats + referee + event +
 * scorecards" intent, with near-zero CTR. The titles are earning the ranking,
 * so they stay. What changes is the description: it states the facts a
 * searcher came for, taken from the same rows the page renders.
 *
 * Every input is nullable and null means the clause is omitted. Nothing here
 * may invent a referee, a score or a stat to fill space.
 *
 * Pure: no server-only imports, so node:test can load it directly. */

export const DESCRIPTION_MAX = 160;

/* Greedy fit. The first part is the anchor sentence and is always kept; each
 * later part is appended only if the whole still fits, otherwise skipped so a
 * shorter later clause can still land. Order is priority. */
export function fitParts(parts: Array<string | null | undefined | false>, max = DESCRIPTION_MAX): string {
  const list = parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim());
  if (!list.length) return "";
  let out = list[0];
  for (const p of list.slice(1)) {
    if (out.length + 1 + p.length <= max) out = `${out} ${p}`;
  }
  return out;
}

/* A shorter event label for a description whose title already carries the
 * full event name. Only unambiguous forms are shortened: a numbered UFC event
 * and a Contender Series week. A Fight Night keeps its full name, because
 * "UFC Fight Night" alone identifies nothing. */
export function shortEventName(name: string): string {
  const numbered = name.match(/^(UFC \d+)\b/i);
  if (numbered) return numbered[1];
  const dwcs = name.match(/^Dana White['’]s Contender Series(?: Brazil)?:?\s*Season (\d+),?\s*Week (\d+)/i);
  if (dwcs) return `${/Brazil/i.test(name) ? "DWCS Brazil" : "DWCS"} Season ${dwcs[1]}, Week ${dwcs[2]}`;
  return name;
}

export type FightSeoFacts = {
  a: string;
  b: string;
  winner: string | null;
  loser: string | null;
  /* Stored method code (KO_TKO, SUB, DEC_U, ...) and its display label. */
  methodCode: string | null;
  methodLabel: string | null;
  finishDetail: string | null;
  round: number | null;
  /* "3:14", already formatted. */
  time: string | null;
  event: string;
  /* "Aug 3, 2013", already formatted; null when the date is unknown. */
  date: string | null;
  referee: string | null;
  /* Significant strikes landed, oriented to (a, b). */
  sigStrikes: { a: number; b: number } | null;
  /* Winner-oriented judge scores ("30–27"), only when attributed from the
   * bout's own cards. Empty for finishes and for unattributed pairs. */
  scorecards: string[];
  roundStats: boolean;
  fightDna: boolean;
};

const DECISION_CODES = new Set(["DEC_U", "DEC_S", "DEC_M"]);

function methodPhrase(f: FightSeoFacts): string {
  const code = f.methodCode || "";
  if (DECISION_CODES.has(code)) return `by ${String(f.methodLabel || "decision").toLowerCase()}`;
  const when = f.round ? ` in round ${f.round}${f.time ? ` (${f.time})` : ""}` : "";
  if (code === "KO_TKO") return `by KO/TKO${when}`;
  if (code === "SUB") {
    const detail = f.finishDetail && f.finishDetail.length <= 28 ? ` (${f.finishDetail.toLowerCase()})` : "";
    return `by submission${detail}${when}`;
  }
  if (code === "DQ") return `by disqualification${when}`;
  return f.methodLabel ? `by ${f.methodLabel.toLowerCase()}${when}` : when.trim();
}

/* The anchor sentence: who won, how, where and when. */
export function fightResultSentence(f: FightSeoFacts, eventLabel = shortEventName(f.event)): string {
  const at = `at ${eventLabel}${f.date ? ` (${f.date})` : ""}`;
  const code = f.methodCode || "";
  if (f.winner && f.loser) {
    const how = methodPhrase(f);
    return `${f.winner} defeated ${f.loser}${how ? ` ${how}` : ""} ${at}.`;
  }
  if (code === "DRAW") return `${f.a} and ${f.b} fought to a ${String(f.methodLabel || "draw").toLowerCase()} ${at}.`;
  if (code === "NC") return `${f.a} vs ${f.b} ${at} ended in a no contest.`;
  return `${f.a} vs ${f.b} ${at}: official result.`;
}

/* Strikes read winner-first when there is a winner, because the anchor
 * sentence has just named the winner first. */
function strikeClause(f: FightSeoFacts): string | null {
  if (!f.sigStrikes) return null;
  const { a, b } = f.sigStrikes;
  const winnerIsB = f.winner != null && f.winner === f.b;
  const [x, y] = winnerIsB ? [b, a] : [a, b];
  return `Sig. strikes ${x}–${y}.`;
}

function toolsClause(f: FightSeoFacts): string | null {
  const tools = [f.roundStats ? "round-by-round stats" : null, f.fightDna ? "Fight DNA" : null].filter(Boolean) as string[];
  if (!tools.length) return null;
  const joined = tools.join(" and ");
  return `${joined[0].toUpperCase()}${joined.slice(1)}.`;
}

export function fightResultDescription(f: FightSeoFacts, max = DESCRIPTION_MAX): string {
  return fitParts([
    fightResultSentence(f),
    f.referee ? `Referee: ${f.referee}.` : null,
    f.scorecards.length ? `Scorecards ${f.scorecards.join(", ")}.` : null,
    strikeClause(f),
    toolsClause(f),
  ], max);
}

export type EventSeoFacts = {
  name: string;
  date: string | null;
  where: string | null;
  bouts: number;
  finishes: number;
  decisions: number;
  titleFights: number;
  /* Main event sentence already built with fightResultSentence semantics,
   * or null when the main event has no stored result. */
  mainResult: string | null;
  roundStats: boolean;
};

export function eventResultsDescription(e: EventSeoFacts, max = DESCRIPTION_MAX): string {
  const head = `${e.name} results${e.date ? ` (${e.date}${e.where ? `, ${e.where}` : ""})` : ""}.`;
  const count = e.bouts
    ? `${e.bouts} ${e.bouts === 1 ? "bout" : "bouts"}: ${e.finishes} ${e.finishes === 1 ? "finish" : "finishes"}, ${e.decisions} ${e.decisions === 1 ? "decision" : "decisions"}${e.titleFights ? `, ${e.titleFights} title ${e.titleFights === 1 ? "fight" : "fights"}` : ""}.`
    : null;
  return fitParts([
    head,
    e.mainResult,
    count,
    `Method, round and time for every fight${e.roundStats ? ", plus round stats" : ""}.`,
  ], max);
}

export type FighterSeoFacts = {
  name: string;
  record: string | null;
  archive: { fights: number; w: number; l: number; d: number; ko: number; sub: number; dec: number } | null;
  sigLanded: number | null;
  statRounds: number;
  fightDna: boolean;
  /* Only a genuinely scheduled, not-cancelled, future bout. */
  next: { opponent: string; event: string; date: string | null } | null;
};

export function fighterTitle(name: string, nickname: string | null, hasNextFight: boolean): string {
  return `${name}${nickname ? ` “${nickname}”` : ""} — UFC Record, Stats & ${hasNextFight ? "Next Fight" : "Fight History"}`;
}

export function fighterDescription(f: FighterSeoFacts, max = DESCRIPTION_MAX): string {
  const head = f.record && f.record !== "—" ? `${f.name} UFC record and stats: ${f.record} pro record.` : `${f.name} UFC record and stats.`;
  const a = f.archive;
  /* Win methods only where non-zero: "(0 KO/TKO, 0 submissions)" is noise. */
  const how = a ? [a.ko ? `${a.ko} KO/TKO` : null, a.sub ? `${a.sub} by submission` : null, a.dec ? `${a.dec} by decision` : null].filter(Boolean).join(", ") : "";
  const archive = a && a.fights
    ? `${a.w}-${a.l}${a.d ? `-${a.d}` : ""} in ${a.fights} archived UFC ${a.fights === 1 ? "fight" : "fights"}${how ? ` (wins: ${how})` : ""}.`
    : null;
  const next = f.next ? `Next: vs ${f.next.opponent} at ${shortEventName(f.next.event)}${f.next.date ? ` (${f.next.date})` : ""}.` : null;
  const strikes = f.sigLanded != null && f.statRounds > 0 ? `${f.sigLanded.toLocaleString("en-US")} sig. strikes in ${f.statRounds} ${f.statRounds === 1 ? "round" : "rounds"}.` : null;
  const tools = ["Fight history", f.statRounds > 0 ? "round stats" : null, f.fightDna ? "Fight DNA" : null].filter(Boolean) as string[];
  const toolsLine = `${tools.join(", ")}.`;
  return fitParts([head, next, archive, strikes, toolsLine], max);
}

/* Newsroom search titles.
 *
 * The editorial headline stays the on-page H1. Two targeted changes only:
 *
 * 1. A generator-template preview headline ("A vs. B: women's flyweight prelim
 *    preview at EVENT") describes the article's format, not what it contains.
 *    Its search title names the sections the article actually carries.
 * 2. A headline already longer than a search result can show loses the brand
 *    suffix instead of losing its own last words; Google prints the site name
 *    separately. */
const TEMPLATE_PREVIEW = /^(.+?\s+vs\.?\s+.+?):\s+(?:women['’]s\s+)?[a-z ]+?\s+(?:main card|prelims?|early prelims?)\s+preview\s+at\s+(.+)$/i;
export const TITLE_SUFFIX = " — PropBetEdge UFC";
export const TITLE_VISIBLE = 65;

export function newsSearchTitle(headline: string, sectionHeadings: string[]): { title: string; absolute: boolean } {
  const m = headline.match(TEMPLATE_PREVIEW);
  if (m) {
    const has = (re: RegExp) => sectionHeadings.some((h) => re.test(h));
    const parts = [
      has(/^tale of the tape$/i) ? "Tale of the Tape" : null,
      has(/^recent form$/i) ? "Recent Form" : null,
      has(/^style and statistical matchup$/i) ? "Stats Matchup" : null,
    ].filter(Boolean) as string[];
    if (parts.length) {
      const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} & ${parts[parts.length - 1]}` : parts[0];
      const title = `${m[1]} Preview: ${list}`;
      return { title, absolute: title.length + TITLE_SUFFIX.length > TITLE_VISIBLE };
    }
  }
  return { title: headline, absolute: headline.length + TITLE_SUFFIX.length > TITLE_VISIBLE };
}

/* UTM stripping for inbound links. Only utm_* marketing keys are
 * removed; every other query parameter is functional somewhere on this site
 * (?q=, ?season=, ?series=, ?tab=) and survives untouched. Returns null when
 * nothing needs to change. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

export function stripUtm(search: string): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (/^utm_/i.test(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return null;
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
