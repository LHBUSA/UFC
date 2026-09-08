/**
 * One place that decides whether two written names are the same fighter.
 *
 * There were three copies of this judgement — in the importer, the classifier
 * and the summary — each slightly different, and every difference showed up as
 * a false gap in the archive. Fifteen verified finals were reported as absent
 * from the bracket; eleven of them were present under a spelling the matcher
 * did not accept. "Tommy Speer" against "Tom Speer". "CB Dollaway" against
 * "C. B. Dollaway". "Brogan Walker" against "Brogan Walker-Sanchez". Reporting
 * those as missing data is worse than useless: it invents holes and then
 * invites someone to fill them.
 *
 * Every rule below is a written convention, not a similarity score. There is
 * no fuzzy distance anywhere in this file, because a threshold is a promise
 * that two names are close enough to be one person, and nothing about spelling
 * distance supports that promise. A name that does not match by one of these
 * rules does not match.
 *
 * Which rule fired is returned, so a match can be audited rather than trusted.
 */

export const fold = (n) =>
  String(n || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const SUFFIXES = new Set(['jr', 'junior', 'sr', 'senior', 'ii', 'iii', 'iv']);

const tokens = (n) => fold(n).split(' ').filter(Boolean);
const withoutSuffix = (t) => t.filter((x) => !SUFFIXES.has(x));

/** "C. B." and "CB" are the same initials written two ways. */
const collapseInitials = (t) => {
  const out = [];
  let run = '';
  for (const tok of t) {
    if (tok.length === 1) { run += tok; continue; }
    if (run) { out.push(run); run = ''; }
    out.push(tok);
  }
  if (run) out.push(run);
  return out;
};

/**
 * Given names that are the same name written differently. Spelling variants of
 * one name and its ordinary short form — not nicknames that replace a name,
 * and not surnames, which are the part that has to match outright.
 */
const GIVEN_VARIANTS = [
  ['michael', 'mike'],
  ['thomas', 'tommy', 'tom'],
  ['mohammed', 'mohammad', 'muhammad', 'mohamed'],
  ['antonio', 'antonio'],
  ['marcio', 'marcio'],
  ['jose', 'jose'],
  ['manvel', 'manny'],
  ['daniel', 'danny', 'dan'],
  ['robert', 'rob', 'bobby'],
  ['william', 'will', 'billy'],
  ['joseph', 'joe'],
  ['matthew', 'matt'],
  ['nicholas', 'nick'],
  ['alexander', 'alex'],
  ['benjamin', 'ben'],
  ['christopher', 'chris'],
];
const givenSame = (a, b) => {
  if (a === b) return true;
  return GIVEN_VARIANTS.some((g) => g.includes(a) && g.includes(b));
};

/**
 * Do these two written names denote the same fighter?
 *
 * Returns { same, rule } — rule names the convention that matched, so a caller
 * can print it and a reader can disagree with it.
 */
export function nameMatch(rawA, rawB) {
  const A0 = tokens(rawA);
  const B0 = tokens(rawB);
  if (!A0.length || !B0.length) return { same: false, rule: null };

  const a = fold(rawA);
  const b = fold(rawB);
  if (a === b) return { same: true, rule: 'exact' };

  /* Family name first or given name first. Our roster writes many Chinese
   * names one way and the season sources the other; both orders name the same
   * two syllables, so this is a convention rather than a guess. Restricted to
   * two-token names, where there is only one possible reordering. */
  if (A0.length === 2 && B0.length === 2 && A0[0] === B0[1] && A0[1] === B0[0]) {
    return { same: true, rule: 'reversed-name-order' };
  }

  const A1 = collapseInitials(withoutSuffix(A0));
  const B1 = collapseInitials(withoutSuffix(B0));
  if (A1.join(' ') === B1.join(' ')) return { same: true, rule: 'suffix-or-initials' };

  /* One name carries a surname the other omits: "Robert Valentin" and "Robert
   * Valentin Frey", "Brogan Walker" and "Brogan Walker-Sanchez". Accepted only
   * when the shorter name's tokens are a contiguous prefix of the longer one's
   * AND at least two tokens agree, so a lone shared given name is never
   * enough. */
  const [shortT, longT] = A1.length <= B1.length ? [A1, B1] : [B1, A1];
  if (shortT.length >= 2 && longT.slice(0, shortT.length).join(' ') === shortT.join(' ')) {
    return { same: true, rule: 'additional-surname' };
  }
  /* Same, for a hyphenated surname that folded into two tokens. */
  if (shortT.length >= 2 && longT.length > shortT.length) {
    const sameGiven = shortT.slice(0, -1).join(' ') === longT.slice(0, shortT.length - 1).join(' ');
    const surnameExtended = longT.slice(shortT.length - 1).includes(shortT[shortT.length - 1]);
    if (sameGiven && surnameExtended) return { same: true, rule: 'extended-surname' };
  }

  /* Same surname, and a given name that is the same name written differently.
   * The surname must match outright — this rule never bridges two surnames. */
  if (A1.length >= 2 && B1.length >= 2) {
    const aSur = A1[A1.length - 1];
    const bSur = B1[B1.length - 1];
    if (aSur === bSur && givenSame(A1[0], B1[0])) {
      return { same: true, rule: 'given-name-variant' };
    }
  }

  return { same: false, rule: null };
}

/**
 * Do these two BOUTS name the same pair of fighters?
 *
 * Both corners must match, in either order. Requiring both is what keeps the
 * looser single-name rules safe: two different people rarely both match across
 * a pairing, and a bout is the unit we actually care about.
 */
export function pairMatch(a1, b1, a2, b2) {
  const straight = nameMatch(a1, a2).same && nameMatch(b1, b2).same;
  if (straight) return { same: true, rules: [nameMatch(a1, a2).rule, nameMatch(b1, b2).rule] };
  const crossed = nameMatch(a1, b2).same && nameMatch(b1, a2).same;
  if (crossed) return { same: true, rules: [nameMatch(a1, b2).rule, nameMatch(b1, a2).rule] };
  return { same: false, rules: [] };
}

/** Every spelling a bout record knows a corner by. */
export function cornerNames(bout, side) {
  return [bout[side], bout[`${side}_in_records`], bout[`${side}_in_archive`]].filter(Boolean);
}
