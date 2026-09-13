/* Market matching and odds math — PURE. No node built-ins, no I/O, no env.
 *
 * WHY THIS FILE EXISTS
 *
 * These rules decide which fighter a price is attached to. They were written
 * for the Node CLI in ingest_market.mjs and are now also needed inside a
 * Cloudflare Worker, which cannot import that file: it reads .env from disk at
 * module scope. Copying the rules into the Worker would be the worst possible
 * answer — two implementations of "whose price is this" that drift apart, with
 * the divergence invisible until a price is already attached to the wrong
 * fighter and stored as history.
 *
 * So the logic MOVED here unchanged and both callers import it. The CLI keeps
 * its provider, database and CLI concerns; the Worker keeps its own; neither
 * owns a second copy of the matching rules.
 *
 * scripts/odds/market_match.test.mjs pins the behaviour against 62 real
 * outcome names taken from production observations, so a refactor that changes
 * any resolution fails loudly rather than quietly.
 *
 * The governing rule, unchanged: a price is never attached on a guess.
 * Ambiguity fails closed.
 */

/**
 * The ON CONFLICT target, which must equal ufc_market_obs_unique exactly.
 *
 * Exported so a test can assert the two never drift apart. If a column is
 * added to the constraint and not to this list, PostgREST silently stops
 * deduplicating on it; if one is named here that the constraint lacks, every
 * insert errors. Neither failure is visible until the second ingest.
 *
 * observed_at is deliberately ABSENT: it records when we looked, so including
 * it would make every run's rows unique and defeat the whole mechanism.
 */
export const OBS_CONFLICT_COLUMNS = [
  'bout_id', 'bookmaker_key', 'market_key', 'outcome_name', 'source_last_update', 'price',
];
export const OBS_CONFLICT = OBS_CONFLICT_COLUMNS.join(',');

/** The identity a row collides on. Two rows with the same key are one fact. */
export const observationKey = (r) => OBS_CONFLICT_COLUMNS.map((c) => String(r[c] ?? '')).join('|');

/* ---- identity ------------------------------------------------------------
 * Normalisation strips the things that differ between sources without ever
 * changing who a name refers to: case, accents, punctuation, extra spacing.
 * It deliberately does NOT drop or reorder name parts, because that is where
 * two different fighters start colliding. */
export function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Nicknames arrive quoted inside a name often enough to be worth removing. */
export const stripNickname = (s) => String(s || '').replace(/["“”].*?["“”]/g, ' ').replace(/\s+/g, ' ').trim();

export function buildIndex(fighters, aliases) {
  const byNorm = new Map();
  const add = (key, id) => {
    if (!key) return;
    let set = byNorm.get(key);
    if (!set) { set = new Set(); byNorm.set(key, set); }
    set.add(id);
  };
  for (const f of fighters) {
    add(normName(f.name), f.id);
    add(normName(stripNickname(f.name)), f.id);
  }
  for (const a of aliases || []) {
    if (a.normalized && a.fighter_id) add(String(a.normalized), a.fighter_id);
    if (a.alias && a.fighter_id) add(normName(a.alias), a.fighter_id);
  }
  return byNorm;
}

/**
 * Resolve one outcome name to a canonical fighter, restricted to the two
 * fighters actually in the bout.
 *
 * Scoping to the bout is what makes this safe: "Silva" is hopeless across the
 * whole roster and unambiguous when only two people can be meant. Anything
 * that still matches both corners, or neither, is a failure rather than a
 * coin flip.
 */
export function resolveOutcome(outcomeName, boutFighters, byNorm) {
  const want = normName(stripNickname(outcomeName));
  if (!want) return { status: 'unresolved', reason: 'empty_outcome_name' };

  const exact = boutFighters.filter((f) => normName(f.name) === want || normName(stripNickname(f.name)) === want);
  if (exact.length === 1) return { status: 'ok', fighterId: exact[0].id, method: 'exact' };
  if (exact.length > 1) return { status: 'ambiguous', reason: 'both_corners_match_exactly' };

  /* Alias table, still scoped to this bout. */
  const ids = byNorm.get(want);
  if (ids) {
    const inBout = boutFighters.filter((f) => ids.has(f.id));
    if (inBout.length === 1) return { status: 'ok', fighterId: inBout[0].id, method: 'alias' };
    if (inBout.length > 1) return { status: 'ambiguous', reason: 'alias_matches_both_corners' };
  }

  /* Surname within the bout. Safe only because the candidate set is two. */
  const surname = want.split(' ').pop();
  const bySurname = boutFighters.filter((f) => normName(f.name).split(' ').pop() === surname);
  if (bySurname.length === 1) return { status: 'ok', fighterId: bySurname[0].id, method: 'surname_in_bout' };
  if (bySurname.length > 1) return { status: 'ambiguous', reason: 'shared_surname_in_bout' };

  return { status: 'unresolved', reason: 'no_match_in_bout' };
}

