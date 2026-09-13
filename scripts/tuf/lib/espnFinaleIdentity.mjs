/**
 * Plan: attach ESPN athlete ids to canonical fighters through ONE exact event.
 *
 * Every mapping is anchored to a bout, never to a name alone:
 *   canonical fighter  <->  our bout on the exact event  <->  the ESPN competition
 *   on the exact ESPN event that reproduces that bout  <->  the ESPN competitor in
 *   the same corner role (winner / loser)  <->  ESPN athlete id.
 *
 * A competition reproduces a bout when ALL of these agree: the two ESPN athletes
 * fill the bout's winner and loser roles, the stoppage round agrees with our
 * result row, and each athlete's printed name folds to our fighter's name. The
 * name is one independent check among several, never the deciding one. A date
 * of birth that both sides record and that disagrees is reported, not fixed.
 *
 * Abort conditions (any one empties the plan):
 *   a fighter not in the expected set, or an expected fighter with no bout on the event
 *   no competition, or more than one, reproducing a bout
 *   an ESPN id that would land on two fighters, or two ESPN ids on one fighter
 *   an ESPN id already attached to a different canonical fighter
 *   a fighter that already carries a different ESPN id
 *   the mapped count differing from the expected count
 */

export const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * @param {object} p
 * @param {Array<{id:string,name:string}>} p.expected       the fighters to map (exact canonical rows)
 * @param {Array<{id:string,name:string,espn_athlete_id:string|null,ufcstats_id:string|null,dob:string|null}>} p.fighters
 * @param {Array<{id:string,fighter_a_id:string,fighter_b_id:string,winner_id:string|null,round:number|null}>} p.bouts   our bouts on the event
 * @param {Array<{id:string,period:number|null,competitors:Array<{athlete_id:string,name:string,winner:boolean,dob:string|null}>}>} p.competitions   ESPN competitions on the event
 * @param {Array<{id:string,espn_athlete_id:string}>} p.espnIdHolders   canonical rows already holding any candidate ESPN id
 */
export function planEspnIdBackfill({ expected, fighters, bouts, competitions, espnIdHolders }) {
  const problems = [];
  const warnings = [];
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const expectedIds = new Set(expected.map((e) => e.id));
  const mappings = [];

  for (const e of expected) {
    const f = byId.get(e.id);
    if (!f) { problems.push({ fighter: e.name, kind: 'missing_canonical_row' }); continue; }
    const mine = bouts.filter((b) => b.fighter_a_id === e.id || b.fighter_b_id === e.id);
    if (mine.length !== 1) { problems.push({ fighter: e.name, kind: mine.length ? 'more_than_one_bout_on_event' : 'no_bout_on_event' }); continue; }
    const bout = mine[0];
    const oppId = bout.fighter_a_id === e.id ? bout.fighter_b_id : bout.fighter_a_id;
    const opp = byId.get(oppId);
    if (!bout.winner_id || ![bout.fighter_a_id, bout.fighter_b_id].includes(bout.winner_id)) { problems.push({ fighter: e.name, kind: 'bout_without_decisive_result', bout: bout.id }); continue; }
    const iWon = bout.winner_id === e.id;
    const reproducing = competitions.filter((c) => {
      if (c.competitors.length !== 2 || c.competitors.filter((x) => x.winner).length !== 1) return false;
      const w = c.competitors.find((x) => x.winner);
      const l = c.competitors.find((x) => !x.winner);
      const wf = byId.get(bout.winner_id);
      const lf = byId.get(iWon ? oppId : e.id);
      const roundOk = c.period == null || bout.round == null || Number(c.period) === Number(bout.round);
      return roundOk && wf && lf && fold(w.name) === fold(wf.name) && fold(l.name) === fold(lf.name);
    });
    if (reproducing.length !== 1) { problems.push({ fighter: e.name, kind: reproducing.length ? 'ambiguous_competition' : 'no_reproducing_competition', bout: bout.id }); continue; }
    const comp = reproducing[0];
    const athlete = comp.competitors.find((x) => x.winner === iWon);
    const oppAthlete = comp.competitors.find((x) => x.winner !== iWon);
    if (f.espn_athlete_id && f.espn_athlete_id !== athlete.athlete_id) { problems.push({ fighter: e.name, kind: 'fighter_already_has_different_espn_id', has: f.espn_athlete_id, candidate: athlete.athlete_id }); continue; }
    const holder = espnIdHolders.find((h) => h.espn_athlete_id === athlete.athlete_id && h.id !== e.id);
    if (holder) { problems.push({ fighter: e.name, kind: 'espn_id_attached_to_another_fighter', espn: athlete.athlete_id, holder: holder.id }); continue; }
    if (athlete.dob && f.dob && athlete.dob !== f.dob) warnings.push({ fighter: e.name, kind: 'dob_disagreement', espn_dob: athlete.dob, canonical_dob: f.dob, action: 'recorded as source evidence; canonical dob unchanged' });
    mappings.push({
      fighter_id: e.id, name: f.name, ufcstats_id: f.ufcstats_id, espn_athlete_id: athlete.athlete_id, espn_name: athlete.name, espn_dob: athlete.dob ?? null,
      canonical_dob: f.dob ?? null, already_attached: f.espn_athlete_id === athlete.athlete_id,
      bout_id: bout.id, espn_competition_id: comp.id, role: iWon ? 'winner' : 'loser',
      opponent_id: oppId, opponent_name: opp?.name ?? null, opponent_espn_athlete_id: oppAthlete.athlete_id, round: bout.round,
    });
  }

  /* No fighter outside the expected set may be touched, and ids must be 1:1. */
  for (const m of mappings) if (!expectedIds.has(m.fighter_id)) problems.push({ fighter: m.name, kind: 'unexpected_fighter' });
  const seenEspn = new Map();
  for (const m of mappings) {
    if (seenEspn.has(m.espn_athlete_id) && seenEspn.get(m.espn_athlete_id) !== m.fighter_id) problems.push({ fighter: m.name, kind: 'duplicate_espn_id_in_plan', espn: m.espn_athlete_id });
    seenEspn.set(m.espn_athlete_id, m.fighter_id);
  }
  if (new Set(mappings.map((m) => m.fighter_id)).size !== mappings.length) problems.push({ kind: 'fighter_mapped_twice' });
  if (mappings.length !== expected.length) problems.push({ kind: 'count_mismatch', expected: expected.length, mapped: mappings.length });

  return {
    ok: problems.length === 0,
    expected: expected.length,
    mapped: problems.length ? 0 : mappings.length,
    ambiguous: problems.filter((p) => p.kind === 'ambiguous_competition').length,
    conflicts: problems.filter((p) => /already|another|different/.test(p.kind)).length,
    duplicate_ids: problems.filter((p) => p.kind === 'duplicate_espn_id_in_plan').length,
    mappings: problems.length ? [] : mappings,
    problems,
    warnings,
  };
}
