"use client";
import Link from "next/link";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="wrap" style={{ padding: "96px 24px" }}>
      <div className="eyebrow">Something broke</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-h1)", margin: "12px 0" }}>This page could not render.</h1>
      <p className="dim" style={{ maxWidth: "52ch" }}>The data layer is designed to fail empty, not blank, so this is unexpected. Try again, or head back to the card.</p>
      <div className="hero-actions">
        <button type="button" className="btn gold" onClick={() => reset()}>Try again</button>
        <Link href="/" className="btn">Home</Link>
      </div>
    </div>
  );
}
