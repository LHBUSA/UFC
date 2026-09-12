/* Name equivalence for portrait identity verification.
 *
 * Pure, dependency-free and separately testable on purpose: this is the rule
 * that decides whether a fetched ESPN athlete record is allowed to supply a
 * fighter's face, and it is exactly the kind of rule that quietly becomes
 * fuzzy matching if nobody is watching it. lib/verifiedPortraits.ts is
 * `server-only`, so the logic lives here where a test can reach it.
 */

/** Case, accent and punctuation insensitive. Shared by both sides. */
export function normalizedName(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* A trailing generational suffix, and nothing else.
 *
 * Our records carry "Sean King"; ESPN's athlete 5401058 is "Sean King III",
 * and its headshot alt text says "Sean King III" too. Requiring exact equality
 * rejected a correct, identity-confirmed portrait purely over "iii", and that
 * fighter fell back to the branded mark on every surface using the verified
 * resolver while the base resolver showed the same image elsewhere.
 *
 * The list is closed and the match is anchored to the END of the name, so this
 * can never shorten a real surname: "sean kingston" keeps its tail, and
 * "sean king" vs "sean kingston" remains a mismatch.
 */
const GENERATIONAL_SUFFIX = /\s+(?:jr|sr|ii|iii|iv|v)$/;

export function withoutGenerationalSuffix(normalized: string): string {
  return normalized.replace(GENERATIONAL_SUFFIX, "").trim();
}

/**
 * Are these two names the same person, for portrait verification only?
 *
 * Exact match always passes. A generational-suffix difference passes ONLY when
 * `identityConfirmed` — meaning two independent stable keys already agree: the
 * ESPN athlete id the record was looked up by, and a matching date of birth.
 * Without that confirmation the original strict comparison stands.
 *
 * This cannot become fuzzy matching between two different people: it strips
 * one fixed suffix and then demands exact equality of everything that remains,
 * on top of an id and a DOB that already agree.
 */
export function sameIdentityName(expected: string, actual: string, identityConfirmed: boolean): boolean {
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if (!identityConfirmed) return false;
  const a = withoutGenerationalSuffix(expected);
  const b = withoutGenerationalSuffix(actual);
  /* A name that is ONLY a suffix strips to "" — two such names must not become
   * equal by both collapsing to nothing. */
  return Boolean(a) && a === b;
}
