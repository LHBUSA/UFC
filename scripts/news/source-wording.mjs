/* Customer source wording for generated UFC articles (PropBetEdge network standard: DATA · PropSports).
 *
 * Generated copy never names the collection lane ("UFC Stats", "ESPN"); round-level figures are PropSports
 * round statistics. Internal provenance (fact_block.sources.families, ufcstats ids) is untouched.
 *
 * Version gate: fact_block prose (bettor_angle, depth reasons, risks) feeds the stored fact-block hash, and a
 * hash change refreshes the stored row (and can buy a desk rewrite). A wording-only change is not a fact change,
 * so the hash is computed over legacyHashView(): every neutral phrase mapped back to the exact legacy phrase it
 * replaced. Unchanged facts keep their stored hash (no refresh storm); new rows and rows whose facts really change
 * are written with the neutral copy. Each pair must stay an exact, unique substring of the generator's text.
 */
export const WORDING = [
  // [neutral (emitted), legacy (hash view only)]
  ['Round-level striking and grappling averages are not on file for', 'UFC Stats striking and grappling averages are not on file for'],
  ['without round-level pace figures for', 'without UFC Stats pace figures for'],
  ['no round-level averages for either fighter and a short archive', 'no UFC Stats averages for either fighter and a short archive'],
  ['no career-to-date round statistics for', 'no UFC Stats career averages for'],
  ['the archive and the round statistics say ahead of', 'the archive and UFC Stats say ahead of'],
  ['archive and round-statistics tables can and cannot say', 'archive and UFC Stats tables can and cannot say'],
  ['Career-to-date round statistics are on file for', 'UFC Stats career averages are on file for'],
  ['round-level averages are on file for only', 'UFC Stats averages are on file for only'],
  ['has a round-level striking profile on file', 'has a UFC Stats striking profile on file'],
  ['career-to-date PropSports round-statistics snapshots at capture', 'career-to-date UFC Stats snapshots at capture'],
  ['our tables carry no round-level averages', 'our tables carry no UFC Stats averages'],
  ['Round-level PropSports data exists for', 'Round-level UFC Stats exist for'],
  ['With no round-level averages on file', 'With no UFC Stats averages on file'],
  ['of round-level PropSports data', 'of UFC Stats data'],
  ['Round-level data for the main event', 'UFC Stats round data for the main event'],
  ['Round-level data is in our tables for', 'UFC Stats round data is in our tables for'],
  ['Career-to-date round statistics were on file for', 'UFC Stats career averages were on file for'],
  ['Round-level data for this bout', 'UFC Stats round data for this bout'],
];
const BY_LENGTH = [...WORDING].sort((x, y) => y[0].length - x[0].length);

function legacyText(s) {
  let out = s;
  for (const [neutral, legacy] of BY_LENGTH) if (out.includes(neutral)) out = out.split(neutral).join(legacy);
  return out;
}
/* Deep copy of a fact block with neutral wording mapped back to legacy wording (hash input only; never stored). */
export function legacyHashView(v) {
  if (typeof v === 'string') return legacyText(v);
  if (Array.isArray(v)) return v.map(legacyHashView);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = legacyHashView(x); return o; }
  return v;
}
/* Upstream lane names that must never appear as source branding in generated copy. */
export const LANE_BRANDING = /\bUFC ?Stats\b|\bUFCStats\b|\bESPN\b(?! ?BET| MMA\b|\+)/;
