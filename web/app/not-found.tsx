import type { Metadata } from "next";
import Link from "next/link";
import { Octagon } from "@/components/ui";

/* Rendered with a real 404 by the [slug]/layout.tsx existence gates. Its own
 * robots and title, so the layout's "index, follow" and home title are not
 * inherited alongside the noindex Next adds for a 404. */
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="wrap page" style={{ paddingTop: 96, paddingBottom: 96 }}>
      <div className="empty" style={{ textAlign: "left", padding: 48 }}>
        <Octagon className="oc" />
        <div className="eyebrow">404</div>
        <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "12px 0", position: "relative" }}>That page is not on the card.</h1>
        <p className="dim" style={{ maxWidth: "52ch", margin: 0, fontSize: 16 }}>
          The fighter, event, or story you are looking for is not in the archive yet, or the link has changed. Everything published is reachable from the sections below.
        </p>
        <div className="hero-actions">
          <Link href="/" className="btn gold">Home</Link>
          <Link href="/events" className="btn">Events</Link>
          <Link href="/fighters" className="btn">Fighters</Link>
          <Link href="/news" className="btn">News</Link>
        </div>
      </div>
    </div>
  );
}
