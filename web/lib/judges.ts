import "server-only";
import { cache } from "react";
import {
  buildBoutScorecard, classifyGap, dissentRead, judgeSlug, resolveJudge, wentToTheJudges,
  PROVISIONAL_IDENTITY_CANDIDATES, SPELLING_VARIANT_EVIDENCE,
  type AttributedCard, type DecisionType, type DrawType, type GapClassification, type GapReason,
  type ProvisionalCandidate,
} from "@/lib/judgeScoring";

/* Judge intelligence data access.
 *
 * Reads the BASE tables (ufc_bout_results / ufc_bouts / ufc_events /
 * ufc_fighters) and derives the judge layer in process using the same rules
 * as supabase/migrations/20260908000012_ufc_judge_intelligence.sql. Reading
 * base tables rather than the migration's views is deliberate: the migration
 * is checked in but deliberately not applied, and a product surface that only
 * works after a DDL step is a product surface that is not yet real. When the
 * views land, the rules above them are already proven by the same code.
 *
 * Every reader fails to an empty result, like lib/db.ts: a missing env var or
 * a network fault renders empty states, never a 500. */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PAGE = 1000;
export const REVALIDATE = 900;

function headers() {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

async function rest<T>(path: string, fallback: T, revalidate = REVALIDATE): Promise<T> {
  if (!URL_ || !KEY) return fallback;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: headers(), next: { revalidate } });
    if (!res.ok) {
      console.error(`[judges] ${path.split("?")[0]} -> HTTP ${res.status}`);
      return fallback;
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : fallback;
  } catch (e) {
    console.error(`[judges] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return fallback;
  }
}

/* PostgREST caps a response; the scorecard archive is several thousand rows,
 * so walk it rather than silently rendering the first page as the whole
 * archive — a truncated directory is worse than none. */
async function restAll<T>(pathWithoutRange: string, revalidate = REVALIDATE): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 40000; offset += PAGE) {
    const page = await rest<T[]>(`${pathWithoutRange}&limit=${PAGE}&offset=${offset}`, [], revalidate);
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/* ---- shapes ------------------------------------------------------------ */

type NamedFighter = { id: string; name: string };
type RawScorecardRow = {
  bout_id: string;
  method: string;
  method_raw: string;
  winner_id: string | null;
  result_source: string;
  source_url: string;
  scorecards: Array<{ judge?: string; score?: string }> | null;
  bout: {
    id: string; weight_class: string | null; is_womens: boolean; is_title: boolean;
    scheduled_rounds: number | null; card_position: string | null;
    fighter_a: NamedFighter | NamedFighter[] | null;
    fighter_b: NamedFighter | NamedFighter[] | null;
    event: { id: string; name: string; event_date: string | null; venue: string | null; city: string | null; region: string | null; country: string | null } | null;
  } | null;
};

export type JudgeCard = AttributedCard & {
  boutId: string;
  method: string;
  methodRaw: string;
  decisionType: DecisionType | null;
  drawType: DrawType | null;
  boutDissentCards: number;
  boutCardCount: number;
  panel: string[];
  weightClass: string | null;
  isWomens: boolean;
  isTitle: boolean;
  scheduledRounds: number | null;
  cardPosition: string | null;
  eventId: string;
  eventName: string;
  eventDate: string | null;
  venue: string | null;
  city: string | null;
  country: string | null;
  fighterAId: string;
  fighterAName: string;
  fighterBId: string;
  fighterBName: string;
  winnerId: string | null;
  winnerName: string | null;
  favoredFighterName: string | null;
  resultSource: string;
  sourceUrl: string;
};

export type JudgeProfile = {
  name: string;
  displayName: string;
  slug: string;
  /** Raw archive spellings merged into this identity. */
  mergedSpellings: string[];
  cards: number;
  bouts: number;
  decisionCards: number;
  unanimousCards: number;
  splitCards: number;
  majorityCards: number;
  drawBoutCards: number;
  evenCards: number;
  /** Cards whose orientation resolved — the only valid denominator for dissent. */
  attributedCards: number;
  dissentCards: number;
  titleCards: number;
  fiveRoundCards: number;
  wideCards: number;
  avgScoreMargin: number | null;
  firstEventDate: string | null;
  lastEventDate: string | null;
};

export type JudgeArchive = {
  judges: JudgeProfile[];
  bySlug: Map<string, JudgeProfile>;
  cardsBySlug: Map<string, JudgeCard[]>;
  totals: {
    cards: number;
    bouts: number;
    attributedCards: number;
    dissentCards: number;
    unattributedCards: number;
    /** Draws: no winner exists to anchor the score order to. */
    unattributedNoWinner: number;
    /** Bouts whose card tally contradicts the recorded winner. */
    unattributedConflicting: number;
    avgScoreMargin: number | null;
    titleCards: number;
    drawCards: number;
    shapeMismatchBouts: number;
    firstEventDate: string | null;
    lastEventDate: string | null;
  };
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] || null : v || null);

const SELECT =
  "bout_id,method,method_raw,winner_id,result_source,source_url,scorecards," +
  "bout:ufc_bouts!inner(id,weight_class,is_womens,is_title,scheduled_rounds,card_position," +
  "fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name)," +
  "fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name)," +
  "event:ufc_events!inner(id,name,event_date,venue,city,region,country))";

/* One read builds the whole judge layer; every page then slices it. `cache`
 * dedupes within a render, the fetch revalidate window across renders. */
export const getJudgeArchive = cache(async (): Promise<JudgeArchive> => {
  const rows = await restAll<RawScorecardRow>(`ufc_bout_results?select=${SELECT}&scorecards=not.is.null&order=bout_id.asc`);

  const cardsBySlug = new Map<string, JudgeCard[]>();
  const nameBySlug = new Map<string, string>();
  const rawBySlug = new Map<string, Set<string>>();
  let shapeMismatchBouts = 0;
  let unattributedNoWinner = 0;
  let unattributedConflicting = 0;

  for (const row of rows) {
    const bout = row.bout;
    const fa = one<NamedFighter>(bout?.fighter_a);
    const fb = one<NamedFighter>(bout?.fighter_b);
    const ev = bout?.event;
    if (!bout || !fa || !fb || !ev) continue;

    const sheet = buildBoutScorecard({
      method: row.method, scorecards: row.scorecards, winnerId: row.winner_id,
      fighterAId: fa.id, fighterBId: fb.id,
    });
    if (!sheet.hasOfficialScorecard) continue;
    if (sheet.cardShapeMatchesMethod === false) shapeMismatchBouts += 1;

    const winnerName = row.winner_id === fa.id ? fa.name : row.winner_id === fb.id ? fb.name : null;
    for (const card of sheet.cards) {
      if (card.orientationBasis === "unresolved_no_winner") unattributedNoWinner += 1;
      else if (card.orientationBasis === "unresolved_conflicting_cards") unattributedConflicting += 1;
      const slug = card.judgeSlug;
      if (!slug) continue;
      nameBySlug.set(slug, card.judge);
      if (!rawBySlug.has(slug)) rawBySlug.set(slug, new Set());
      if (card.rawJudge && card.rawJudge !== card.judge && !card.cardNote) rawBySlug.get(slug)!.add(card.rawJudge);
      const favoredName = card.favoredFighterId === fa.id ? fa.name : card.favoredFighterId === fb.id ? fb.name : null;
      const list = cardsBySlug.get(slug) || [];
      list.push({
        ...card,
        boutId: row.bout_id, method: row.method, methodRaw: row.method_raw,
        decisionType: sheet.decisionType, drawType: sheet.drawType,
        boutDissentCards: sheet.dissentCards, boutCardCount: sheet.cardCount,
        panel: sheet.cards.map((c) => c.judge),
        weightClass: bout.weight_class, isWomens: bout.is_womens, isTitle: bout.is_title,
        scheduledRounds: bout.scheduled_rounds, cardPosition: bout.card_position,
        eventId: ev.id, eventName: ev.name, eventDate: ev.event_date, venue: ev.venue, city: ev.city, country: ev.country,
        fighterAId: fa.id, fighterAName: fa.name, fighterBId: fb.id, fighterBName: fb.name,
        winnerId: row.winner_id, winnerName, favoredFighterName: favoredName,
        resultSource: row.result_source, sourceUrl: row.source_url,
      });
      cardsBySlug.set(slug, list);
    }
  }

  const judges: JudgeProfile[] = [];
  for (const [slug, cards] of cardsBySlug) {
    cards.sort((a, b) => String(b.eventDate || "").localeCompare(String(a.eventDate || "")));
    const dates = cards.map((c) => c.eventDate).filter(Boolean) as string[];
    const margins = cards.map((c) => c.scoreMargin).filter((m) => Number.isFinite(m));
    const attributed = cards.filter((c) => c.isDissent !== null);
    judges.push({
      name: nameBySlug.get(slug) || slug,
      displayName: nameBySlug.get(slug) || slug,
      slug,
      mergedSpellings: [...(rawBySlug.get(slug) || [])].sort(),
      cards: cards.length,
      bouts: new Set(cards.map((c) => c.boutId)).size,
      decisionCards: cards.filter((c) => c.method !== "DRAW").length,
      unanimousCards: cards.filter((c) => c.method === "DEC_U").length,
      splitCards: cards.filter((c) => c.method === "DEC_S").length,
      majorityCards: cards.filter((c) => c.method === "DEC_M").length,
      drawBoutCards: cards.filter((c) => c.method === "DRAW").length,
      evenCards: cards.filter((c) => c.isEvenCard).length,
      attributedCards: attributed.length,
      dissentCards: cards.filter((c) => c.isDissent === true).length,
      titleCards: cards.filter((c) => c.isTitle).length,
      fiveRoundCards: cards.filter((c) => c.scheduledRounds === 5 || c.isTitle).length,
      wideCards: cards.filter((c) => c.scoreMargin >= 3).length,
      avgScoreMargin: margins.length ? Number((margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(2)) : null,
      firstEventDate: dates.length ? dates[dates.length - 1] : null,
      lastEventDate: dates.length ? dates[0] : null,
    });
  }
  judges.sort((a, b) => b.cards - a.cards || a.displayName.localeCompare(b.displayName));

  const allCards = [...cardsBySlug.values()].flat();
  const allMargins = allCards.map((c) => c.scoreMargin).filter((m) => Number.isFinite(m));
  const allDates = allCards.map((c) => c.eventDate).filter(Boolean).sort() as string[];
  return {
    judges,
    bySlug: new Map(judges.map((j) => [j.slug, j])),
    cardsBySlug,
    totals: {
      cards: allCards.length,
      bouts: new Set(allCards.map((c) => c.boutId)).size,
      attributedCards: allCards.filter((c) => c.isDissent !== null).length,
      dissentCards: allCards.filter((c) => c.isDissent === true).length,
      unattributedCards: unattributedNoWinner + unattributedConflicting,
      unattributedNoWinner,
      unattributedConflicting,
      avgScoreMargin: allMargins.length ? Number((allMargins.reduce((a, b) => a + b, 0) / allMargins.length).toFixed(2)) : null,
      titleCards: allCards.filter((c) => c.isTitle).length,
      drawCards: allCards.filter((c) => c.isEvenCard).length,
      shapeMismatchBouts,
      firstEventDate: allDates[0] || null,
      lastEventDate: allDates[allDates.length - 1] || null,
    },
  };
});

export async function getJudges(): Promise<JudgeProfile[]> {
  return (await getJudgeArchive()).judges;
}

export async function getJudgeBySlug(slug: string): Promise<{ judge: JudgeProfile; cards: JudgeCard[] } | null> {
  const archive = await getJudgeArchive();
  const judge = archive.bySlug.get(slug);
  if (!judge) return null;
  return { judge, cards: archive.cardsBySlug.get(slug) || [] };
}

/* The read behind a judge's "what to know" paragraph. Gated on sample size
 * and on a significance test; see judgeScoring.dissentRead. */
export async function getJudgeRead(judge: JudgeProfile) {
  const { totals } = await getJudgeArchive();
  return dissentRead({
    displayName: judge.displayName,
    dissents: judge.dissentCards,
    attributed: judge.attributedCards,
    archiveDissents: totals.dissentCards,
    archiveAttributed: totals.attributedCards,
  });
}

/* ---- coverage ---------------------------------------------------------- */

export type ScorecardGap = {
  boutId: string;
  eventId: string;
  eventName: string;
  eventDate: string | null;
  fighterAName: string;
  fighterBName: string;
  method: string;
  methodRaw: string;
  resultSource: string;
  boutUfcstatsId: string | null;
  eventUfcstatsId: string | null;
  finishDetail: string | null;
  scoresHeldWithoutJudges: boolean;
  classification: GapClassification;
  reason: GapReason;
  sourceUrl: string;
};

export type ScorecardCoverage = {
  judgedResults: number;
  withScorecards: number;
  missingScorecards: number;
  finishesNoScorecardExpected: number;
  finishesWithUnexpectedScorecard: number;
  gaps: ScorecardGap[];
  byClassification: Array<{ classification: GapClassification; reason: GapReason; count: number }>;
};

type GapRow = {
  bout_id: string; method: string; method_raw: string; result_source: string; finish_detail: string | null;
  scorecards: unknown; source_url: string;
  bout: { id: string; ufcstats_id: string | null; event_id: string;
    fighter_a: NamedFighter | NamedFighter[] | null; fighter_b: NamedFighter | NamedFighter[] | null;
    event: { id: string; name: string; event_date: string | null; ufcstats_id: string | null } | null } | null;
};

export const getScorecardCoverage = cache(async (): Promise<ScorecardCoverage> => {
  const sel =
    "bout_id,method,method_raw,result_source,finish_detail,scorecards,source_url," +
    "bout:ufc_bouts!inner(id,ufcstats_id,event_id," +
    "fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name)," +
    "fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name)," +
    "event:ufc_events!inner(id,name,event_date,ufcstats_id))";
  const [judged, finishes, ingestedEventIds] = await Promise.all([
    restAll<GapRow>(`ufc_bout_results?select=${sel}&method=in.(DEC_U,DEC_S,DEC_M,DRAW)&order=bout_id.asc`),
    restAll<{ method: string; scorecards: unknown }>(`ufc_bout_results?select=method,scorecards&method=not.in.(DEC_U,DEC_S,DEC_M,DRAW)&order=bout_id.asc`),
    /* Which events have at least one bout matched to a UFC Stats fight. It is
     * what separates "the page exists and this row never matched it" from
     * "the source does not cover this event at all". */
    restAll<{ event_id: string }>(`ufc_bouts?select=event_id&ufcstats_id=not.is.null&order=event_id.asc`),
  ]);
  const ingested = new Set(ingestedEventIds.map((r) => r.event_id));

  const gaps: ScorecardGap[] = [];
  let withScorecards = 0;
  for (const row of judged) {
    const cards = Array.isArray(row.scorecards) ? row.scorecards : [];
    if (cards.length > 0) { withScorecards += 1; continue; }
    const bout = row.bout;
    const fa = one<NamedFighter>(bout?.fighter_a);
    const fb = one<NamedFighter>(bout?.fighter_b);
    const ev = bout?.event;
    if (!bout || !fa || !fb || !ev) continue;
    const { classification, reason } = classifyGap({
      method: row.method, resultSource: row.result_source, finishDetail: row.finish_detail,
      boutUfcstatsId: bout.ufcstats_id, eventUfcstatsId: ev.ufcstats_id,
      eventHasIngestedSiblings: ingested.has(bout.event_id), eventName: ev.name,
    });
    gaps.push({
      boutId: row.bout_id, eventId: ev.id, eventName: ev.name, eventDate: ev.event_date,
      fighterAName: fa.name, fighterBName: fb.name, method: row.method, methodRaw: row.method_raw,
      resultSource: row.result_source, boutUfcstatsId: bout.ufcstats_id, eventUfcstatsId: ev.ufcstats_id,
      finishDetail: row.finish_detail, scoresHeldWithoutJudges: /\d{1,3}\s*-\s*\d{1,3}/.test(row.finish_detail || ""),
      classification, reason, sourceUrl: row.source_url,
    });
  }
  gaps.sort((a, b) => String(a.eventDate || "").localeCompare(String(b.eventDate || "")));

  const buckets = new Map<string, { classification: GapClassification; reason: GapReason; count: number }>();
  for (const g of gaps) {
    const key = `${g.classification}|${g.reason}`;
    const hit = buckets.get(key) || { classification: g.classification, reason: g.reason, count: 0 };
    hit.count += 1;
    buckets.set(key, hit);
  }

  return {
    judgedResults: judged.length,
    withScorecards,
    missingScorecards: gaps.length,
    finishesNoScorecardExpected: finishes.length,
    finishesWithUnexpectedScorecard: finishes.filter((f) => Array.isArray(f.scorecards) && f.scorecards.length > 0).length,
    gaps,
    byClassification: [...buckets.values()].sort((a, b) => b.count - a.count),
  };
});

/* ---- helpers used by pages --------------------------------------------- */

export { buildBoutScorecard, judgeSlug, resolveJudge, wentToTheJudges, PROVISIONAL_IDENTITY_CANDIDATES, SPELLING_VARIANT_EVIDENCE };

/* The other half of a near-name pair that is deliberately NOT merged, if this
 * judge is on one. A reader looking at a three-card profile deserves to know a
 * candidate sibling record exists and why it has not been combined into this
 * one; leaving it silent is how a split record reads as a complete one. */
export function provisionalPairFor(name: string): { other: string; otherSlug: string; candidate: ProvisionalCandidate } | null {
  for (const candidate of PROVISIONAL_IDENTITY_CANDIDATES) {
    const i = candidate.names.indexOf(name);
    if (i < 0) continue;
    return { other: candidate.names[i === 0 ? 1 : 0], otherSlug: judgeSlug(candidate.names[i === 0 ? 1 : 0]), candidate };
  }
  return null;
}

export function tenureLine(j: Pick<JudgeProfile, "firstEventDate" | "lastEventDate">): string | null {
  const y = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).getUTCFullYear() : null);
  const a = y(j.firstEventDate), b = y(j.lastEventDate);
  if (!a || !b) return null;
  return a === b ? `${a}` : `${a}–${b}`;
}

export function judgeArchiveBio(j: JudgeProfile, tenure: string | null): string {
  const span = tenure ? `across ${tenure}` : "in the loaded archive";
  const merged = j.mergedSpellings.length ? ` The archive also stores this official as ${j.mergedSpellings.map((s) => `“${s}”`).join(" and ")}; those cards are counted here.` : "";
  /* A judge normally turns in exactly one card per bout, so "1,154 cards
     across 1,154 bouts" reads like a mistake. Say it once when they match. */
  const volume = j.cards === j.bouts
    ? `one card on each of ${j.bouts.toLocaleString()} archived UFC bout${j.bouts === 1 ? "" : "s"} currently loaded by PropBetEdge`
    : `${j.cards.toLocaleString()} scorecard${j.cards === 1 ? "" : "s"} across ${j.bouts.toLocaleString()} archived UFC bout${j.bouts === 1 ? "" : "s"} currently loaded by PropBetEdge`;
  return `${j.displayName} appears on ${volume} ${span}. Historical coverage is still being backfilled, so this is an archived sample rather than a career total.${merged} Everything below is a description of what these cards contained. It is not an assessment of judging quality, and it is not evidence that this official favours any style, nationality or type of fighter.`;
}
