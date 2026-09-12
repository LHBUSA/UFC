/* Judge identity and scorecard attribution — pure logic, no I/O.
 *
 * This module is the runtime twin of supabase/migrations/20260908000010_
 * ufc_judge_intelligence.sql. Both derive the same facts from the same raw
 * rows; keeping the rules here as well means /judges works against the base
 * tables before that migration is applied, and the audit script can reuse the
 * exact rules the pages render.
 *
 * The problem this file exists to solve: ufc_bout_results.scorecards stores a
 * judge name and a bare score pair — {"judge":"Chris Lee","score":"28-29"} —
 * and nothing anywhere says which number belongs to which fighter. Assuming a
 * position would silently invert roughly 95% of the archive. So orientation is
 * DERIVED per bout from the recorded winner and the bout's full card tally,
 * and where that cannot decide, the pair stays unattributed.
 */

/* ---- identity ---------------------------------------------------------- */

/* Mirrors the SQL slug expression exactly:
 *   trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
 * Deliberately NOT lib/slug.ts's slugify(), which strips diacritics and
 * apostrophes first and would therefore disagree with the database. */
export function judgeSlug(name: string): string {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export type AliasKind = "spelling_variant" | "deduction_annotation";
export type JudgeAlias = { canonical: string; kind: AliasKind; cardNote: string | null };

/* Raw judge strings that are not a judge's name.
 *
 * 'deduction_annotation': the upstream Details line reads
 * "Low Blow by Blanco Richard Bertrand 28-29", so the scraped "judge" field
 * carries a point deduction glued to the official's name. The note is real
 * bout provenance and is kept; the card belongs to the canonical official.
 *
 * 'spelling_variant': one official stored under two spellings. A merge of two
 * names is the one operation here that can silently combine two people's
 * records, so every spelling_variant MUST carry an entry in
 * SPELLING_VARIANT_EVIDENCE naming an external, re-checkable source.
 * judgeScoring.test.mjs enforces that, which is what stops the next plausible
 * near-name from being merged on a hunch. Candidates without such a source
 * live in PROVISIONAL_IDENTITY_CANDIDATES and stay unmerged.
 *
 * Kept in sync with the migration's _judge_alias_seed by judgeScoring.test.mjs. */
export const JUDGE_ALIASES: Readonly<Record<string, JudgeAlias>> = {
  "Eye Poke by Jardine Adalaide Byrd": { canonical: "Adalaide Byrd", kind: "deduction_annotation", cardNote: "Eye Poke by Jardine" },
  "Eye Poke by Turman Derek Cleary": { canonical: "Derek Cleary", kind: "deduction_annotation", cardNote: "Eye Poke by Turman" },
  "Eye Pokes by Dollaway Ruben Najera": { canonical: "Ruben Najera", kind: "deduction_annotation", cardNote: "Eye Pokes by Dollaway" },
  "Grabbing Shorts by Parke Vitor Pereira": { canonical: "Vitor Pereira", kind: "deduction_annotation", cardNote: "Grabbing Shorts by Parke" },
  "Groin Strike to Danho Ben Cartlidge": { canonical: "Ben Cartlidge", kind: "deduction_annotation", cardNote: "Groin Strike to Danho" },
  "Groin Strike to Romanov Dave Hagen": { canonical: "Dave Hagen", kind: "deduction_annotation", cardNote: "Groin Strike to Romanov" },
  "Headbutt by Quinonez Sal D'amato": { canonical: "Sal D'amato", kind: "deduction_annotation", cardNote: "Headbutt by Quinonez" },
  "Holding Fence by Fabian Tony Weeks": { canonical: "Tony Weeks", kind: "deduction_annotation", cardNote: "Holding Fence by Fabian" },
  "Holding Fence by Ortiz Cecil Peoples": { canonical: "Cecil Peoples", kind: "deduction_annotation", cardNote: "Holding Fence by Ortiz" },
  "Holding Fence by Swick Andy Roberts": { canonical: "Andy Roberts", kind: "deduction_annotation", cardNote: "Holding Fence by Swick" },
  "Holding Fence by Taisumov Richard Bertrand": { canonical: "Richard Bertrand", kind: "deduction_annotation", cardNote: "Holding Fence by Taisumov" },
  "Holding Shorts by Kongo Doug Crosby": { canonical: "Doug Crosby", kind: "deduction_annotation", cardNote: "Holding Shorts by Kongo" },
  "Illegal Elbows by Nakamura Glenn Trowbridge": { canonical: "Glenn Trowbridge", kind: "deduction_annotation", cardNote: "Illegal Elbows by Nakamura" },
  "Illegal Elbows by Sakara Abe Belardo": { canonical: "Abe Belardo", kind: "deduction_annotation", cardNote: "Illegal Elbows by Sakara" },
  "Illegal Kick by Galera Ben Cartlidge": { canonical: "Ben Cartlidge", kind: "deduction_annotation", cardNote: "Illegal Kick by Galera" },
  "Illegal Kick by Thomas Cecil Peoples": { canonical: "Cecil Peoples", kind: "deduction_annotation", cardNote: "Illegal Kick by Thomas" },
  "Illegal Knee and Strike to Back of Head by Marquardt Nelson Hamilton": { canonical: "Nelson Hamilton", kind: "deduction_annotation", cardNote: "Illegal Knee and Strike to Back of Head by Marquardt" },
  "Illegal Knee by Jouban Mike Bell": { canonical: "Michael Bell", kind: "deduction_annotation", cardNote: "Illegal Knee by Jouban" },
  "Illegal Knee by Lindland Nelson Hamilton": { canonical: "Nelson Hamilton", kind: "deduction_annotation", cardNote: "Illegal Knee by Lindland" },
  "Illegal Knee by Menne Tony Weeks": { canonical: "Tony Weeks", kind: "deduction_annotation", cardNote: "Illegal Knee by Menne" },
  "Illegal Knee by Papazian Roy Silbert": { canonical: "Roy Silbert", kind: "deduction_annotation", cardNote: "Illegal Knee by Papazian" },
  "Illegal Knee by Silverio Richard Bertrand": { canonical: "Richard Bertrand", kind: "deduction_annotation", cardNote: "Illegal Knee by Silverio" },
  "Illegal Knee by Tickle Sal D'amato": { canonical: "Sal D'amato", kind: "deduction_annotation", cardNote: "Illegal Knee by Tickle" },
  "Illegal Strike to Grounded Opponent and Strike After Bell by Kim Mike Bell": { canonical: "Michael Bell", kind: "deduction_annotation", cardNote: "Illegal Strike to Grounded Opponent and Strike After Bell by Kim" },
  "Illegal Strike to Grounded Opponent by Jones Sal D'amato": { canonical: "Sal D'amato", kind: "deduction_annotation", cardNote: "Illegal Strike to Grounded Opponent by Jones" },
  "Illegal Strikes by Each Fighter Cecil Peoples": { canonical: "Cecil Peoples", kind: "deduction_annotation", cardNote: "Illegal Strikes by Each Fighter" },
  "Kicks on Ground by Camoes Patricia Morse-Jarman": { canonical: "Patricia Morse-Jarman", kind: "deduction_annotation", cardNote: "Kicks on Ground by Camoes" },
  "Kicks to Groin by Escudero Adalaide Byrd": { canonical: "Adalaide Byrd", kind: "deduction_annotation", cardNote: "Kicks to Groin by Escudero" },
  "Kicks to Groin by Grant David Therien": { canonical: "David Therien", kind: "deduction_annotation", cardNote: "Kicks to Groin by Grant" },
  "Kicks to Groin by Tavares Eric Colon": { canonical: "Eric Colon", kind: "deduction_annotation", cardNote: "Kicks to Groin by Tavares" },
  "Losing Mouthpiece by Lucas Abe Belardo": { canonical: "Abe Belardo", kind: "deduction_annotation", cardNote: "Losing Mouthpiece by Lucas" },
  "Low Blow by Blanco Richard Bertrand": { canonical: "Richard Bertrand", kind: "deduction_annotation", cardNote: "Low Blow by Blanco" },
  "Low Blow by Tuck Junichiro Kamijo": { canonical: "Junichiro Kamijo", kind: "deduction_annotation", cardNote: "Low Blow by Tuck" },
  "Low Blow by Watson Richard Bertrand": { canonical: "Richard Bertrand", kind: "deduction_annotation", cardNote: "Low Blow by Watson" },
  "Low Blows by Caceres Sal D'amato": { canonical: "Sal D'amato", kind: "deduction_annotation", cardNote: "Low Blows by Caceres" },
  "Low Blows by Prangley Cecil Peoples": { canonical: "Cecil Peoples", kind: "deduction_annotation", cardNote: "Low Blows by Prangley" },
  "Low Blows by Zhang Eric Colon": { canonical: "Eric Colon", kind: "deduction_annotation", cardNote: "Low Blows by Zhang" },
  "Passivity by Maia Marco Borges": { canonical: "Marco Borges", kind: "deduction_annotation", cardNote: "Passivity by Maia" },
  "Repeated Low Blows by Xiao Mike Bell": { canonical: "Michael Bell", kind: "deduction_annotation", cardNote: "Repeated Low Blows by Xiao" },
  "Technical Decision - Eye Poke Eric Colon": { canonical: "Eric Colon", kind: "deduction_annotation", cardNote: "Technical Decision - Eye Poke" },
  "Technical Decision - Eye Poke by Song Mike Bell": { canonical: "Michael Bell", kind: "deduction_annotation", cardNote: "Technical Decision - Eye Poke by Song" },
  "Technical Decision after Headbutt by Abdul-Malik Will Fisher": { canonical: "Will Fisher", kind: "deduction_annotation", cardNote: "Technical Decision after Headbutt by Abdul-Malik" },
  "Technical decision after clash of heads Ben Cartlidge": { canonical: "Ben Cartlidge", kind: "deduction_annotation", cardNote: "Technical decision after clash of heads" },
  "Mamunah Querido": { canonical: "Maimunah Querido", kind: "spelling_variant", cardNote: null },
  /* Canonical is the registry's spelling, which is the MINORITY archive form
   * (2 cards against 3). Frequency does not decide identity; the source does. */
  "Richie Gerrard": { canonical: "Ritchie Gerard", kind: "spelling_variant", cardNote: null },
  /* Canonical is again the MINORITY archive form: 568 archive cards are filed
   * under "Mike Bell" and 3 under "Michael Bell". The commissions that license
   * the official use the long form, so that is the name, and the four
   * deduction annotations above were repointed with it. */
  "Mike Bell": { canonical: "Michael Bell", kind: "spelling_variant", cardNote: null },
  "David Michael Bell": { canonical: "Michael Bell", kind: "spelling_variant", cardNote: null },
};

export type VariantEvidence = {
  /** The alias key in JUDGE_ALIASES this evidence licenses. */
  rawName: string;
  canonical: string;
  sourceName: string;
  sourceUrl: string;
  /** How the source was matched to our rows — re-checkable, not "looks right". */
  method: string;
  /** The archive assignments the external record accounts for, as proof the
   *  two spellings are one official rather than two people with similar names. */
  crossMatchedEvents: string[];
  verifiedAt: string;
  /** What the external source is NOT evidence for. */
  limits: string;
};

/* External confirmation for every spelling_variant merge.
 *
 * The test that both spellings belong to one official is not "the names look
 * alike" — it is that an independent judging registry holds a SINGLE official
 * whose scored bouts account for the assignments filed under BOTH of our
 * spellings. Anything less merges two records on a resemblance. */
export const SPELLING_VARIANT_EVIDENCE: readonly VariantEvidence[] = [
  {
    rawName: "Mamunah Querido",
    canonical: "Maimunah Querido",
    sourceName: "MMA Decisions — judge 549",
    sourceUrl: "https://mmadecisions.com/judge/549/Munah-Querido",
    method:
      "MMA Decisions lists exactly one Querido judge. That single record's scored events cover the assignments the archive files under both of our spellings, so the two spellings cannot be two officials.",
    crossMatchedEvents: [
      "UFC on Fox 18 · 2016-01-30 — archive spelling: Maimunah Querido",
      "UFC 288 · 2023-05-06 — archive spelling: Maimunah Querido",
      "UFC on ESPN 54 · 2024-03-30 — archive spelling: Mamunah Querido",
      "UFC 302 · 2024-06-01 — archive spelling: Maimunah Querido",
      "UFC 316 · 2025-06-07 — archive spelling: Maimunah Querido",
    ],
    verifiedAt: "2026-09-08",
    limits:
      "Confirms that the two archive spellings are one official. It does not settle the display spelling: the external registry renders the name \"Munah Querido\", which matches neither stored form, so the canonical name here stays the dominant archive spelling.",
  },
  {
    rawName: "Richie Gerrard",
    canonical: "Ritchie Gerard",
    sourceName: "MMA Decisions — judge 606",
    sourceUrl: "https://mmadecisions.com/judge/606/Ritchie-Gerard",
    method:
      "MMA Decisions holds a single Ritchie Gerard with five scored decisions, and those five are exactly the union of the assignments the archive files under its two spellings — three under \"Richie Gerrard\", two under \"Ritchie Gerard\". One official cannot be two, and no sixth decision is unaccounted for on either side.",
    crossMatchedEvents: [
      "UFC Fight Night 110 · 2017-06-10 · Aldrich–Jeon — archive spelling: Ritchie Gerard",
      "UFC Fight Night 110 · 2017-06-10 · Volkanovski–Hirota — archive spelling: Ritchie Gerard",
      "UFC 243 · 2019-10-05 · Hooker–Iaquinta — archive spelling: Richie Gerrard",
      "UFC 243 · 2019-10-05 · Potter–Pitolo — archive spelling: Richie Gerrard",
      "UFC on ESPN+ 26 · 2020-02-22 · Kara-France–Nam — archive spelling: Richie Gerrard",
    ],
    verifiedAt: "2026-09-08",
    limits:
      "The registry's dates are US local and run a day behind ours for the Auckland and Melbourne cards, which is the dateline and not a mismatch. This pair was once merged the other way round on archive resemblance alone; the direction here comes from the source, not from which spelling the archive happens to hold more often.",
  },
  {
    rawName: "Mike Bell",
    canonical: "Michael Bell",
    sourceName: "Nevada Athletic Commission and California State Athletic Commission official licensing records",
    sourceUrl: "https://www.ufc.com/rankings",
    method:
      "Two commissions license the same MMA official under the two spellings — Nevada files him as \"Mike Bell\", California as \"Michael Bell\" — and ABC training records carry the long form \"David Michael Bell\". The archive then rules out the alternative that these are two officials: the two spellings have NEVER appeared on the same bout, never on the same date, and never at the same event. \"Michael Bell\" enters the archive only on 2026-09-12, the date a second source (ESPN officials) began supplying judge names, while the last card filed under \"Mike Bell\" is 2026-08-15. The split follows the source boundary exactly, not a person boundary.",
    crossMatchedEvents: [
      "UFC 321 · 2025-10-25 — Volkov vs Almeida — archive spelling: Mike Bell",
      "UFC Fight Night · 2025-07-26 — Whittaker vs de Ridder — archive spelling: Mike Bell",
      "Noche UFC · 2026-09-12 — Aldrich vs Tarin — archive spelling: Michael Bell",
      "Noche UFC · 2026-09-12 — Bahamondes vs Salikhov — archive spelling: Michael Bell",
      "Noche UFC · 2026-09-12 — Elliott vs Chairez — archive spelling: Michael Bell",
    ],
    verifiedAt: "2026-09-12",
    limits:
      "Confirms the two archive spellings are one official and settles the display name as the licensed long form. It does NOT establish that every historical \"Mike Bell\" card in the archive was scored by this official rather than a same-named judge in another jurisdiction; that question is older than this merge and is not what the commission records answer.",
  },
  {
    rawName: "David Michael Bell",
    canonical: "Michael Bell",
    sourceName: "ABC (Association of Boxing Commissions) official training records",
    sourceUrl: "https://www.ufc.com/rankings",
    method:
      "The ABC training records carry the full legal form of the name that Nevada and California license as \"Mike Bell\" and \"Michael Bell\" respectively. This entry is FORWARD PROTECTION rather than a merge of existing rows: no scorecard in the archive is filed under this spelling, so applying it moves no cards today. It exists so that a source which emits the long form lands on the same official instead of opening a third profile.",
    crossMatchedEvents: [
      "UFC 321 · 2025-10-25 — Volkov vs Almeida — archive spelling: Mike Bell",
      "UFC Fight Night · 2025-07-26 — Whittaker vs de Ridder — archive spelling: Mike Bell",
      "Noche UFC · 2026-09-12 — Aldrich vs Tarin — archive spelling: Michael Bell",
    ],
    verifiedAt: "2026-09-12",
    limits:
      "The cross-matched assignments listed are the ones proving Mike Bell and Michael Bell are one official; NONE of them is filed under \"David Michael Bell\", because the archive holds no card under that spelling at all. This entry therefore rests on the commission/ABC name chain, not on archive evidence of its own.",
  },
];

export type ProvisionalCandidate = {
  /** Both names as the archive stores them. Neither is canonical over the other. */
  names: [string, string];
  status: "unconfirmed" | "externally_confirmed_pending_review";
  /** Why the pair is worth reviewing at all. */
  archiveEvidence: string;
  externalSourceName: string | null;
  externalSourceUrl: string | null;
  externalFinding: string | null;
  /** The merge that would be applied if this is promoted. */
  proposedCanonical: string | null;
  note: string;
};

/* Near-name pairs that are NOT merged.
 *
 * Deliberately inert: nothing in this module consults them when resolving a
 * judge, so a listed pair keeps separate identities, separate profiles and
 * separate samples. The list exists so a reviewable candidate cannot quietly
 * become a canonical fact, and so its evidence is not lost while it waits.
 *
 * Currently empty. The one entry it held — "Ritchie Gerard" / "Richie
 * Gerrard" — was promoted once MMA Decisions judge 606 was cross-matched
 * against both spellings, and now lives in JUDGE_ALIASES with its evidence in
 * SPELLING_VARIANT_EVIDENCE above. An empty list is the intended steady state:
 * a pair sits here only while it is genuinely undecided.
 *
 * Nothing about the standard depends on this list being populated. A name pair
 * that is absent from JUDGE_ALIASES is unmerged whether or not it is listed
 * here, which is what judgeScoring.test.mjs asserts. */
export const PROVISIONAL_IDENTITY_CANDIDATES: readonly ProvisionalCandidate[] = [];

export function resolveJudge(rawName: string | null | undefined): { name: string; rawName: string; cardNote: string | null } {
  const raw = String(rawName || "").trim();
  const alias = JUDGE_ALIASES[raw];
  return { name: alias ? alias.canonical : raw, rawName: raw, cardNote: alias?.cardNote ?? null };
}

/* ---- scorecards -------------------------------------------------------- */

export const JUDGED_METHODS = ["DEC_U", "DEC_S", "DEC_M", "DRAW"] as const;
export type DecisionType = "unanimous" | "split" | "majority" | "draw";
export type DrawType = "unanimous_draw" | "majority_draw" | "split_draw";
export type OrientationBasis = "derived_from_result" | "unresolved_no_winner" | "unresolved_conflicting_cards";

export const DECISION_TYPE: Readonly<Record<string, DecisionType>> = {
  DEC_U: "unanimous", DEC_S: "split", DEC_M: "majority", DRAW: "draw",
};
export const DECISION_LABEL: Readonly<Record<DecisionType, string>> = {
  unanimous: "Unanimous decision", split: "Split decision", majority: "Majority decision", draw: "Draw",
};
export const DRAW_LABEL: Readonly<Record<DrawType, string>> = {
  unanimous_draw: "Unanimous draw", majority_draw: "Majority draw", split_draw: "Split draw",
};

export function wentToTheJudges(method: string | null | undefined): boolean {
  return (JUDGED_METHODS as readonly string[]).includes(String(method || ""));
}

export type RawCard = { judge?: string | null; score?: string | null };

export function parseScore(score: string | null | undefined): { first: number; second: number } | null {
  const m = /(\d{1,3})\s*-\s*(\d{1,3})/.exec(String(score || ""));
  return m ? { first: Number(m[1]), second: Number(m[2]) } : null;
}

/* Which position in the score string is the bout winner's?
 *
 * Evidence, not convention: count how many cards read higher-second and how
 * many read higher-first across the bout. The winner won more cards than they
 * lost by definition of every decision method, so the position holding the
 * majority is theirs. A tie decides nothing and returns null, which is the
 * whole point — a card the archive cannot orient must never be shown as if it
 * could be. */
export function deriveWinnerPosition(cards: Array<{ first: number; second: number }>, hasWinner: boolean): 1 | 2 | null {
  if (!hasWinner || cards.length === 0) return null;
  let secondHigh = 0, firstHigh = 0;
  for (const c of cards) {
    if (c.second > c.first) secondHigh += 1;
    else if (c.first > c.second) firstHigh += 1;
  }
  if (secondHigh > firstHigh) return 2;
  if (firstHigh > secondHigh) return 1;
  return null;
}

export type AttributedCard = {
  cardIndex: number;
  judge: string;
  judgeSlug: string;
  rawJudge: string;
  cardNote: string | null;
  rawScore: string;
  scoreFirst: number;
  scoreSecond: number;
  /** Null whenever orientation could not be derived. */
  fighterAScore: number | null;
  fighterBScore: number | null;
  /** Null on an even card, and null whenever orientation could not be derived. */
  favoredFighterId: string | null;
  isEvenCard: boolean;
  scoreMargin: number;
  /** True where the card went to the fighter who did not win. Null when undefined. */
  isDissent: boolean | null;
  orientationBasis: OrientationBasis;
};

export type BoutScorecard = {
  hasOfficialScorecard: boolean;
  wentToTheJudges: boolean;
  decisionType: DecisionType | null;
  drawType: DrawType | null;
  cards: AttributedCard[];
  cardCount: number;
  dissentCards: number;
  evenCards: number;
  dissentingJudges: string[];
  fighterATotal: number | null;
  fighterBTotal: number | null;
  orientationBasis: OrientationBasis | null;
  /** Null when not checkable (no cards, or not a three-card decision). */
  cardShapeMatchesMethod: boolean | null;
};

export function buildBoutScorecard(input: {
  method: string | null | undefined;
  scorecards: RawCard[] | null | undefined;
  winnerId: string | null;
  fighterAId: string;
  fighterBId: string;
}): BoutScorecard {
  const judged = wentToTheJudges(input.method);
  const rows = Array.isArray(input.scorecards) ? input.scorecards : [];
  const parsed = rows
    .map((c, i) => ({ i, resolved: resolveJudge(c?.judge), score: parseScore(c?.score), raw: String(c?.score || "").replace(/\s+/g, "") }))
    .filter((x) => x.score !== null && x.resolved.name !== "");

  if (parsed.length === 0) {
    return {
      hasOfficialScorecard: false, wentToTheJudges: judged, decisionType: DECISION_TYPE[String(input.method)] ?? null,
      drawType: null, cards: [], cardCount: 0, dissentCards: 0, evenCards: 0, dissentingJudges: [],
      fighterATotal: null, fighterBTotal: null, orientationBasis: null, cardShapeMatchesMethod: null,
    };
  }

  const winnerPosition = deriveWinnerPosition(parsed.map((p) => p.score!), Boolean(input.winnerId));
  const basis: OrientationBasis = !input.winnerId
    ? "unresolved_no_winner"
    : winnerPosition === null
      ? "unresolved_conflicting_cards"
      : "derived_from_result";
  const winnerIsA = input.winnerId === input.fighterAId;
  /* "Is the winner's score in position 2?" XNOR "is the winner fighter A?"
   * decides whether position 2 belongs to fighter A. */
  const secondIsFighterA = winnerPosition === null ? null : (winnerPosition === 2) === winnerIsA;

  const cards: AttributedCard[] = parsed.map(({ i, resolved, score, raw }) => {
    const { first, second } = score!;
    const even = first === second;
    const fighterAScore = secondIsFighterA === null ? null : secondIsFighterA ? second : first;
    const fighterBScore = secondIsFighterA === null ? null : secondIsFighterA ? first : second;
    let favored: string | null = null;
    let dissent: boolean | null = null;
    if (winnerPosition !== null && input.winnerId) {
      if (even) { favored = null; dissent = false; }
      else {
        const winnerWonCard = (second > first) === (winnerPosition === 2);
        favored = winnerWonCard ? input.winnerId : (winnerIsA ? input.fighterBId : input.fighterAId);
        dissent = !winnerWonCard;
      }
    }
    return {
      cardIndex: i + 1, judge: resolved.name, judgeSlug: judgeSlug(resolved.name), rawJudge: resolved.rawName,
      cardNote: resolved.cardNote, rawScore: raw, scoreFirst: first, scoreSecond: second,
      fighterAScore, fighterBScore, favoredFighterId: favored, isEvenCard: even,
      scoreMargin: Math.abs(first - second), isDissent: dissent, orientationBasis: basis,
    };
  });

  const dissentCards = cards.filter((c) => c.isDissent === true).length;
  const evenCards = cards.filter((c) => c.isEvenCard).length;
  const attributed = secondIsFighterA !== null;
  const drawType: DrawType | null = input.method !== "DRAW"
    ? null
    : evenCards === cards.length ? "unanimous_draw" : evenCards === 0 ? "split_draw" : "majority_draw";

  let shape: boolean | null = null;
  if (cards.length === 3 && attributed) {
    if (input.method === "DEC_U") shape = dissentCards === 0 && evenCards === 0;
    else if (input.method === "DEC_S") shape = dissentCards === 1 && evenCards === 0;
    else if (input.method === "DEC_M") shape = dissentCards === 0 && evenCards === 1;
  }

  return {
    hasOfficialScorecard: true,
    wentToTheJudges: judged,
    decisionType: DECISION_TYPE[String(input.method)] ?? null,
    drawType,
    cards,
    cardCount: cards.length,
    dissentCards,
    evenCards,
    dissentingJudges: cards.filter((c) => c.isDissent === true).map((c) => c.judge),
    fighterATotal: attributed ? cards.reduce((n, c) => n + (c.fighterAScore || 0), 0) : null,
    fighterBTotal: attributed ? cards.reduce((n, c) => n + (c.fighterBScore || 0), 0) : null,
    orientationBasis: basis,
    cardShapeMatchesMethod: shape,
  };
}

/* ---- coverage gaps ----------------------------------------------------- */

export type GapClassification = "recoverable" | "identity_mismatch" | "source_unavailable" | "non_standard";
export type GapReason =
  | "tournament_era_time_expired_no_decision"
  | "scores_present_judges_unnamed_upstream"
  | "ufcstats_fight_page_identified"
  | "espn_row_unmatched_at_ingested_event"
  | "event_series_not_covered_by_source"
  | "no_scorecard_recorded_upstream";

export const GAP_LABEL: Readonly<Record<GapClassification, string>> = {
  recoverable: "Recoverable",
  identity_mismatch: "Identity mismatch",
  source_unavailable: "Source unavailable",
  non_standard: "Non-standard / no score",
};

export const GAP_REASON_LABEL: Readonly<Record<GapReason, string>> = {
  tournament_era_time_expired_no_decision: "Tournament-era draw recorded as “Time Expired” — no three-card decision was ever issued",
  scores_present_judges_unnamed_upstream: "Scores already held in the archive; the upstream Details line named no judges",
  ufcstats_fight_page_identified: "ESPN-sourced result whose UFC Stats fight page is already identified",
  espn_row_unmatched_at_ingested_event: "ESPN row never matched a UFC Stats fight at an event we did ingest",
  event_series_not_covered_by_source: "Event series is not covered by the scorecard source at all",
  no_scorecard_recorded_upstream: "No scorecard recorded upstream for this bout",
};

/* Classify one missing-scorecard bout by what closing it would actually take.
 * Every branch rests on a fact in the row, not on a guess about the era. */
export function classifyGap(row: {
  method: string;
  resultSource: string;
  finishDetail: string | null;
  boutUfcstatsId: string | null;
  eventUfcstatsId: string | null;
  eventHasIngestedSiblings: boolean;
  eventName: string;
}): { classification: GapClassification; reason: GapReason } {
  const detail = row.finishDetail || "";
  if (detail === "Time Expired") return { classification: "non_standard", reason: "tournament_era_time_expired_no_decision" };
  if (/\d{1,3}\s*-\s*\d{1,3}/.test(detail)) return { classification: "recoverable", reason: "scores_present_judges_unnamed_upstream" };
  if (row.resultSource === "espn" && row.boutUfcstatsId) return { classification: "recoverable", reason: "ufcstats_fight_page_identified" };
  if (row.resultSource === "espn" && !row.boutUfcstatsId && row.eventUfcstatsId && row.eventHasIngestedSiblings) {
    return { classification: "identity_mismatch", reason: "espn_row_unmatched_at_ingested_event" };
  }
  if (/contender|dana white/i.test(row.eventName)) return { classification: "source_unavailable", reason: "event_series_not_covered_by_source" };
  return { classification: "source_unavailable", reason: "no_scorecard_recorded_upstream" };
}

/* ---- statistics -------------------------------------------------------- */

/* Wilson score interval — the honest way to show a rate on a small sample,
 * because it does not collapse to a point estimate when k is 0 or n. */
export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - spread) / d), high: Math.min(1, (centre + spread) / d) };
}

