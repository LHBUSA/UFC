import { FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG } from "./release-policy.ts";

export type StoreImage = {
  url: string;
  width: number;
  height: number;
  alt: string;
};

/**
 * Approved customer-facing mockups. These are deliberately separate from the
 * production print files: mockups show the finished object; production art is
 * transparent artwork sent to the printer.
 */
export const APPROVED_MOCKUPS: Readonly<Record<string, StoreImage>> = {
  [FIGHT_DNA_TEE_SLUG]: {
    url: "/store/img/fight-dna-tee-hero-v1.jpg",
    width: 720,
    height: 900,
    alt: "Black Fight DNA tee with metallic gold DNA and PropBetEdge artwork",
  },
  [PBE_MUG_SLUG]: {
    url: "/store/img/propbetedge-mug-black-hero-v1.jpg",
    width: 720,
    height: 900,
    alt: "Black PropBetEdge mug with the metallic PBE logo",
  },
};

export function approvedMockup(slug: string): StoreImage | null {
  return APPROVED_MOCKUPS[slug] ?? null;
}
