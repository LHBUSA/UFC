import { normalizeName } from './parser.js';

export const RECOGNIZED_EXTERNAL_PROMOTIONS = new Set([
  'pride', 'wec', 'strikeforce', 'bellator', 'pfl', 'wsof', 'one', 'rizin',
  'ksw', 'cage-warriors', 'lfa', 'invicta', 'brave', 'oktagon', 'dream',
  'shooto', 'pancrase', 'm1',
]);

export function verifyWikipediaCareer({ target, page, canonicalBouts, fighterNames }) {
  const wikiUfc = page.record.rows.filter((row) => row.promotion_slug === 'ufc');
  const matches = [];
  const conflicts = [];

  for (const row of wikiUfc) {
    const possible = canonicalBouts.filter((bout) => {
      const otherId = bout.fighter_a_id === target.id ? bout.fighter_b_id : bout.fighter_a_id;
      const opponent = fighterNames.get(otherId) || '';
      return bout.event_date === row.event_date && normalizeName(opponent) === normalizeName(row.opponent);
    });
    if (possible.length === 1) matches.push({ row, bout: possible[0] });
    else conflicts.push({ opponent: row.opponent, event_date: row.event_date, matches: possible.length });
  }

  const dbDob = target.dob || null;
  const wikiDob = page.record.dob || null;
  const dobConflict = Boolean(dbDob && wikiDob && dbDob !== wikiDob);
  const dobMatch = Boolean(dbDob && wikiDob && dbDob === wikiDob);

  let verified = false;
  if (!dobConflict && conflicts.length === 0) {
    if (canonicalBouts.length === 1) verified = dobMatch && matches.length === 1;
    else if (canonicalBouts.length >= 2) verified = matches.length >= 2;
  }

  return {
    verified,
    canonical_ufc_appearances: canonicalBouts.length,
    wikipedia_ufc_rows: wikiUfc.length,
    exact_ufc_matches: matches.length,
    ufc_conflicts: conflicts,
    db_dob: dbDob,
    wikipedia_dob: wikiDob,
    dob_match: dobMatch,
    dob_conflict: dobConflict,
  };
}

export function resultForCareerRow(row, targetId, opponentId) {
  if (row.result === 'win') return { outcome: 'win', winner_id: targetId };
  if (row.result === 'loss') return { outcome: 'win', winner_id: opponentId };
  if (row.result === 'draw') return { outcome: 'draw', winner_id: null };
  if (row.result === 'no_contest') return { outcome: 'no_contest', winner_id: null };
  return { outcome: 'unknown', winner_id: null };
}

export function shouldPromoteCareerRow(row) {
  return row.promotion_slug !== 'ufc'
    && row.promotion_recognized === true
    && RECOGNIZED_EXTERNAL_PROMOTIONS.has(row.promotion_slug)
    && Boolean(row.event_date)
    && Boolean(row.opponent_wiki_title);
}

export function scoreTarget({ ranked = false, champion = false, nextCardIndex = null, active = false, externalAppearances = 0 }) {
  let score = 0;
  if (champion) score += 130;
  else if (ranked) score += 100;
  if (Number.isInteger(nextCardIndex) && nextCardIndex >= 0 && nextCardIndex <= 2) score += 100 - nextCardIndex * 20;
  if (active) score += 20;
  if (!externalAppearances) score += 25;
  return score;
}
