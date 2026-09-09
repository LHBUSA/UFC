import type { CartLine } from "./cart.ts";

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

export const ACTIVE_RELEASE_SLUGS = [DROP001_SLUG, FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG] as const;
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

export function releaseLineAllowed(line: Pick<CartLine, "slug" | "size" | "color">): boolean {
  return isReleaseLine(line.slug, line.size, line.color);
}

export const DROP001_COLOR = RELEASE[DROP001_SLUG].colors[0];
export const DROP001_SIZES = RELEASE[DROP001_SLUG].sizes;
