/* The fighter portrait resolver. Every public surface gets fighter photos from
 * here and nowhere else.
 *
 * Policy (docs/fighter_media_pipeline.md):
 *   - Only approved, identity-verified, primary, non-quarantined portraits,
 *     read from ufc_fighter_portrait_eligible.
 *   - High-visibility surfaces additionally require commercial_use_allowed and
 *     surface_policy = all_surfaces.
 *   - Anything else resolves to nothing and the UI draws the branded
 *     placeholder. There is no fallback source: no newest-ufc_images-row pick,
 *     no ESPN CDN URL synthesised from espn_athlete_id. An ESPN image can only
 *     appear as a stored, reviewed ufc_fighter_media_assets row that passed the
 *     same gate.
 *
 * Failure mode is the placeholder. A missing env var, a missing relation (the
 * migration not yet applied), a network error or a malformed row all yield an
 * empty map, never a guess and never a thrown error. */
import "server-only";
import { mediaUrl, rest, type PortraitSet } from "@/lib/db";
import { portraitDecision, type EligiblePortraitRow, type SurfaceTier } from "@/lib/fighterMediaPolicy";

export type { SurfaceTier } from "@/lib/fighterMediaPolicy";

/* Review actions revalidate this tag so an approval, rejection or quarantine
 * reaches public pages on the next request instead of after the TTL. */
export const FIGHTER_MEDIA_TAG = "fighter-media";
const PORTRAIT_TTL = 300;

const ELIGIBLE_COLS = [
  "id", "fighter_id", "image_url", "storage_key", "legacy_image_id", "source_url", "source_name", "source_type",
  "license_type", "license_label", "author", "commercial_use_allowed", "derivative_use_allowed", "attribution_required",
  "attribution_text", "verified_identity", "review_status", "is_primary", "surface_policy", "width", "height",
  "focal_x", "focal_y", "suitability_score", "last_verified_at",
].join(",");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/* Stored first-party portraits (the Commons pipeline) write portrait / card /
 * thumb siblings next to each other. Only that exact layout is assumed; any
 * other stored key or external URL is used as-is for every size. */
export function portraitFromAsset(row: EligiblePortraitRow): PortraitSet {
  const key = row.storage_key || null;
  const portrait = key ? mediaUrl(key) : row.image_url;
  const siblings = Boolean(key && /\/portrait\.jpg$/.test(key));
  const dir = key ? key.replace(/\/[^/]+$/, "") : "";
  return {
    /* The legacy ufc_images id keeps art-direction framing (getImageFraming)
     * and derivative crops working for promoted Commons portraits. */
    id: row.legacy_image_id || `asset:${row.id}`,
    asset_id: row.id,
    portrait,
    card: siblings ? mediaUrl(`${dir}/card.jpg`) : portrait,
    thumb: siblings ? mediaUrl(`${dir}/thumb.jpg`) : portrait,
    license: row.license_label,
    author: row.author,
    source_url: row.source_url,
    source_name: row.source_name,
    kind: row.source_type,
    source_family: row.source_type === "espn" ? "espn" : row.source_type,
    rights_label: row.license_label || row.license_type,
    attribution_text: row.attribution_text,
    stored_first_party: Boolean(key),
    commercial_use_allowed: row.commercial_use_allowed,
    surface_policy: row.surface_policy,
  };
}

async function eligibleRows(filter: string): Promise<EligiblePortraitRow[]> {
  return (await rest<EligiblePortraitRow[]>(
    `ufc_fighter_portrait_eligible?select=${ELIGIBLE_COLS}&${filter}`,
    [],
    { revalidate: PORTRAIT_TTL, tags: [FIGHTER_MEDIA_TAG] },
  )).data;
}

/**
 * Portraits for a set of fighters on one surface. Fighters without an
 * eligible portrait are simply absent from the map.
 *
 * `surface` defaults to high_visibility: forgetting to classify a surface
 * must make it stricter, not looser.
 */
export async function resolveFighterPortraits(
  ids: ReadonlyArray<string | null | undefined>,
  opts: { surface?: SurfaceTier } = {},
): Promise<Map<string, PortraitSet>> {
  const surface: SurfaceTier = opts.surface ?? "high_visibility";
  const out = new Map<string, PortraitSet>();
  const uniq = [...new Set(ids.filter(isUuid))];
  for (let i = 0; i < uniq.length; i += 150) {
    const chunk = uniq.slice(i, i + 150);
    const rows = await eligibleRows(`fighter_id=in.(${chunk.join(",")})`);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !chunk.includes(row.fighter_id) || out.has(row.fighter_id)) continue;
      if (portraitDecision(row, surface).ok) out.set(row.fighter_id, portraitFromAsset(row));
    }
  }
  return out;
}

export async function resolveFighterPortrait(id: string | null | undefined, opts: { surface?: SurfaceTier } = {}): Promise<PortraitSet | null> {
  return (await resolveFighterPortraits([id], opts)).get(String(id)) || null;
}

/**
 * Article hero images are ufc_images ids chosen by the editorial worker. They
 * are fighter photos too, so they pass the same gate: the hero renders only
 * when that exact image is some fighter's approved primary portrait. Otherwise
 * the story renders without a hero image.
 */
export async function resolveArticleHero(imageRef: string | null | undefined, opts: { surface?: SurfaceTier } = {}): Promise<PortraitSet | null> {
  if (!isUuid(imageRef)) return null;
  const surface: SurfaceTier = opts.surface ?? "high_visibility";
  const rows = await eligibleRows(`legacy_image_id=eq.${imageRef}&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row && row.legacy_image_id === imageRef && portraitDecision(row, surface).ok ? portraitFromAsset(row) : null;
}