/**
 * Match a source event to a canonical bout.
 *
 * Both fighters must resolve, and they must be the two corners of the same
 * bout. Date is a filter, never the match: two cards can share a date and a
 * date-only match would attach a price to the wrong fight.
 */
export function matchBout(srcEvent, bouts, byNorm) {
  const a = normName(stripNickname(srcEvent.home_team));
  const b = normName(stripNickname(srcEvent.away_team));
  if (!a || !b) return { status: 'unresolved', reason: 'missing_team_names' };

  const commence = srcEvent.commence_time ? new Date(srcEvent.commence_time) : null;
  const near = commence
    ? bouts.filter((x) => {
        if (!x.eventDate) return false;
        const d = Math.abs(new Date(`${x.eventDate}T00:00:00Z`) - commence) / 86400000;
        return d <= 2;                       // a card can start late UTC
      })
    : bouts;

  const hits = near.filter((x) => {
    const names = [normName(x.a.name), normName(x.b.name), normName(stripNickname(x.a.name)), normName(stripNickname(x.b.name))];
    const aHit = names.includes(a) || (byNorm.get(a) && (byNorm.get(a).has(x.a.id) || byNorm.get(a).has(x.b.id)));
    const bHit = names.includes(b) || (byNorm.get(b) && (byNorm.get(b).has(x.a.id) || byNorm.get(b).has(x.b.id)));
    return aHit && bHit;
  });

  if (hits.length === 1) return { status: 'ok', bout: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', reason: 'multiple_bouts_match_both_fighters' };
  return { status: 'unresolved', reason: 'no_bout_with_both_fighters' };
}

/* ---- odds math ----------------------------------------------------------
 * Shared so the Worker, the CLI and any read model agree on what a price
 * means. Kept here rather than beside the web market reader because the
 * Worker cannot import web/lib, and two implementations of implied
 * probability is how a de-vigged number stops matching the page showing it. */

/** American odds -> implied probability, vig included. */
export function impliedProbability(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

/** Implied probability -> American odds. The inverse of the above. */
export function probabilityToAmerican(p) {
  const x = Number(p);
  if (!Number.isFinite(x) || x <= 0 || x >= 1) return null;
  return x >= 0.5 ? -Math.round((100 * x) / (1 - x)) : Math.round((100 * (1 - x)) / x);
}

/** Median of a numeric list, or null. */
export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Two-way de-vig by proportional (multiplicative) normalisation.
 *
 * The two sides' implied probabilities sum to more than 1; the excess is the
 * book's margin. This removes it by scaling both to sum to 1, which assumes
 * the margin is applied proportionally. That assumption is not universally
 * true and the method is named in the output so a reader knows which one was
 * used rather than seeing an unattributed "true probability".
 *
 * Returns null unless BOTH sides are present: a one-sided de-vig is not a
 * de-vig, it is a guess about a price nobody quoted.
 */
export function devigTwoWay(priceA, priceB) {
  const a = impliedProbability(priceA);
  const b = impliedProbability(priceB);
  if (a === null || b === null) return null;
  const overround = a + b;
  if (!(overround > 0)) return null;
  return { method: 'proportional', overround, a: a / overround, b: b / overround };
}

/**
 * Consensus across books within one reading: the median implied probability,
 * converted back to a price.
 *
 * Median rather than mean so a single outlying book cannot move the number,
 * and one row per book so a book quoted twice in a payload does not get two
 * votes.
 */
export function consensusOf(rows) {
  const byBook = new Map();
  for (const r of rows || []) {
    const prev = byBook.get(r.bookmaker_key);
    if (!prev || String(r.source_last_update || '') > String(prev.source_last_update || '')) byBook.set(r.bookmaker_key, r);
  }
  const med = median([...byBook.values()].map((r) => impliedProbability(r.price)));
  return med === null ? null : { price: probabilityToAmerican(med), probability: med, books: byBook.size };
}

/**
 * Best available price for one side: the one most favourable to a bettor,
 * which is the LOWEST implied probability rather than the highest number —
 * the two disagree across the zero boundary.
 */
export function bestPrice(rows) {
  let best = null;
  for (const r of rows || []) {
    const p = impliedProbability(r.price);
    if (p === null) continue;
    if (!best || p < best.probability) best = { price: r.price, probability: p, bookmaker_key: r.bookmaker_key, bookmaker_name: r.bookmaker_name ?? null };
  }
  return best;
}
