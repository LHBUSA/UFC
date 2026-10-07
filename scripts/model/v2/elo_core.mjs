// PBE Fight Model V2 - production Elo source. PURE: no fs, no env, no clock.
//
// The research ladder (features_v2.eloLadder) emits a pre-bout rating for every
// historical bout. Production needs something different: every fighter's rating
// as of a date, from which any upcoming bout on or after that date reads its
// elo_diff. This is an independent implementation of the same rule, so the
// parity test (scripts/model/v2/elo_parity.test.mjs) is a real check, not a
// function compared with itself:
//
//   - start 1500; K * (1 + 2 / (n + 1)) per corner, n = that corner's prior rated bouts
//   - corner 1 is the lexicographically lower fighter UUID (outcome-independent)
//   - every bout dated d reads ratings before ANY result dated d is applied;
//     results within a date are applied in bout-id order
//   - winner = winner_id; method DRAW = 0.5; no contest / no result = skipped
//   - only bouts dated strictly before as_of contribute
//
// Market data never enters this file.

export const ELO_VERSION = 'pbe-elo-v1';
export const ELO_K = 48;
export const ELO_START = 1500;
export const ELO_RULE = 'start 1500; K*(1+2/(n+1)) per corner; date-block reads before updates; draws 0.5; NC skipped; elo_diff = (r1-r2)/100';

/**
 * Normalise raw rows into the ladder's input. Order: event_date asc, then bout id asc.
 * @param bouts   [{ id, event_id, fighter_a_id, fighter_b_id }]  (model_scope bouts)
 * @param dateOf  Map event_id -> event_date
 * @param results Map bout_id -> { winner_id, method }
 */
export function ladderInput(bouts, dateOf, results) {
  const out = [];
  for (const b of bouts) {
    const date = dateOf.get(b.event_id);
    if (!date) continue;
    const f1 = b.fighter_a_id < b.fighter_b_id ? b.fighter_a_id : b.fighter_b_id;
    const f2 = f1 === b.fighter_a_id ? b.fighter_b_id : b.fighter_a_id;
    const r = results.get(b.id);
    const winner = r?.winner_id ? r.winner_id : r?.method === 'DRAW' ? 'draw' : null;
    out.push({ id: b.id, date, f1, f2, winner });
  }
  return out.sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.date < b.date ? -1 : 1));
}

/** Every fighter's { r, n } after all results dated strictly before asOf. `input` must come from ladderInput. */
export function eloRatingsAsOf(input, asOf, k = ELO_K) {
  const r = new Map(), n = new Map();
  let i = 0;
  let used = 0;
  while (i < input.length && input[i].date < asOf) {
    const date = input[i].date;
    let j = i;
    while (j < input.length && input[j].date === date) j++;
    /* Reads first: every bout of the date sees the ratings as they stood before the date. */
    const pre = [];
    for (let t = i; t < j; t++) { const b = input[t]; pre.push({ r1: r.get(b.f1) ?? ELO_START, r2: r.get(b.f2) ?? ELO_START, n1: n.get(b.f1) ?? 0, n2: n.get(b.f2) ?? 0 }); }
    for (let t = i; t < j; t++) {
      const b = input[t], p = pre[t - i];
      if (!b.winner) continue;
      const s1 = b.winner === 'draw' ? 0.5 : b.winner === b.f1 ? 1 : 0;
      const e1 = 1 / (1 + 10 ** ((p.r2 - p.r1) / 400));
      r.set(b.f1, (r.get(b.f1) ?? ELO_START) + k * (1 + 2 / (p.n1 + 1)) * (s1 - e1));
      r.set(b.f2, (r.get(b.f2) ?? ELO_START) - k * (1 + 2 / (p.n2 + 1)) * (s1 - e1));
      n.set(b.f1, (n.get(b.f1) ?? 0) + 1);
      n.set(b.f2, (n.get(b.f2) ?? 0) + 1);
      used += 1;
    }
    i = j;
  }
  return { ratings: r, counts: n, results_used: used, last_date: i > 0 ? input[i - 1].date : null };
}

/** The canonical, hashable artifact body (ratings keyed by fighter id, sorted). */
export function eloArtifactBody(input, asOf, k = ELO_K) {
  const { ratings, counts, results_used, last_date } = eloRatingsAsOf(input, asOf, k);
  const ids = [...ratings.keys()].sort();
  return {
    version: ELO_VERSION, k, rule: ELO_RULE, as_of: asOf, exclusive: true,
    results_used, last_result_date: last_date, fighters: ids.length,
    ratings: Object.fromEntries(ids.map((id) => [id, [ratings.get(id), counts.get(id)]])),
  };
}

/** elo_diff for canonical corners (f1 < f2) from an artifact body; an unrated fighter is 1500. */
export function eloDiff(body, f1, f2) {
  const r1 = body.ratings[f1]?.[0] ?? ELO_START;
  const r2 = body.ratings[f2]?.[0] ?? ELO_START;
  return (r1 - r2) / 100;
}

/** SHA-256 hex of a string, with WebCrypto (Workers and Node >= 19 both provide it). */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
