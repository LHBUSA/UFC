import "server-only";

import type { Fighter, PortraitSet } from "@/lib/db";
import { espnVerifiedPortrait } from "@/lib/verifiedPortraits";
import { heroPrefersEspn } from "@/lib/heroPortraitPolicy";

export { heroPrefersEspn };

/* Hero-surface portrait preference.
 *
 * A stored portrait can be perfectly licensed and still be the wrong picture
 * for a full-bleed event hero — an openly licensed interview screenshot is
 * legally reusable and looks like a man sitting at home. That is a
 * presentation problem on one surface, not a licensing problem and not an
 * identity problem, so it is fixed on that surface and nowhere else.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not change the canonical fighter, delete or demote the stored
 * image, or alter the portrait resolver anywhere else. The fighter profile
 * and every other surface keep the licensed image with its attribution. No
 * ESPN bytes are downloaded or persisted: the override swaps in a display URL
 * that ESPN serves, exactly as the existing verified display fallback does.
 *
 * WHY IT IS KEYED BY TWO IDS
 *
 * The entry names the canonical fighter_id AND the ESPN athlete id we expect
 * to find behind it. Both must match, and the swap then still has to clear
 * the same identity gate every ESPN portrait clears — athlete id, date of
 * birth and name. Name-only matching is never involved at any step. If the
 * linkage ever changed underneath us, the override silently declines rather
 * than putting a stranger's face on the hero.
 */
/**
 * Apply hero preferences to an already-resolved portrait map.
 *
 * Takes the map the surface already built, so this adds no query and changes
 * nothing for any fighter not on the list. A fighter whose ESPN identity
 * fails to verify keeps the stored image: the override can only ever improve
 * the picture or do nothing, never blank a hero.
 */
export async function applyHeroPortraits(
  images: Map<string, PortraitSet>,
  fighters: Array<Fighter | null | undefined>,
): Promise<Map<string, PortraitSet>> {
  const targets = fighters.filter((f): f is Fighter => Boolean(f) && heroPrefersEspn(f!));
  if (!targets.length) return images;

  const out = new Map(images);
  await Promise.all(targets.map(async (f) => {
    try {
      const stored = images.get(f.id) ?? null;
      const espn = await espnVerifiedPortrait(f, stored);
      /* Only swap on a genuine ESPN result. espnVerifiedPortrait returns the
       * fallback unchanged when ESPN is merely unreachable, and null when
       * identity does not verify — neither is a reason to touch the hero. */
      if (espn && espn.source_family === "espn" && espn.portrait) out.set(f.id, espn);
    } catch {
      /* keep the stored image */
    }
  }));
  return out;
}
