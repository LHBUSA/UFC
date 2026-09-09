import type { ProvisionRecord } from "./types.ts";
import { variantKey } from "./types.ts";

/**
 * The products we are actually willing to charge for right now.
 *
 * This is intentionally narrower than catalog status. The catalog is the
 * permanent design manifest; this file is the release gate. A design can stay
 * authored and visible for months without becoming orderable by accident.
 */
export const DROP001_SLUG = "propbetedge-hoodie";
export const FIGHT_DNA_TEE_SLUG = "fight-dna-tee";
export const PBE_MUG_SLUG = "propbetedge-mug";
export const TALE_OF_TAPE_HOODIE_SLUG = "tale-of-the-tape-hoodie";
export const PBE_CLASSIC_HAT_SLUG = "propbetedge-hat";
export const TRUST_DATA_MUG_SLUG = "trust-the-data-mug";

export const ACTIVE_RELEASE_SLUGS = [
  DROP001_SLUG,
  FIGHT_DNA_TEE_SLUG,
  PBE_MUG_SLUG,
  TALE_OF_TAPE_HOODIE_SLUG,
  PBE_CLASSIC_HAT_SLUG,
  TRUST_DATA_MUG_SLUG,
] as const;
export type ActiveReleaseSlug = (typeof ACTIVE_RELEASE_SLUGS)[number];

type ReleaseSpec = {
  label: string;
  sizes: readonly string[];
  colors: readonly string[];
};

const RELEASE: Record<ActiveReleaseSlug, ReleaseSpec> = {
  [DROP001_SLUG]: {
    label: "Drop 001 · Premium Hoodie",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: ["Black"],
  },
  [FIGHT_DNA_TEE_SLUG]: {
    label: "Drop 002 · Fight DNA Tee",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: ["Black"],
  },
  [PBE_MUG_SLUG]: {
    label: "Drop 002 · PBE Black Mug",
    sizes: ["11 oz"],
    colors: ["Black"],
  },
  [TALE_OF_TAPE_HOODIE_SLUG]: {
    label: "Drop 003 · Tale of the Tape Hoodie",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: ["Black"],
  },
  [PBE_CLASSIC_HAT_SLUG]: {
    label: "Drop 003 · PBE Classic Hat",
    sizes: ["One size"],
    colors: ["Black"],
  },
  [TRUST_DATA_MUG_SLUG]: {
    label: "Drop 003 · Trust the Data Mug",
    sizes: ["11 oz"],
    colors: ["Black"],
  },
};

export function releaseSpec(slug: string): ReleaseSpec | null {
  return (RELEASE as Record<string, ReleaseSpec>)[slug] ?? null;
}

export function isActiveReleaseSlug(slug: string): slug is ActiveReleaseSlug {
  return Boolean(releaseSpec(slug));
}

export function isReleaseLine(slug: string, size: string, color: string): boolean {
  const spec = releaseSpec(slug);
  return Boolean(spec && spec.sizes.includes(size) && spec.colors.includes(color));
}

export function releaseOptions(slug: string): { sizes: string[]; colors: string[] } | null {
  const spec = releaseSpec(slug);
  return spec ? { sizes: [...spec.sizes], colors: [...spec.colors] } : null;
}

export function releaseLineAllowed(line: { slug: string; size: string; color: string }): boolean {
  return isReleaseLine(line.slug, line.size, line.color);
}

/**
 * A release is buyable only after the provider catalog has been reconciled and
 * every size/colour we advertise has an exact catalog variant id. `unclaimed`
 * remains valid because these orders are created directly from catalog variant
 * ids; a separately-created sync product is not required.
 */
export function releaseProvisioningReady(slug: string, rec: ProvisionRecord | null | undefined): boolean {
  const spec = releaseSpec(slug);
  if (!spec || !rec || !rec.reconciled_at) return false;
  if (rec.state !== "unclaimed" && rec.state !== "created") return false;
  for (const color of spec.colors) {
    for (const size of spec.sizes) {
      const id = rec.provider_variant_ids?.[variantKey(size, color)];
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return false;
    }
  }
  return true;
}

export const DROP001_COLOR = RELEASE[DROP001_SLUG].colors[0];
export const DROP001_SIZES = RELEASE[DROP001_SLUG].sizes;
