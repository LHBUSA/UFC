import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/lib/site";
import { Mark } from "@/components/Brand";

export const metadata: Metadata = { title: "Sign in", description: "PropBetEdge UFC account access.", robots: { index: false, follow: true } };

export default function LoginPage() {
  return (
    <div className="wrap page" style={{ maxWidth: 560, paddingTop: 96 }}>
      <div className="card hi">
        <Mark size={36} />
        <div className="eyebrow mt-4">Account</div>
        <h1 className="serif" style={{ fontSize: "var(--fs-h1)", margin: "10px 0 8px" }}>Sign in to PropBetEdge UFC</h1>
        <p className="dim sm">
          UFC accounts open with the Pro launch. Access will be passwordless: enter your email, tap the magic link, and the same PropBetEdge identity carries across MLB, NFL and UFC.
        </p>
        <form className="stack mt-5" style={{ gap: 10 }} aria-disabled="true">
          <label className="eyebrow dim" htmlFor="email">Email</label>
          <input id="email" type="email" placeholder="you@example.com" disabled className="mono" style={{ background: "var(--pbe-ink-4)", border: "1px solid var(--pbe-line-strong)", borderRadius: 6, padding: "11px 14px", color: "var(--pbe-paper)", opacity: .6 }} />
          <button type="button" className="btn gold" disabled style={{ opacity: .6, cursor: "not-allowed" }}>Magic link · not yet enabled</button>
        </form>
        <div className="faint label mt-4">
          Already a PropBetEdge member on another product? <a href={SITE.network.nfl} className="gold">NFL account</a> · <a href={SITE.network.mlb} className="gold">MLB account</a>
        </div>
      </div>
      <div className="mt-4" style={{ textAlign: "center" }}><Link href="/pro" className="dim sm">What ships with Pro →</Link></div>
    </div>
  );
}
