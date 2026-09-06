import type { Metadata } from "next";
import Link from "next/link";
import { ProPlans, PageHead, JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";
import { getCurrentAccount, hasProAccess } from "@/lib/auth";

export const metadata: Metadata = {
  title: "UFC Pro — Fight DNA & Fight-Week Intelligence",
  description: "PropBetEdge UFC Pro founding access: Fight DNA, bettor-grade UFC analysis and fight-week intelligence, with model pricing and picks held back until validated.",
  alternates: { canonical: "/pro" },
};

export default async function ProPage() {
  const account = await getCurrentAccount();
  const active = hasProAccess(account);
  const owner = Boolean(account?.unlimited || account?.role === "owner" || account?.plan === "owner");

  return (
    <div className="wrap page">
      <PageHead
        crumbs={[{ name: "Pro" }]}
        eyebrow="UFC Pro"
        title="Fight intelligence first. Model claims only when earned."
        lede="UFC Pro founding access is built around Fight DNA, bettor-grade analysis and fight-week intelligence. Model prices, picks and probabilities remain unavailable until PropBetEdge has a graded out-of-time track record to support them."
      />

      {active ? (
        <section className="card hi pro-access-active">
          <div className="between" style={{ gap: 18, alignItems: "flex-start" }}>
            <div>
              <div className="eyebrow">{owner ? "Owner access" : "UFC Pro"}</div>
              <h2 className="serif" style={{ margin: "7px 0 8px" }}>{owner ? "Unlimited UFC access is active." : "Your UFC Pro access is active."}</h2>
              <p className="dim sm" style={{ maxWidth: 720 }}>
                {owner ? "No usage cap. No expiry. No checkout required." : "Your server-side entitlement is active for this account."} Fight DNA and every released Pro surface are available to your account; features that do not yet have verified source/model output remain truthfully unavailable rather than being fabricated.
              </p>
            </div>
            <span className="account-plan owner">{owner ? "OWNER · UNLIMITED" : "UFC PRO · ACTIVE"}</span>
          </div>
          <div className="row mt-4">
            <Link href="/account" className="btn gold">Account &amp; access</Link>
            <Link href="/events" className="btn">Open fight cards</Link>
            <Link href="/fighters" className="btn">Explore Fight DNA</Link>
          </div>
        </section>
      ) : <ProPlans />}

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
          <div className="eyebrow">Access status</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>{active ? (owner ? "Owner entitlement: unlimited." : "UFC Pro entitlement: active.") : "Stripe checkout is live."}</div>
          <div className="faint sm">{active ? "Access is controlled server-side by your UFC account entitlement." : "Monthly UFC Pro is $14.99. A one-card pass is $5.99."} Model-only surfaces still require actual validated model output regardless of plan.</div>
        </div>
        <Link href={account ? "/account" : "/login?next=/pro"} className="btn">{account ? "Account status" : "Sign in"}</Link>
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
