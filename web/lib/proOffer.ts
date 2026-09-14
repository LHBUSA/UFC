/* UFC Pro founding-season offer: the ONE source for every customer-facing
 * price, checkout link and Product JSON-LD offer.
 *
 * Price shown, Stripe price charged and entitlement granted must agree:
 *   amountCents  == the Stripe Price unit_amount
 *   stripePriceId == the price the Payment Link sells
 *   paymentLinkId == the link propbetedge-sports-billing allowlists for ufc_pro
 * lib/proOffer.test.ts pins all three against each other. */

export type ProPlanKey = "monthly" | "weekly";

export type ProPlan = {
  key: ProPlanKey;
  label: string;
  amountCents: number;
  display: string;
  cadence: string;
  badge: string;
  stripePriceId: string;
  paymentLinkId: string;
  checkoutUrl: string;
};

export const PRO_OFFER = {
  productKey: "ufc_pro",
  stripeProductId: "prod_VD9SH84qnOUfJ1",
  pricingEra: "founding_season_2026",
  trial: "none",
  /* The existing Stripe Customer Portal (payment method, invoices, cancel at
   * period end), opened through its no-code login link: the customer confirms
   * their email with Stripe, so no Stripe key or customer id touches this app. */
  customerPortalLoginUrl: "https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00",
  plans: {
    monthly: {
      key: "monthly",
      label: "UFC Pro Monthly",
      amountCents: 999,
      display: "$9.99",
      cadence: "month",
      badge: "BEST VALUE",
      stripePriceId: "price_1UFbcDF3CaVzg4ORCf1e51tC",
      paymentLinkId: "plink_1UFdRLF3CaVzg4ORUQBjDiJT",
      checkoutUrl: "https://buy.stripe.com/7sYeVd1rU56e8FL3kf7wA0G",
    },
    weekly: {
      key: "weekly",
      label: "UFC Pro Weekly",
      amountCents: 399,
      display: "$3.99",
      cadence: "week",
      badge: "FLEXIBLE",
      stripePriceId: "price_1UFdQtF3CaVzg4ORT5RYbFrL",
      paymentLinkId: "plink_1UFdRVF3CaVzg4OR67Ogkqkf",
      checkoutUrl: "https://buy.stripe.com/9B69ATgmOfKS7BHbQL7wA0H",
    },
  } satisfies Record<ProPlanKey, ProPlan>,
} as const;

/** Retired acquisition objects. Never linked from the site again; kept so tests can prove it. */
export const RETIRED_CHECKOUT = [
  "https://buy.stripe.com/cNi00j0nQfKSbRX9ID7wA0r",
  "https://buy.stripe.com/eVqaEX1rUbuC09f5sn7wA0s",
  "price_1UCj9gF3CaVzg4ORLONdruoG",
  "price_1UCj9mF3CaVzg4ORqv6fj2Um",
  "plink_1UCjA1F3CaVzg4ORvb7WMZTA",
  "plink_1UCjAIF3CaVzg4ORPyEBfPPF",
] as const;

export const PRO_PLAN_ORDER: ProPlanKey[] = ["monthly", "weekly"];

export function offerJsonLd(siteUrl: string) {
  return PRO_PLAN_ORDER.map((k) => {
    const p = PRO_OFFER.plans[k];
    return {
      "@type": "Offer",
      name: p.label,
      price: (p.amountCents / 100).toFixed(2),
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: `${siteUrl}/pro`,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: (p.amountCents / 100).toFixed(2),
        priceCurrency: "USD",
        referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: p.cadence === "week" ? "WEE" : "MON" },
      },
    };
  });
}
