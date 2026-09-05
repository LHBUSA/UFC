import type { Metadata } from "next";
import Link from "next/link";
import { ProPlans } from "@/components/ui";

export const metadata: Metadata = { title: "UFC Pro — Picks, Edges & Card-Change Alerts", description: "PropBetEdge UFC Pro: model picks for winner, method and rounds, card-change alerts, judge and referee intel, weigh-in reports and a track record graded on closing-line value.", alternates: { canonical: "/pro" } };

export default function ProPage() {
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow">UFC Pro</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 8px", maxWidth: "22ch" }}>The card, priced. The changes, first.</h1>
      <p className="dim" style={{ maxWidth: "62ch", marginBottom: 32, fontSize: 17 }}>
        Pro is the paid layer on top of the free archive. It ships when the model has a graded, out-of-time track record to show you, not before.
        Until then every Pro surface on this site renders as a locked placeholder, and no pick, edge or probability is displayed that the model did not produce.
      </p>
      <ProPlans />
      <div className="grid-3" style={{ marginTop: 32 }}>
        {[
          ["Calibration over hit rate", "A 55% hit rate on favourites means nothing. Pro publishes calibration and closing-line value on every pick, the two numbers that predict whether an edge is real."],
          ["Card changes are the edge", "Late replacements, weight misses and medical suspensions move lines and are announced nowhere officially. Pro members get the alert with the replacement's stats attached."],
          ["Round stats, not narratives", "Every fight in the archive carries round-by-round striking and grappling. The model is built from that, with as-of features that cannot leak the future."],
        ].map(([h, p]) => (
          <div key={h} className="card"><h3 style={{ fontFamily: "var(--pbe-font-display)", marginBottom: 8 }}>{h}</h3><p className="dim" style={{ fontSize: "var(--fs-sm)" }}>{p}</p></div>
        ))}
      </div>
      <div className="card hi" style={{ marginTop: 32, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">Launch</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>Accounts and billing open with the Pro launch.</div>
          <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Passwordless sign-in and Stripe billing, the same account layer as PropBetEdge NFL.</div>
        </div>
        <Link href="/login" className="btn gold">Sign-in status</Link>
      </div>
    </div>
  );
}
