import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap" style={{ padding: "96px 24px" }}>
      <div className="eyebrow">404</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "12px 0" }}>That page is not on the card.</h1>
      <p className="dim" style={{ maxWidth: "52ch" }}>
        The fighter, event, or story you are looking for is not in the archive yet, or the link has changed. Everything published is reachable from the sections below.
      </p>
      <div className="hero-actions">
        <Link href="/" className="btn gold">Home</Link>
        <Link href="/events" className="btn">Events</Link>
        <Link href="/fighters" className="btn">Fighters</Link>
      </div>
    </div>
  );
}