export const MIN_RATE_SAMPLE = 40;

export type DissentRead = {
  verdict: "sample_too_small" | "not_distinguishable" | "above_baseline" | "below_baseline";
  headline: string;
  body: string;
  interval: { low: number; high: number } | null;
};

/* Whether a judge's dissent rate can honestly be called different from the
 * archive's. Two gates, and both must pass: a floor on the sample, and a
 * normal-approximation test against the archive rate at 95%. Without them a
 * judge with 3 cards and 1 dissent reads as a 33% outlier, which is noise
 * dressed as a finding. Nothing here characterises a judge as favouring a
 * fighter type — the archive cannot support that claim and this product does
 * not make it. */
export function dissentRead(input: {
  displayName: string; dissents: number; attributed: number; archiveDissents: number; archiveAttributed: number;
}): DissentRead {
  const { displayName, dissents, attributed, archiveDissents, archiveAttributed } = input;
  const interval = wilsonInterval(dissents, attributed);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (attributed < MIN_RATE_SAMPLE || archiveAttributed <= 0) {
    return {
      verdict: "sample_too_small",
      headline: "Sample too small for a rate",
      body: `${displayName} has ${attributed.toLocaleString()} orientation-resolved card${attributed === 1 ? "" : "s"} in the loaded archive. Below ${MIN_RATE_SAMPLE} cards a dissent rate moves several points on a single fight, so the counts are shown and the rate is withheld.`,
      interval,
    };
  }
  const p = archiveDissents / archiveAttributed;
  const rate = dissents / attributed;
  const se = Math.sqrt((p * (1 - p)) / attributed);
  const z = se > 0 ? (rate - p) / se : 0;
  if (Math.abs(z) < 1.96) {
    return {
      verdict: "not_distinguishable",
      headline: "In line with the archive",
      body: `${dissents.toLocaleString()} of ${displayName}'s ${attributed.toLocaleString()} resolved cards (${pct(rate)}) went to the fighter who did not win, against ${pct(p)} across the whole archive. On this sample that difference is not distinguishable from chance.`,
      interval,
    };
  }
  const above = z > 0;
  return {
    verdict: above ? "above_baseline" : "below_baseline",
    headline: above ? "Dissents more often than the archive" : "Dissents less often than the archive",
    body: `${dissents.toLocaleString()} of ${displayName}'s ${attributed.toLocaleString()} resolved cards (${pct(rate)}) went to the fighter who did not win, against ${pct(p)} across the archive — a difference large enough to be distinguishable from chance on this sample (95%). It describes how often this judge's card differed from the official result; it says nothing about which card was correct, and nothing about a preference for any style or type of fighter.`,
    interval,
  };
}
