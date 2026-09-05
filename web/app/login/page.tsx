import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "Sign in", description: "PropBetEdge UFC account access.", robots: { index: false, follow: true } };

export default function LoginPage() {
  return (
    <div className="wrap" style={{ padding: "96px 24px", maxWidth: 560 }}>
      <div className="card hi">
        <div className="eyebrow">Account</div>
        <h1 className="serif" style={{ fontSize: "var(--fs-h1)", margin: "10px 0 8px" }}>Sign in to PropBetEdge UFC</h1>
        <p className="dim" style={{ fontSize: "var(--fs-sm)" }}>
          UFC accounts open with the Pro launch. Access will be passwordless: enter your email, tap the magic link, and the same PropBetEdge identity carries across MLB, NFL and UFC.
        </p>
        <form style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }} aria-disabled="true">
          <label className="eyebrow dim" htmlFor="email">Email</label>
          <input id="email" type="email" placeholder="you@example.com" disabled className="mono" style={{ background: "var(--pbe-ink-4)", border: "1px solid var(--pbe-line-strong)", borderRadius: 6, padding: "10px 12px", color: "var(--pbe-paper)", opacity: .6 }} />
          <button type="button" className="btn gold" disabled style={{ opacity: .6, cursor: "not-allowed" }}>Magic link · not yet enabled</button>
        </form>
        <div className="faint" style={{ fontSize: "var(--fs-label)", marginTop: 16 }}>
          Already a PropBetEdge member on another product? <a href={SITE.network.nfl} style={{ color: "var(--pbe-gold)" }}>NFL account</a> · <a href={SITE.network.mlb} style={{ color: "var(--pbe-gold)" }}>MLB account</a>
        </div>
      </div>
      <div style={{ marginTop: 16, textAlign: "center" }}><Link href="/pro" className="dim" style={{ fontSize: "var(--fs-sm)" }}>What ships with Pro →</Link></div>
    </div>
  );
}
