import Link from "next/link";
import { ALL_ACCESS_CHECKOUT_URL, LOCAL_ALL_ACCESS_PATH, PLATINUM_TRUTH, UFC_CAPABILITIES, designation, type AccountView } from "@/lib/accountSurface";
import { ALL_ACCESS_OFFER, MANAGE_URL, NETWORK, type Membership } from "@/lib/pbe-membership.js";
import family from "@/lib/family.json";

/* UFC premium account shell (network standard, NFL v3 benchmark). One
 * composition for /login, /account and /all-access: a story column with the
 * cage art and a panel that changes from "here is what you could get" to
 * "this is yours". Every state is the server verdict passed in; nothing here
 * decides access, and no protected value is rendered to fill a screen. */

export function Story({ view, eyebrow, title, copy, chips = ["FIGHT DNA · PBE DERIVED", "PICKS · PRE-FIGHT", "RECORD · PERMANENT"] }: { view: AccountView; eyebrow: string; title: React.ReactNode; copy: string; chips?: string[] }) {
  const member = view === "sport_pro" || view === "all_access" || view === "owner";
  return (
    <div className={`acs-story is-${member ? "member" : view === "check" ? "check" : "prospect"}${view === "all_access" ? " is-platinum" : ""}`} >
      <img className="acs-logo" src="https://propbetedge.ai/logo/pbe-full-400.png" alt="" width={118} height={30} decoding="async" />
      <ul className="acs-chips" aria-hidden="true">
        {chips.map((c) => <li key={c}><i />{c}</li>)}
        {member && <li className="is-on"><i />UNLOCKED</li>}
      </ul>
      <div className="acs-story-copy">
        <span className="acs-eyebrow">{eyebrow}</span>
        <h1 className="acs-title">{title}</h1>
        <p>{copy}</p>
      </div>
    </div>
  );
}

export function CapabilityGrid({ unlocked, title }: { unlocked: boolean; title: string }) {
  return (
    <section className={`acs-caps${unlocked ? " is-unlocked" : ""}`} aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {UFC_CAPABILITIES.map((c) => (
          <li key={c.key}>
            {unlocked
              ? <Link href={c.href}><i aria-hidden="true" /><b>{c.label}</b><span>{c.sub}</span></Link>
              : <div><i aria-hidden="true" /><b>{c.label}</b><span>{c.sub}</span></div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function VerifiedCard({ m, email, period }: { m: Membership; email: string | null; period: string | null }) {
  const d = designation(m.state);
  if (!d) return null;
  return (
    <section className={`acs-verified is-${d.tone}`} aria-label="Verified account">
      <div className="acs-verified-top"><span>Verified account</span><b className={`acs-badge is-${d.tone}`}>{d.badge}</b></div>
      {email && <div className="acs-email">{email}</div>}
      <div className="acs-verified-meta">
        <span>{d.tone === "owner" ? "Owner access · no subscription required" : d.status}</span>
        {d.truth && d.tone !== "owner" && <span>{d.truth}</span>}
        {period && <span>{period}</span>}
      </div>
    </section>
  );
}

export function SignOut({ className = "acs-btn" }: { className?: string }) {
  return <form action="/api/auth/logout" method="post" className="acs-signout"><button type="submit" className={className}>Sign out</button></form>;
}

/** Member actions: go INTO the product; manage only when there is a subscription; refresh re-asks the server. */
export function MemberActions({ m, refreshHref, primary = { href: "/fight-week", label: "Open Fight Intelligence →" }, signOut = true }: { m: Membership; refreshHref: string; primary?: { href: string; label: string }; signOut?: boolean }) {
  return (
    <div className="acs-actions">
      <Link href={primary.href} className="acs-cta">{primary.label}</Link>
      {m.show_manage && <a className="acs-btn" href={MANAGE_URL} target="_blank" rel="noopener noreferrer">Manage membership ↗</a>}
      <Link href={refreshHref} className="acs-btn" prefetch={false}>Refresh verified access</Link>
      {signOut && <SignOut />}
    </div>
  );
}

/** The access-check state: identity kept, nothing sold, nothing assumed lost. */
export function AccessCheckPanel({ email, retryHref }: { email: string | null; retryHref: string }) {
  return (
    <div className="acs-panel-body">
      <div className="acs-identity is-check"><i />SIGNED IN{email ? <b>{email}</b> : null}</div>
      <span className="acs-eyebrow">UFC · ACCESS CHECK</span>
      <h2 className="acs-head">Access check temporarily unavailable.</h2>
      <p className="acs-lede">We can see your account, but membership verification did not answer. Nothing about your membership has changed, and every public page keeps working.</p>
      <div className="acs-protect"><b>Your account is not being treated as unsubscribed.</b> Pricing and upgrade prompts stay hidden until verification answers cleanly.</div>
      <div className="acs-actions">
        <Link href={retryHref} className="acs-cta" prefetch={false}>Retry verified access</Link>
        <SignOut />
      </div>
    </div>
  );
}

/** Platinum / owner network launcher: every product OPEN, the current one marked. */
export function NetworkLauncher({ current = "ufc", owner = false }: { current?: string; owner?: boolean }) {
  const predictions = (family as { products?: Array<{ key: string; name?: string; label?: string; url: string; blurb?: string }> }).products?.find((p) => p.key === "predictions");
  return (
    <section className="acs-network" aria-label="PropBetEdge network">
      <h2>{owner ? "The full network · unlocked" : "Your network · unlocked"}</h2>
      <ul>
        {NETWORK.map((s) => (
          <li key={s.key}>
            {s.key === current
              ? <span className="is-here" aria-current="page"><b>{s.key === "f1" ? "F1 Intelligence" : s.label}</b><em>YOU ARE HERE</em></span>
              : <a href={s.url} rel="noopener"><b>{s.key === "f1" ? "F1 Intelligence" : s.label}</b><em>OPEN →</em></a>}
          </li>
        ))}
      </ul>
      {predictions && (
        <a className="acs-predictions" href={predictions.url} rel="noopener">
          <span>INTELLIGENCE</span><b>◆ {predictions.name || "PropBetEdge Predictions"}</b><em>OPEN →</em>
        </a>
      )}
    </section>
  );
}

/** Small secondary network expansion for UFC Pro members (never the primary pitch). */
export function NetworkExpansion() {
  return (
    <aside className="acs-expand" aria-label="Expand to the PropBetEdge network">
      <div><span>NETWORK EXPANSION</span><b>Add the other 9 sports + PropBetEdge Predictions</b><small>{ALL_ACCESS_OFFER.price} · Platinum members get {PLATINUM_TRUTH.replace("PropBetEdge All Access · ", "")}</small></div>
      <Link href={LOCAL_ALL_ACCESS_PATH} className="acs-btn">See All Access →</Link>
    </aside>
  );
}

export { ALL_ACCESS_CHECKOUT_URL };
