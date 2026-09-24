import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { MobileNav } from "./MobileNav";
import { Logo, Mark } from "./Brand";
import { StoreCartButton } from "./store/StoreCartButton";
import { NAV, SITE } from "@/lib/site";
import { CURRENT_SPORT, NETWORK } from "@/lib/network";
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL } from "@/lib/pbe-membership.js";
import { UFC_OFFICIAL } from "@/lib/heritage";
import { getCurrentOrNextUfcEvent } from "@/lib/currentEvent";
import { getUfcAccess } from "@/lib/access";
import { MembershipBadge } from "./Membership";
import { eventSlug } from "@/lib/slug";
import { daysUntil, eventShortName, fmtDate } from "@/lib/format";

export async function Header() {
  const [next, access] = await Promise.all([getCurrentOrNextUfcEvent(), getUfcAccess()]);
  const d = next ? daysUntil(next.event_date) : null;
  const live = d != null && d <= 0 && d >= -1;
  /* Inside fight week the chip is a second door to /fight-week (the page that
   * owns the event title); outside it, a compact pointer to the next card. */
  const inWeek = d != null && d <= 6 && d >= -1;
  const nextLabel = live ? "Fight night" : inWeek ? "Fight week" : "Next card";
  const nextHref = next ? (inWeek ? "/fight-week" : `/events/${eventSlug(next)}`) : "/events";
  /* All Access first: the network umbrella is a first-class destination for
   * every reader who can still be sold it (FREE and UFC PRO ACTIVE). An All
   * Access member or the owner already carries the network in their badge. */
  const allAccessNav = NAV.find((n) => n.place === "network") ?? { href: ALL_ACCESS_URL, label: "All Access" };
  const showAllAccess = access.membership.show_purchase_cta || access.membership.show_all_access_upgrade;
  return (
    <header className="hdr">
      <input id="mnav-toggle" type="checkbox" aria-hidden="true" />
      <div className="wrap hdr-in hdr-wrap">
        <Logo />
        <NavLinks className="nav" />
        <div className="hdr-cta">
          {next && (
            <Link href={nextHref} className="hdr-next" title={`${nextLabel}: ${eventShortName(next.name)} — ${fmtDate(next.event_date)}`} aria-label={`${nextLabel}: ${eventShortName(next.name)}, ${fmtDate(next.event_date)}`}>
              <i className={`dot${live ? " live" : ""}`} aria-hidden="true" />
              <span className="hdr-next-copy">
                <b>{nextLabel}</b>
                <span className="hdr-next-date">{fmtDate(next.event_date, { month: "short", day: "numeric" })}</span>
              </span>
            </Link>
          )}
          <StoreCartButton />
          {showAllAccess && <a href={allAccessNav.href} className="btn hdr-aa" rel="noopener" data-ufc-all-access="nav" title={`PropBetEdge All Access · ${ALL_ACCESS_OFFER.price}`}>{allAccessNav.label}</a>}
          {/* Signed-in members see their shared membership badge (UFC PRO ACTIVE /
              ALL ACCESS ACTIVE / OWNER) as the account door; "Go Pro" is sold only
              to a reader the server says has nothing yet. */}
          {access.signedIn ? <MembershipBadge m={access.membership} href="/account" className="account-btn" title="Account" /> : <Link href="/login" className="btn account-btn">Sign in</Link>}
          {access.membership.show_purchase_cta && <Link href="/pro" className="btn gold">Go Pro</Link>}
          <label htmlFor="mnav-toggle" className="menu-btn" aria-label="Open menu"><span /><span /><span /></label>
        </div>
      </div>
      <MobileNav>
        {/* First-class in the drawer, above the primary routes and never inside More. */}
        {showAllAccess && <a href={allAccessNav.href} className="mnav-aa" rel="noopener" data-ufc-all-access="nav-mobile"><span>{allAccessNav.label}</span><small>PropBetEdge · {ALL_ACCESS_OFFER.price}</small></a>}
        <NavLinks className="" variant="mobile" />
        <div className="mnav-foot">
          <StoreCartButton mobile />
          {next && <Link href={nextHref} className="btn">{nextLabel} · {fmtDate(next.event_date, { month: "short", day: "numeric" })}</Link>}
          {access.signedIn ? <MembershipBadge m={access.membership} href="/account" title="Account" /> : <Link href="/login" className="btn">Sign in</Link>}
          {access.membership.show_purchase_cta && <Link href="/pro" className="btn gold">Go Pro</Link>}
        </div>
      </MobileNav>
    </header>
  );
}

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="ftr" aria-label="PropBetEdge network">
      <div className="wrap">
        <div className="ftr-grid">
          <div className="ftr-brand">
            <a href={SITE.parent} aria-label="PropBetEdge"><img src={SITE.logo.full400} alt="PropBetEdge" width={150} height={84} loading="lazy" decoding="async" /></a>
            <div className="ftr-kicker">The PropBetEdge Sports Network</div>
            <div className="brand" style={{ fontSize: 16 }}><Mark size={22} /><span className="brand-word">PropBet<em>Edge</em></span> <strong className="brand-tag">UFC</strong></div>
            <p className="brand-blurb" style={{ marginTop: 0 }}>
              <em>From raw signal to decision infrastructure.</em> Fight intelligence built from the data layer up: current cards, fighter identity, results, round evidence, history and a newsroom that only writes what its source packet can prove.
            </p>
          </div>
          <div className="col">
            <h4>PropBetEdge</h4>
            <a href={ALL_ACCESS_URL} className="ftr-aa-link" rel="noopener" data-ufc-footer-all-access="">All Access</a>
            <a href={ALL_ACCESS_URL} rel="noopener" data-ufc-footer-all-access-included="">What&apos;s included</a>
            <a href={NETWORK.news.href}>{NETWORK.news.label}</a>
            <Link href={NETWORK.store.href}>{NETWORK.store.label}</Link>
            <a href={SITE.billingPortal} target="_blank" rel="noopener noreferrer">Manage billing ↗</a>
            {NETWORK.discord && <a href={NETWORK.discord} target="_blank" rel="noopener">Discord ↗</a>}
          </div>
          <div className="col">
            <h4>Fight Intelligence</h4>
            <Link href="/events">Schedule &amp; results</Link>
            <Link href="/contender-series">Contender Series</Link>
            <Link href="/fighters">Fighters</Link>
            <Link href="/rankings">Rankings</Link>
            <Link href="/referees">Referees</Link>
            <Link href="/history">History</Link>
            <Link href="/hall-of-fame">Hall of Fame tribute</Link>
          </div>
          <div className="col">
            <h4>Editorial</h4>
            <Link href="/news">Newsroom</Link>
            <Link href="/#notable-voices">Notable voices</Link>
            <Link href="/about">Editorial policy</Link>
            <Link href="/methodology">Editorial &amp; Data Methodology</Link>
            <a href="/feed.xml">RSS feed</a>
            <Link href="/pro">UFC Pro</Link>
            <a href={`mailto:${SITE.contact}`}>Contact us</a>
          </div>
          <div className="col">
            <h4>Developers</h4>
            <a href={SITE.ufcApi} target="_blank" rel="noopener">UFC Intelligence API ↗</a>
            <a href={SITE.ufcApiDocs} target="_blank" rel="noopener">API Docs ↗</a>
            <p className="ftr-note">Build with events, fighters, round stats, Fight DNA and Matchup DNA.</p>
          </div>
          <div className="col">
            <h4>Official UFC</h4>
            <a href={UFC_OFFICIAL.home} target="_blank" rel="noopener">UFC.com ↗</a>
            <a href={UFC_OFFICIAL.athletes} target="_blank" rel="noopener">Official athletes ↗</a>
            <a href={UFC_OFFICIAL.rankings} target="_blank" rel="noopener">Official rankings ↗</a>
            <a href={UFC_OFFICIAL.hallOfFame} target="_blank" rel="noopener">UFC Hall of Fame ↗</a>
            <a href={UFC_OFFICIAL.fightPass} target="_blank" rel="noopener">UFC Fight Pass ↗</a>
            <a href={UFC_OFFICIAL.store} target="_blank" rel="noopener">Official UFC Store ↗</a>
          </div>
        </div>
        <nav className="net" aria-label="PropBetEdge sports">
          {NETWORK.sports.map((s) => s.key === CURRENT_SPORT
            ? <Link key={s.key} href={s.href} className="here"><b>{s.label}</b><span>{s.name}</span><small>{s.blurb}</small></Link>
            : <a key={s.key} href={s.href}><b>{s.label}</b><span>{s.name}</span><small>{s.blurb}</small></a>)}
        </nav>
        <p className="disclaimer">
          PropBetEdge is an independent sports intelligence product and is not affiliated with the UFC, Zuffa LLC, TKO Group, ESPN, Paramount, or any sportsbook. Links labeled Official UFC go directly to UFC-owned destinations so readers can verify the official record, watch licensed programming and shop official merchandise.
          Rights-cleared fighter media carries source/license provenance. Nothing on this site is betting advice. Model output is labelled MODEL; provider data is labelled LIVE; anything unavailable is labelled as such. Please gamble responsibly. 21+ where applicable.
        </p>
        <div className="ftr-rail">
          <div><strong style={{ color: "var(--pbe-paper)" }}>PropBetEdge</strong> · Independent sports intelligence built from the data layer up.</div>
          <div>© {year} {SITE.publisher} · <a href={SITE.parent}>propbetedge.ai</a></div>
        </div>
      </div>
    </footer>
  );
}
