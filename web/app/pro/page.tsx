import type { Metadata } from "next";
import Link from "next/link";
import { ProPlans, PageHead, JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "UFC Pro — Picks, Edges & Card-Change Alerts", description: "PropBetEdge UFC Pro: model picks for winner, method and rounds, card-change alerts, judge and referee intel, weigh-in reports and a track record graded on closing-line value.", alternates: { canonical: "/pro" } };

export default function ProPage() {
  return (
    <div className="wrap page">
      <PageHead crumbs={[{ name: "Pro" }]} eyebrow="UFC Pro" title="The card, priced. The changes, first."
        lede="Pro is the paid layer on top of the free archive. It ships when the model has a graded, out-of-time track record to show you, not before. Until then every Pro surface on this site renders as a locked placeholder, and no pick, edge or probability is displayed that the model did not produce." />
      <ProPlans />
      <div className="grid-3 mt-6">
        {[
          ["Calibration over hit rate", "A 55% hit rate on favourites means nothing. Pro publishes calibration and closing-line value on every pick, the two numbers that predict whether an edge is real."],
          ["Card changes are the edge", "Late replacements, weight misses and medical suspensions move lines and are announced nowhere officially. Pro members get the alert with the replacement's stats attached."],
          ["Round stats, not narratives", "Every fight in the archive carries round-by-round striking and grappling. The model is built from that, with as-of features that cannot leak the future."],
        ].map(([h, p]) => (
          <div key={h} className="card"><h3 className="serif" style={{ marginBottom: 8, fontSize: 20 }}>{h}</h3><p className="dim sm">{p}</p></div>
        ))}
      </div>
      <div className="card hi mt-6 between">
        <div>
          <div className="eyebrow">Launch</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>Accounts and billing open with the Pro launch.</div>
          <div className="faint sm">Passwordless sign-in and Stripe billing, the same account layer as PropBetEdge NFL.</div>
        </div>
        <Link href="/login" className="btn gold">Sign-in status</Link>
      </div>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "Product", name: "PropBetEdge UFC Pro", description: "Model picks, card-change alerts, judge and referee intelligence and weigh-in reports for UFC cards.", brand: { "@type": "Brand", name: "PropBetEdge" }, url: `${SITE.url}/pro`,
        offers: [{ "@type": "Offer", price: "14.99", priceCurrency: "USD", availability: "https://schema.org/PreOrder", url: `${SITE.url}/pro`, description: "Monthly" }, { "@type": "Offer", price: "5.99", priceCurrency: "USD", availability: "https://schema.org/PreOrder", url: `${SITE.url}/pro`, description: "Single card pass" }] }} />
    </div>
  );
}
