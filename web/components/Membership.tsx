import Link from "next/link";
import { ALL_ACCESS_OFFER, MANAGE_URL, NETWORK, STATES, membershipLabel, type Membership } from "@/lib/pbe-membership.js";
import { LOCAL_ALL_ACCESS_PATH, badgeLabel } from "@/lib/accountSurface";
import { ALL_ACCESS_ACTIVE_LINE, ALL_ACCESS_DIVIDER, ALL_ACCESS_FUTURE_LINE, ALL_ACCESS_SPORTS_LINE, ALL_ACCESS_VALUE_LINE, allAccessHeroModel, promoParts } from "@/lib/allAccessHero";

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
  /* Presentation designation (◆ PLATINUM for all_access); the contract state is untouched. */
  const label = badgeLabel(state) ?? membershipLabel(state, m?.sport || "ufc");
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
      <p className="pbe-mbr-aa-copy">{ALL_ACCESS_VALUE_LINE} {ALL_ACCESS_SPORTS_LINE} · PropBetEdge Predictions. {ALL_ACCESS_FUTURE_LINE}</p>
      <p className="pbe-mbr-aa-promo">Launch offer: {ALL_ACCESS_OFFER.promoLine}</p>
      <div className="pbe-mbr-aa-actions">
        <a className="pbe-mbr-aa-cta" href={ALL_ACCESS_OFFER.checkoutUrl} rel="noopener" data-pbe-placement="all_access_checkout">Get All Access →</a>
        <Link className="pbe-mbr-aa-learn" href={LOCAL_ALL_ACCESS_PATH}>What&apos;s included</Link>
      </div>
    </aside>
  );
}

/* ---- All Access first ------------------------------------------------------
 * The network umbrella is the PRIMARY offer on every purchase surface; UFC Pro
 * is the single-sport alternative beneath the "ONLY WANT UFC?" seam. What the
 * hero says per state is decided in lib/allAccessHero.ts; this only lays it
 * out. Never renders for ALL ACCESS ACTIVE or OWNER (nothing to sell). */

export type AllAccessHeroVariant = "surface" | "home" | "panel";

/** The All Access hero: FREE readers get ALL ACCESS, UFC Pro members get UPGRADE TO ALL ACCESS. */
export function AllAccessHero({ m, variant = "surface", email = null }: { m: Membership | null | undefined; variant?: AllAccessHeroVariant; email?: string | null }) {
  const model = allAccessHeroModel(m);
  if (!model) return null;
  const promo = promoParts(model);
  /* Prefilling the checkout with the signed-in email keeps the All Access grant
   * on the account the reader is using; a signed-out reader gets the bare link. */
  const checkout = email ? `${model.checkoutUrl}?prefilled_email=${encodeURIComponent(email)}` : model.checkoutUrl;
  return (
    <aside
      className={`ufc-aa-hero is-${variant}${model.upgrade ? " is-upgrade" : ""}`}
      aria-label="PropBetEdge All Access"
      data-ufc-all-access="hero"
      data-ufc-all-access-state={model.state}
    >
      <div className="ufc-aa-top">
        <span className="ufc-aa-eyebrow">{model.eyebrow}</span>
        <span className="ufc-aa-badge">{model.badge}</span>
      </div>
      <div className="ufc-aa-title-row">
        <h3 className="ufc-aa-title">{model.title}</h3>
        <span className="ufc-aa-price" aria-label={model.price}><strong>{model.amount}</strong>/{model.cadence}</span>
      </div>
      <p className="ufc-aa-value">{model.valueLine}</p>
      <p className="ufc-aa-secondary">{model.secondary}</p>
      <div className="ufc-aa-includes">
        <div className="ufc-aa-group" data-ufc-all-access-group="sports">
          <span className="ufc-aa-group-k">Sports · {model.sportCount}</span>
          <ul className="ufc-aa-sports" aria-label={model.sportsLine}>
            {model.sports.map((s) => <li key={s.key} className={s.owned ? "is-owned" : undefined} data-sport={s.key}>{s.label}{s.owned && <small> · yours</small>}</li>)}
          </ul>
        </div>
        <div className="ufc-aa-group ufc-aa-intel" data-ufc-all-access-group="intelligence">
          <span className="ufc-aa-group-k">Intelligence</span>
          <a className="ufc-aa-predictions" href={model.predictions.url} rel="noopener" data-product={model.predictions.key}>
            <b><i aria-hidden="true">◆</i>{model.predictions.name}</b>
            <span>{model.predictions.blurb}</span>
          </a>
        </div>
      </div>
      <ul className="ufc-aa-caps" aria-label="What the network includes">
        {model.capabilities.map((c) => <li key={c.key}><b>{c.name}</b><span>{c.note}</span></li>)}
      </ul>
      <p className="ufc-aa-fine">{model.capabilitiesNote} {model.futureLine}</p>
      <p className="ufc-aa-promo">Launch offer: {promo.before}<b className="ufc-aa-code">{promo.code}</b>{promo.after}</p>
      <div className="ufc-aa-actions">
        <a className="ufc-aa-cta" href={checkout} rel="noopener" data-pbe-placement="all_access_checkout" data-ufc-all-access-cta="checkout">{model.ctaLabel}</a>
        <Link className="ufc-aa-learn" href={model.learnUrl} data-ufc-all-access-cta="learn">{model.learnLabel}</Link>
      </div>
    </aside>
  );
}

/** The seam between the umbrella and the single-sport alternative. */
export function AllAccessDivider({ label = ALL_ACCESS_DIVIDER }: { label?: string }) {
  return <div className="ufc-aa-divider" role="separator" aria-label={label} data-ufc-all-access="divider"><span>{label}</span></div>;
}

/** One-line gold entry for compact chrome (locked-module previews, rails). */
export function AllAccessMini({ m = null, className = "" }: { m?: Membership | null | undefined; className?: string }) {
  const model = allAccessHeroModel(m);
  if (!model) return null;
  return (
    <a className={`ufc-aa-mini${className ? ` ${className}` : ""}`} href={model.checkoutUrl} rel="noopener" data-pbe-placement="all_access_checkout" data-ufc-all-access="mini">
      <span>{model.title}</span><b>{model.price}</b><i>{model.miniLine}</i>
    </a>
  );
}

/** What an ALL ACCESS ACTIVE account already has: navigation, never an upsell. */
export function AllAccessActive({ m }: { m: Membership | null | undefined }) {
  if (stateOf(m) !== "all_access") return null;
  return <p className="ufc-aa-active" data-ufc-all-access="active"><b>◆ PLATINUM MEMBER</b><span>PropBetEdge All Access · active · {ALL_ACCESS_ACTIVE_LINE}</span></p>;
}

/** Restrained network row: every PropBetEdge sport, the current one marked. */
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
  return <Link className="pbe-mbr-network-link" href={LOCAL_ALL_ACCESS_PATH}>{stateOf(m) === "all_access" ? "Your network" : "PropBetEdge All Access"}</Link>;
}
