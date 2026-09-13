/* Which fighters prefer a verified ESPN display portrait over their stored
 * licensed asset — pure policy, no imports, so it is testable on its own.
 *
 * THE ONE POLICY. There is deliberately no second list anywhere: a hero-only
 * override and a global override that can disagree is exactly how the wrong
 * face ends up on one surface and the right one on another.
 *
 * WHAT AN ENTRY MEANS, AND WHAT IT DOES NOT
 *
 * It is a PRESENTATION decision on a display layer, and nothing else. The
 * stored image keeps its record, source, author, licence, attribution and
 * provenance; it simply stops being the primary portrait while a verified
 * ESPN headshot is available. The ESPN asset is display-only: never
 * downloaded, never copied into storage, never described as relicensable.
 *
 * WHY TWO IDS
 *
 * An entry names the canonical fighter_id AND the ESPN athlete id expected
 * behind it. Both must match, and the swap must then still clear the full
 * identity gate — athlete id, date of birth, name, headshot alt text, and the
 * standing quarantine. Name matching is never used at any step. If the
 * linkage were ever re-pointed the preference declines rather than putting a
 * stranger's face on a fighter's page.
 *
 * THIS IS NOT A GENERAL RULE
 *
 * Licensed canonical media remains preferred for the roster. This list is a
 * narrow exception for assets that are legally fine and unusable as a
 * portrait. If it starts growing, that is the signal to build a real
 * media-quality policy rather than to add another line here.
 */
export const DISPLAY_ESPN_PREFERRED: ReadonlyMap<string, string> = new Map([
  /* Stored portrait is CC BY 3.0 (Sexto Round) and is retained in full on the
   * media record: an interview screenshot in a hallway, legally reusable and
   * not a fighter portrait. */
  ["13eebfea-dbd0-4110-a41a-200b8a73051d", "2560746"], // Alexandre Pantoja
]);

/** Does this fighter prefer the verified ESPN portrait, by canonical id AND ESPN id? */
export function prefersEspnDisplay(fighter: { id: string; espn_athlete_id?: string | null }): boolean {
  const expected = DISPLAY_ESPN_PREFERRED.get(fighter.id);
  return Boolean(expected) && String(fighter.espn_athlete_id || "") === expected;
}

/** Canonical fighter ids carrying a preference, for scoping a lookup. */
export const preferredDisplayFighterIds = (): string[] => [...DISPLAY_ESPN_PREFERRED.keys()];
