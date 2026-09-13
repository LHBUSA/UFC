/* Which fighters get an ESPN display portrait on hero surfaces — pure policy,
 * no imports, so it is testable on its own.
 *
 * Split from lib/heroPortraits.ts for the same reason lib/portraitIdentity.ts
 * is split from the resolver: this is an identity-sensitive rule, and a rule
 * that decides whose face appears on the largest image on the site should be
 * checkable without a network, a database or a module alias.
 */

/**
 * Canonical fighter_id → the ESPN athlete id we expect behind it.
 *
 * Both must match before the override applies, so the swap cannot survive a
 * re-pointed linkage. Name matching is never used at any step.
 *
 * Entries are a presentation fix for one surface, not a licensing or identity
 * statement: the stored image stays on the fighter profile with its
 * attribution, and nothing is downloaded or persisted.
 */
export const HERO_ESPN_PREFERRED: ReadonlyMap<string, string> = new Map([
  /* Stored portrait is CC BY 3.0 (Sexto Round) and remains on his profile.
   * It is an interview screenshot — legally reusable, not hero media. */
  ["13eebfea-dbd0-4110-a41a-200b8a73051d", "2560746"], // Alexandre Pantoja
]);

/** Is this fighter on the hero override list, by canonical id AND ESPN id? */
export function heroPrefersEspn(fighter: { id: string; espn_athlete_id?: string | null }): boolean {
  const expected = HERO_ESPN_PREFERRED.get(fighter.id);
  return Boolean(expected) && String(fighter.espn_athlete_id || "") === expected;
}
