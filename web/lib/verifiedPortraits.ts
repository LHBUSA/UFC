import "server-only";

import {
  getFightersByIds,
  getImagesForFighters,
  type Fighter,
  type PortraitSet,
} from "@/lib/db";
import { normalizedName, sameIdentityName } from "@/lib/portraitIdentity";

/* ESPN is valuable display coverage and stays enabled. The failure mode we
 * are preventing is different: an ESPN CDN slot can resolve successfully and
 * still be the wrong face. A 200 response is availability proof, not identity
 * proof. Known bad assets are quarantined while the fighter identity itself
 * remains intact for bout/result resolution. */
const ESPN_DISPLAY_QUARANTINE = new Set<string>([
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

/**
 * The ESPN display portrait for a fighter, if and only if ESPN's athlete
 * record verifies as the same person.
 *
 * Split out of verifyEspnPortrait so one identity gate serves both callers:
 * the display fallback below, which only fills coverage ESPN already owned,
 * and lib/heroPortraits.ts, which may prefer ESPN over a stored image on a
 * hero surface. Both go through the same id + date-of-birth + name checks, so
 * there is exactly one definition of "this is the right person" and no second
 * path that could relax it.
 *
 * Returns null when identity cannot be confirmed, `fallback` when ESPN is
 * merely unreachable, and a portrait set built from ESPN's own headshot href
 * otherwise. No bytes are copied or persisted anywhere: this is a display URL.
 */
export async function espnVerifiedPortrait(fighter: Fighter, fallback: PortraitSet | null): Promise<PortraitSet | null> {
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
      id: fallback?.id ?? `espn-${athleteId}`,
      kind: fallback?.kind ?? "espn_display",
      portrait: href,
      card: href,
      thumb: href,
      license: null,
      author: null,
      source_family: "espn",
      source_url: `https://www.espn.com/mma/fighter/_/id/${athleteId}`,
      attribution_text: "ESPN · identity-verified display fallback",
      fighter_id: fighter.id,
    };
  } catch {
    return fallback;
  }
}

async function verifyEspnPortrait(fighter: Fighter, image: PortraitSet): Promise<PortraitSet | null> {
  if (image.source_family !== "espn") return image;

  const athleteId = String(fighter.espn_athlete_id || "").trim();
  if (!/^\d+$/.test(athleteId)) return null;
  if (ESPN_DISPLAY_QUARANTINE.has(athleteId)) return null;

  try {
    const res = await fetch(`${ESPN_ATHLETE}/${athleteId}?lang=en&region=us`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 21600 },
      signal: AbortSignal.timeout(4000),
    });

    /* Do not wipe otherwise-good photo coverage because ESPN had a transient
     * outage. The database identity came from ESPN; this live verification is
     * an extra safety gate, not a new hard dependency for every render. */
    if (!res.ok) return res.status === 404 || res.status === 410 ? null : image;

    const athlete = (await res.json()) as EspnAthletePayload;
    if (String(athlete.id || "") !== athleteId) return null;

    /* DOB is resolved BEFORE the name check, because it is what licenses the
     * generational-suffix tolerance below. A disagreeing DOB still fails
     * closed, exactly as it did. */
    const espnDob = athlete.dateOfBirth ? String(athlete.dateOfBirth).slice(0, 10) : "";
    if (fighter.dob && espnDob && espnDob !== fighter.dob) return null;
    /* Two independent stable keys agree: the athlete id this record was
     * fetched by (asserted above) and the date of birth. */
    const identityConfirmed = Boolean(fighter.dob && espnDob && espnDob === fighter.dob);

    const expected = normalizedName(fighter.name);
    const actual = normalizedName(athlete.fullName || athlete.displayName);
    if (!sameIdentityName(expected, actual, identityConfirmed)) return null;

    const headshot = athlete.headshot;
    /* The alt text carries the same suffix as the athlete record, so it is
     * held to the same rule rather than to the stricter one. */
    if (headshot?.alt && !sameIdentityName(expected, normalizedName(headshot.alt), identityConfirmed)) return null;

    /* Prefer ESPN's explicit headshot href over synthesizing a CDN path. If
     * the athlete endpoint does not expose one, retain the already-probed
     * display URL produced by the base resolver. */
    const href = String(headshot?.href || "").replace(/^http:/, "https:");
    if (!href) return image;

    return {
      ...image,
      portrait: href,
      card: href,
      thumb: href,
      source_url: `https://www.espn.com/mma/fighter/_/id/${athleteId}`,
      attribution_text: "ESPN · identity-verified display fallback",
    };
  } catch {
    return image;
  }
}

/**
 * Display-only portrait resolver for high-visibility surfaces.
 *
 * Stored/licensed assets pass through unchanged. ESPN fills the remaining
 * coverage, but its athlete identity is checked before the image is accepted.
 * Known-bad ESPN assets fail closed to the branded UI fallback without
 * disabling ESPN for everybody else.
 */
export async function getVerifiedDisplayImagesForFighters(ids: string[]): Promise<Map<string, PortraitSet>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();

  const [images, fighters] = await Promise.all([
    getImagesForFighters(uniq),
    getFightersByIds(uniq),
  ]);
  const fighterById = new Map(fighters.map((fighter) => [fighter.id, fighter]));
  const out = new Map<string, PortraitSet>();

  await Promise.all([...images.entries()].map(async ([fighterId, image]) => {
    const fighter = fighterById.get(fighterId);
    if (!fighter) return;
    const verified = await verifyEspnPortrait(fighter, image);
    if (verified) out.set(fighterId, verified);
  }));

  return out;
}
