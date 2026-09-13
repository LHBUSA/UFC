/**
 * The season <-> finale relationship, shaped from canonical database rows.
 *
 * One source of truth: professional results, judges' cards and round stats are
 * read from ufc_bouts / ufc_bout_results / ufc_bout_scorecards /
 * ufc_bout_round_stats at render, never copied into the season JSON. A season
 * contributes only which bouts are its finals (by exact bout id or exact
 * finalist ids) and who its contestants and coaches are (canonical ids).
 *
 * Pure, so the shaping is testable without a database.
 */

export type FinaleFighter = { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };
export type FinaleBoutRow = {
  id: string; bout_order: number | null; weight_class_raw: string | null; is_title?: boolean | null;
  fighter_a: FinaleFighter; fighter_b: FinaleFighter;
  result: { winner_id: string | null; method_raw: string | null; round: number | null; time_sec: number | null } | null;
};
export type ScorecardRow = { bout_id: string; card_index: number | null; judge_name: string | null; fighter_a_id: string; fighter_a_score: number | null; fighter_b_score: number | null };
export type RoundRow = { bout_id: string; round: number };

export type ShapedBout = {
  id: string; weight_class: string | null;
  a: FinaleFighter; b: FinaleFighter;
  winner: FinaleFighter | null; loser: FinaleFighter | null;
  method: string | null; round: number | null; time: string | null;
  /** Winner's score first, as a judge's card is read for the winner. */
  scorecards: Array<{ judge: string | null; score: string }>;
  rounds_recorded: number;
};

export type FinaleIntegration = {
  event: { id: string; name: string; event_date: string };
  finals: Array<ShapedBout & { season_weight_class: string }>;
  castBouts: ShapedBout[];
  otherBouts: ShapedBout[];
  debuts: { contestants: number; debuted_here: number };
  coachFight: (ShapedBout & { event: { name: string; event_date: string } }) | null;
};

const mmss = (sec: number | null) => (sec == null ? null : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);

export function shapeBout(row: FinaleBoutRow, cards: ScorecardRow[], rounds: RoundRow[]): ShapedBout {
  const r = row.result;
  const winner = r?.winner_id === row.fighter_a.id ? row.fighter_a : r?.winner_id === row.fighter_b.id ? row.fighter_b : null;
  const loser = winner ? (winner.id === row.fighter_a.id ? row.fighter_b : row.fighter_a) : null;
  const scorecards = cards
    .filter((c) => c.bout_id === row.id && c.fighter_a_score != null && c.fighter_b_score != null)
    .sort((x, y) => (x.card_index ?? 0) - (y.card_index ?? 0))
    .map((c) => {
      const aIsWinner = winner ? c.fighter_a_id === winner.id : true;
      const [w, l] = aIsWinner ? [c.fighter_a_score, c.fighter_b_score] : [c.fighter_b_score, c.fighter_a_score];
      return { judge: c.judge_name, score: `${w}-${l}` };
    });
  return {
    id: row.id, weight_class: row.weight_class_raw, a: row.fighter_a, b: row.fighter_b, winner, loser,
    method: r?.method_raw ?? null, round: r?.round ?? null, time: mmss(r?.time_sec ?? null),
    scorecards,
    rounds_recorded: new Set(rounds.filter((x) => x.bout_id === row.id).map((x) => x.round)).size,
  };
}

export function shapeFinale(input: {
  event: { id: string; name: string; event_date: string };
  bouts: FinaleBoutRow[];
  scorecards: ScorecardRow[];
  rounds: RoundRow[];
  /** Season finals: an exact bout id where the season records one, else the finalists' ids. */
  finals: Array<{ weight_class: string; ufc_bout_id?: string; ids?: [string, string] }>;
  contestantIds: ReadonlySet<string>;
  /** Earliest UFC bout date per contestant id, from our records. */
  firstBoutDate: ReadonlyMap<string, string>;
  coachFight?: { row: FinaleBoutRow; event: { name: string; event_date: string } } | null;
}): FinaleIntegration {
  const shaped = [...input.bouts].sort((x, y) => (y.bout_order ?? 0) - (x.bout_order ?? 0)).map((b) => shapeBout(b, input.scorecards, input.rounds));
  const pairOf = (b: ShapedBout) => [b.a.id, b.b.id].sort().join("|");
  const finals: FinaleIntegration["finals"] = [];
  const finalIds = new Set<string>();
  for (const f of input.finals) {
    const hit = f.ufc_bout_id ? shaped.find((b) => b.id === f.ufc_bout_id) : f.ids ? shaped.find((b) => pairOf(b) === [...f.ids!].sort().join("|")) : undefined;
    if (hit) { finals.push({ ...hit, season_weight_class: f.weight_class }); finalIds.add(hit.id); }
  }
  const rest = shaped.filter((b) => !finalIds.has(b.id));
  const isCast = (b: ShapedBout) => input.contestantIds.has(b.a.id) && input.contestantIds.has(b.b.id);
  const debutedHere = [...input.contestantIds].filter((id) => input.firstBoutDate.get(id) === input.event.event_date).length;
  return {
    event: input.event,
    finals,
    castBouts: rest.filter(isCast),
    otherBouts: rest.filter((b) => !isCast(b)),
    debuts: { contestants: input.contestantIds.size, debuted_here: debutedHere },
    coachFight: input.coachFight ? { ...shapeBout(input.coachFight.row, [], []), event: input.coachFight.event } : null,
  };
}
