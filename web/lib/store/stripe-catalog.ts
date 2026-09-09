import { FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG, DROP001_SLUG, type ActiveReleaseSlug } from "./release-policy.ts";

/**
 * Live Stripe catalog bindings for the current merch release.
 *
 * Product and Price IDs are public identifiers, not credentials, so keeping
 * them in source makes the checkout contract explicit and reviewable. The
 * secret key still lives only in the deployment environment.
 *
 * These prices were created in the Proptechusa.ai live Stripe account on
 * 2026-09-08. The server verifies the catalog amount matches `unitAmount`
 * before it lets a line into Checkout, so a future catalog price change cannot
 * silently drift away from the authored storefront price.
 */
export const STRIPE_MERCH: Record<ActiveReleaseSlug, {
  productId: string;
  priceId: string;
  unitAmount: number;
  currency: "usd";
}> = {
  [DROP001_SLUG]: {
    productId: "prod_VE3rhCTNg9tY3L",
    priceId: "price_1UDbjtF3CaVzg4ORmyhAWuKc",
    unitAmount: 6500,
    currency: "usd",
  },
  [FIGHT_DNA_TEE_SLUG]: {
    productId: "prod_VE3rrFuRQFhyX1",
    priceId: "price_1UDbk1F3CaVzg4ORytCjWELL",
    unitAmount: 3200,
    currency: "usd",
  },
  [PBE_MUG_SLUG]: {
    productId: "prod_VE3rhpP75tvngY",
    priceId: "price_1UDbk7F3CaVzg4ORNOH3xVkg",
    unitAmount: 1900,
    currency: "usd",
  },
};

export function stripeMerch(slug: string) {
  return (STRIPE_MERCH as Record<string, (typeof STRIPE_MERCH)[ActiveReleaseSlug]>)[slug] ?? null;
}
