/**
 * Stripe, and the shipping rates it is allowed to offer.
 *
 * The client is created lazily and only when a key exists, so importing this
 * module on a deployment with no Stripe configured is harmless. Everything
 * that needs Stripe fails closed instead: a shop with no key does not have a
 * broken checkout, it has no checkout, and the button says so.
 *
 * SHIPPING IS DEFINED HERE, IN CENTS, ON THE SERVER.
 *
 * That is the whole point of this file existing rather than the rates being
 * passed in. A browser that can name its own shipping rate can name zero, and
 * the failure is silent: the order looks normal, the parcel ships, and the
 * margin is gone. Stripe is handed these options and the customer picks one
 * of them; nothing from the request body reaches this list.
 *
 * The amounts are our published rates for print-on-demand delivery. They are
 * flat by design — a real carrier quote needs a weight and a dimension per
 * item, and this shop sells four garments, so a flat rate is honest and a
 * computed one would be a fiction with more decimal places.
 */
import "server-only";
import Stripe from "stripe";

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function webhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

let client: Stripe | null = null;

export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  /* Pin nothing. The installed SDK has exactly one API version it is
   * typed against, and naming a different one here compiles only until
   * the next upgrade and then fails in a way that looks like a Stripe
   * outage. Omitting it uses the version the SDK was built for. */
  if (!client) client = new Stripe(key);
  return client;
}

/** Where we will ship. Kept short deliberately: every country added is a
 * customs and returns question somebody has to be able to answer. */
export const SHIP_TO_COUNTRIES: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] = [
  "US",
  "CA",
  "GB",
  "IE",
  "AU",
  "NZ",
];

type Rate = { label: string; cents: number; minDays: number; maxDays: number };

/* Production time is not delivery time, and the estimates below are the
 * carrier's leg only. /store/policies says so in words; these numbers are the
 * same claim in data, so the two cannot drift apart. */
const RATES: Record<"domestic" | "international", Rate> = {
  domestic: { label: "Standard shipping", cents: 599, minDays: 3, maxDays: 7 },
  international: { label: "International shipping", cents: 1299, minDays: 7, maxDays: 21 },
};

export function shippingOptions(): Stripe.Checkout.SessionCreateParams.ShippingOption[] {
  return (Object.keys(RATES) as Array<keyof typeof RATES>).map((k) => {
    const r = RATES[k];
    return {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: { amount: r.cents, currency: "usd" },
        display_name: r.label,
        delivery_estimate: {
          minimum: { unit: "business_day", value: r.minDays },
          maximum: { unit: "business_day", value: r.maxDays },
        },
      },
    };
  });
}

/**
 * Whether to let Stripe compute tax.
 *
 * Opt-in through an environment variable rather than simply switched on,
 * because Stripe Tax must be enabled and have an origin address registered on
 * the account before it will work; a session created with automatic_tax on an
 * unconfigured account fails outright. So the default is off, the shop still
 * works, and turning it on is a deliberate act by somebody who has checked
 * the dashboard.
 */
export function automaticTaxEnabled(): boolean {
  return process.env.STRIPE_AUTOMATIC_TAX === "1";
}
