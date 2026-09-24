import Link from "next/link";
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL, MANAGE_URL, NETWORK, STATES, membershipLabel, type Membership } from "@/lib/pbe-membership.js";

/* React renderings of the shared PropBetEdge membership contract
 * (lib/pbe-membership.js). Same class hooks and copy as the contract's own
 * membershipBadgeHtml / manageLinkHtml / allAccessCardHtml / networkLinksHtml,
 * so every sport frontend looks like one network. The membership object is
 * always the server-derived one: nothing here decides or widens access. */

function stateOf(m: Membership | null | undefined): Membership["state"] {
  return m && STATES.includes(m.state) ? m.state : "free";
}

/** The membership badge. Renders as a link when `href` is given (header). */
export function MembershipBadge({ m, href, className = "", title }: { m: Membership | null | undefined; href?: string; className?: string; title?: string }) {
  const state = stateOf(m);
  const cls = `pbe-mbr-badge is-${state}${className ? ` ${className}` : ""}`;
  const label = membershipLabel(state, m?.sport || "ufc");
  if (href) return <Link href={href} className={cls} data-pbe-membership={state} title={title}>{label}</Link>;
  return <span className={cls} data-pbe-membership={state} title={title}>{label}</span>;
}

/** Manage-subscription link: only while the member has a subscription to manage. */
export function ManageLink({ m, label = "Manage subscription", className = "pbe-mbr-manage" }: { m: Membership | null | undefined; label?: string; className?: string }) {
  if (!m?.show_manage) return null;
  return <a className={className} href={MANAGE_URL} target="_blank" rel="noopener noreferrer">{label} ↗</a>;
}

/** The All Access card for FREE and SPORT_PRO readers; never for ALL_ACCESS or OWNER. */
export function AllAccessCard({ m, compact = false }: { m: Membership | null | undefined; compact?: boolean }) {
  const state = stateOf(m);
  if (state === "all_access" || state === "owner") return null;
  const heading = state === "sport_pro" ? "Upgrade to All Access" : "All Access";
  return (
    <aside className={`pbe-mbr-aa${compact ? " is-compact" : ""}`} aria-label="PropBetEdge All Access">
      <div className="pbe-mbr-aa-head"><span className="pbe-mbr-aa-eyebrow">PropBetEdge Network</span><span className="pbe-mbr-aa-price">{ALL_ACCESS_OFFER.price}</span></div>
      <h3 className="pbe-mbr-aa-title">{heading}</h3>
      <p className="pbe-mbr-aa-copy">{ALL_ACCESS_OFFER.tagline} MLB · NFL · NBA · NHL · WNBA · UFC, plus every sport added next.</p>
      <p className="pbe-mbr-aa-promo">Launch offer: {ALL_ACCESS_OFFER.promoLine}</p>
      <div className="pbe-mbr-aa-actions">
        <a className="pbe-mbr-aa-cta" href={ALL_ACCESS_OFFER.checkoutUrl} rel="noopener" data-pbe-placement="all_access_checkout">Get All Access →</a>
        <a className="pbe-mbr-aa-learn" href={ALL_ACCESS_URL} rel="noopener">What&apos;s included</a>
      </div>
    </aside>
  );
}

/** Restrained network row: the six sports, the current one marked. */
export function NetworkRow({ current = "ufc" }: { current?: string }) {
  return (
    <nav className="pbe-mbr-network" aria-label="PropBetEdge network">
      {NETWORK.map((s) => s.key === current
        ? <a key={s.key} href={s.url} aria-current="page" className="is-current">{s.label}</a>
        : <a key={s.key} href={s.url} rel="noopener">{s.label}</a>)}
    </nav>
  );
}

/** The one All Access / network link every account panel carries. */
export function NetworkLink({ m }: { m: Membership | null | undefined }) {
  return <a className="pbe-mbr-network-link" href={ALL_ACCESS_URL} rel="noopener">{stateOf(m) === "all_access" ? "Your network" : "PropBetEdge All Access"}</a>;
}
