import {
  FIGHT_DNA_TEE_SLUG,
  PBE_MUG_SLUG,
  DROP001_SLUG,
  TALE_OF_TAPE_HOODIE_SLUG,
  PBE_CLASSIC_HAT_SLUG,
  TRUST_DATA_MUG_SLUG,
  type ActiveReleaseSlug,
} from "./release-policy.ts";

/** Live Stripe catalog bindings for every product the UFC store may charge. */
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
  [TALE_OF_TAPE_HOODIE_SLUG]: {
    productId: "prod_VE4iLSyAoqecmv",
    priceId: "price_1UDcZ3F3CaVzg4ORJvBdWb4g",
    unitAmount: 6500,
    currency: "usd",
  },
  [PBE_CLASSIC_HAT_SLUG]: {
    productId: "prod_VE4i0GeTY5D169",
    priceId: "price_1UDcZ9F3CaVzg4ORMqzD2dlb",
    unitAmount: 2800,
    currency: "usd",
  },
  [TRUST_DATA_MUG_SLUG]: {
    productId: "prod_VE4iWB3pLVSlYf",
    priceId: "price_1UDcZIF3CaVzg4ORjSEFRPBl",
    unitAmount: 1900,
    currency: "usd",
  },
};

export function stripeMerch(slug: string) {
  return (STRIPE_MERCH as Record<string, (typeof STRIPE_MERCH)[ActiveReleaseSlug]>)[slug] ?? null;
}
