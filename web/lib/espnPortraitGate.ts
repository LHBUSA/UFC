import type { Fighter, PortraitSet } from "./db";
import { normalizedName, sameIdentityName } from "./portraitIdentity.ts";

/* The ESPN display-portrait identity gate — ONE definition, two callers.
 *
 * lib/db.ts uses it to honour the display preference in
 * lib/displayPortraitPolicy.ts; lib/verifiedPortraits.ts uses it to re-check
 * ESPN images it is already serving. Both go through this function, so there
 * is a single answer to "is this the right person" and no second, looser path
 * that could drift.
 *
 * `db` is imported for TYPES ONLY. A runtime import would be a cycle, since
 * db.ts imports this module; `import type` is erased at compile time.
 */

/* An ESPN CDN slot can resolve successfully and still be the wrong face. A
 * 200 is availability proof, not identity proof, so known-bad assets are
 * quarantined for display while the fighter identity itself stays intact for
 * bout and result resolution. */
export const ESPN_DISPLAY_QUARANTINE: ReadonlySet<string> = new Set<string>([
  "5307124", // Quentin Pasley: wrong face observed on the ESPN display asset, 2026-09-10.
]);

const ESPN_ATHLETE = "https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/athletes";

type EspnAthletePayload = {
  id?: string | number;
  fullName?: string;
  displayName?: string;
  dateOfBirth?: string;
  headshot?: { href?: string; alt?: string } | null;
};

export type GateFighter = Pick<Fighter, "id" | "name" | "espn_athlete_id" | "dob">;

/**
 * The ESPN display portrait for a fighter, if and only if ESPN's own athlete
 * record verifies as the same person.
 *
 * Returns null when identity cannot be confirmed, `fallback` when ESPN is
 * merely unreachable (a transient outage must never blank a portrait), and a
 * display-only PortraitSet built from ESPN's published headshot href
 * otherwise. No bytes are fetched, copied or persisted: this is a URL.
 */
export async function espnVerifiedPortrait(
  fighter: GateFighter,
  fallback: PortraitSet | null,
): Promise<PortraitSet | null> {
  const athleteId = String(fighter.espn_athlete_id || "").trim();
  if (!/^\d+$/.test(athleteId)) return null;
  if (ESPN_DISPLAY_QUARANTINE.has(athleteId)) return null;

  try {
    const res = await fetch(`${ESPN_ATHLETE}/${athleteId}?lang=en&region=us`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 21600 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return res.status === 404 || res.status === 410 ? null : fallback;

    const athlete = (await res.json()) as EspnAthletePayload;
    if (String(athlete.id || "") !== athleteId) return null;

    /* DOB is resolved BEFORE the name check because it is what licenses the
     * generational-suffix tolerance. A disagreeing DOB fails closed. */
    const espnDob = athlete.dateOfBirth ? String(athlete.dateOfBirth).slice(0, 10) : "";
    if (fighter.dob && espnDob && espnDob !== fighter.dob) return null;
    const identityConfirmed = Boolean(fighter.dob && espnDob && espnDob === fighter.dob);

    const expected = normalizedName(fighter.name);
    const actual = normalizedName(athlete.fullName || athlete.displayName);
    if (!sameIdentityName(expected, actual, identityConfirmed)) return null;

    const headshot = athlete.headshot;
    if (headshot?.alt && !sameIdentityName(expected, normalizedName(headshot.alt), identityConfirmed)) return null;

    const href = String(headshot?.href || "").replace(/^http:/, "https:");
    if (!href) return fallback;

    return {
      ...(fallback ?? ({} as PortraitSet)),
      id: `espn:${athleteId}`,
      portrait: href,
      card: href,
      thumb: href,
      /* Display-only, and described as such everywhere it surfaces. The
       * stored licensed asset's author and licence are deliberately NOT
       * carried over: they describe a different photograph. */
      kind: "display_fallback",
      source_family: "espn",
      license: null,
      author: "ESPN",
      rights_label: "display_only",
      stored_first_party: false,
      source_url: `https://www.espn.com/mma/fighter/_/id/${athleteId}`,
      attribution_text: "ESPN · identity-verified display portrait",
      fighter_id: fighter.id,
    };
  } catch {
    return fallback;
  }
}
