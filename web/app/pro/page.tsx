import type { Metadata } from "next";
import Link from "next/link";
import { ProPlans, PageHead, JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "UFC Pro — Fight DNA & Fight-Week Intelligence",
  description: "PropBetEdge UFC Pro founding access: Fight DNA, bettor-grade UFC analysis and fight-week intelligence, with model pricing and picks held back until validated.",
  alternates: { canonical: "/pro" },
};

export default function ProPage() {
  return (
    <div className="wrap page">
      <PageHead
        crumbs={[{ name: "Pro" }]}
        eyebrow="UFC Pro"
        title="Fight intelligence first. Model claims only when earned."
        lede="UFC Pro founding access is open through secure Stripe checkout. Fight DNA, bettor-grade analysis and fight-week intelligence are the foundation; model prices, picks and probabilities remain locked until PropBetEdge has a graded out-of-time track record to support them."
      />

      <ProPlans />

      <div className="grid-3 mt-6">
        {[
          ["Fight DNA over surface stats", "Opponent stance, pace, attack distribution, grappling context and as-of historical features are being built as a versioned intelligence layer rather than a stat dump."],
          ["Fight week is part of the product", "Card changes, official weigh-ins, news state and future market snapshots belong in the same bout timeline so the context present when a decision was made is never lost."],
          ["No manufactured edge", "If PropBetEdge does not have a verified line, model output or enough sample to support a claim, the product says so. Locked means locked until the evidence exists."],
        ].map(([h, p]) => (
          <div key={h} className="card">
            <h3 className="serif" style={{ marginBottom: 8, fontSize: 20 }}>{h}</h3>
            <p className="dim sm">{p}</p>
          </div>
        ))}
      </div>

      <div className="card hi mt-6 between">
        <div>
          <div className="eyebrow">Billing status</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>Stripe checkout is live.</div>
          <div className="faint sm">Monthly UFC Pro is $14.99. A one-card pass is $5.99. Account entitlement and passwordless member access are the next billing-layer gate; model-only surfaces stay locked until validated.</div>
        </div>
        <Link href="/login" className="btn">Account status</Link>
      </div>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "Product",
        name: "PropBetEdge UFC Pro",
        description: "Fight DNA, bettor-grade analysis and fight-week intelligence for UFC, with model-derived claims displayed only when validated.",
        brand: { "@type": "Brand", name: "PropBetEdge" },
        url: `${SITE.url}/pro`,
        offers: [
          { "@type": "Offer", price: "14.99", priceCurrency: "USD", availability: "https://schema.org/InStock", url: SITE.checkout.monthly, description: "Monthly UFC Pro founding access" },
          { "@type": "Offer", price: "5.99", priceCurrency: "USD", availability: "https://schema.org/InStock", url: SITE.checkout.cardPass, description: "Single card pass" },
        ],
      }} />
    </div>
  );
}
