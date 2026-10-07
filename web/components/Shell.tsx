import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { MobileNav } from "./MobileNav";
import { Logo, Mark } from "./Brand";
import { StoreCartButton } from "./store/StoreCartButton";
import { SITE } from "@/lib/site";
import { CURRENT_SPORT, NETWORK, NETWORK_PRODUCTS } from "@/lib/network";
import { LOCAL_ALL_ACCESS_PATH, memberHref } from "@/lib/accountSurface";
import { UFC_OFFICIAL } from "@/lib/heritage";
import { getCurrentOrNextUfcEvent } from "@/lib/currentEvent";
import { getUfcAccess } from "@/lib/access";
import { MembershipBadge } from "./Membership";
import { PreferredSource } from "./PreferredSource";
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
  /* All Access is sold on /pro, the account page, the purchase surfaces and the
   * footer. The header bar carries only the routes, the next-card chip, the
   * cart, the membership badge and Go Pro, so it stays readable. */
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
          {/* Signed-in members see their shared membership badge (UFC PRO ACTIVE /
              ALL ACCESS ACTIVE / OWNER) as the account door; "Go Pro" is sold only
              to a reader the server says has nothing yet. */}
          {access.signedIn ? <MembershipBadge m={access.membership} href={memberHref(access.membership.state, access.source)} className="account-btn" title="Account" /> : <Link href="/login" className="btn account-btn">Sign in</Link>}
          {access.membership.show_purchase_cta && <Link href="/pro" className="btn gold">Go Pro</Link>}
          <label htmlFor="mnav-toggle" className="menu-btn" aria-label="Open menu"><span /><span /><span /></label>
        </div>
      </div>
      <MobileNav>
        <NavLinks className="" variant="mobile" />
        <div className="mnav-foot">
          <StoreCartButton mobile />
          {next && <Link href={nextHref} className="btn">{nextLabel} · {fmtDate(next.event_date, { month: "short", day: "numeric" })}</Link>}
          {access.signedIn ? <MembershipBadge m={access.membership} href={memberHref(access.membership.state, access.source)} title="Account" /> : <Link href="/login" className="btn">Sign in</Link>}
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
          {/* Directory: UFC's own areas first, then the PropBetEdge network groups.
              Every link sits under the heading that names what it is (pinned by
              lib/footerGroups.test.ts): no billing or social link trails the
              trust/legal group, and the Preferred Source band stays below. */}
          <div className="ftr-dir">
            <div className="col" data-ufc-footer-group="fight-intelligence">
              <h4>Fight Intelligence</h4>
              <Link href="/events">Schedule &amp; results</Link>
              <Link href="/contender-series">Contender Series</Link>
              <Link href="/fighters">Fighters</Link>
              <Link href="/rankings">Rankings</Link>
              <Link href="/referees">Referees</Link>
              <Link href="/history">History</Link>
              <Link href="/hall-of-fame">Hall of Fame tribute</Link>
            </div>
            <div className="col" data-ufc-footer-group="editorial">
              <h4>Editorial</h4>
              <Link href="/news">Newsroom</Link>
              <Link href="/#notable-voices">Notable voices</Link>
              <Link href="/about">Editorial policy</Link>
              <Link href="/methodology">Editorial &amp; Data Methodology</Link>
              <a href="/feed.xml">RSS feed</a>
              <a href={`mailto:${SITE.contact}`}>Contact us</a>
            </div>
            <div className="col" data-ufc-footer-group="developers">
              <h4>Developers</h4>
              <a href={SITE.ufcApi} target="_blank" rel="noopener">UFC Intelligence API ↗</a>
              <a href={SITE.ufcApiDocs} target="_blank" rel="noopener">API Docs ↗</a>
              <p className="ftr-note">Build with events, fighters, round stats, Fight DNA and Matchup DNA.</p>
            </div>
            <div className="col" data-ufc-footer-group="official-ufc">
              <h4>Official UFC</h4>
              <a href={UFC_OFFICIAL.home} target="_blank" rel="noopener">UFC.com ↗</a>
              <a href={UFC_OFFICIAL.athletes} target="_blank" rel="noopener">Official athletes ↗</a>
              <a href={UFC_OFFICIAL.rankings} target="_blank" rel="noopener">Official rankings ↗</a>
              <a href={UFC_OFFICIAL.hallOfFame} target="_blank" rel="noopener">UFC Hall of Fame ↗</a>
              <a href={UFC_OFFICIAL.fightPass} target="_blank" rel="noopener">UFC Fight Pass ↗</a>
              <a href={UFC_OFFICIAL.store} target="_blank" rel="noopener">Official UFC Store ↗</a>
            </div>
            <div className="col" data-ufc-footer-group="propbetedge">
              <h4>PropBetEdge</h4>
              <Link href={LOCAL_ALL_ACCESS_PATH} className="ftr-aa-link" data-ufc-footer-all-access="">All Access</Link>
              <Link href={LOCAL_ALL_ACCESS_PATH} data-ufc-footer-all-access-included="">What&apos;s included</Link>
              <a href={NETWORK.news.href}>{NETWORK.news.label}</a>
              <a href={NETWORK.learn.href}>{NETWORK.learn.label}</a>
              <Link href={NETWORK.store.href}>{NETWORK.store.label}</Link>
            </div>
            <div className="col" data-ufc-footer-group="account">
              <h4>Account</h4>
              <Link href="/account">Your account</Link>
              <Link href="/pro">UFC Pro</Link>
              <a href={SITE.billingPortal} target="_blank" rel="noopener noreferrer">Manage billing ↗</a>
              <a href="https://propbetedge.ai/support">Support</a>
            </div>
            <div className="col" data-ufc-footer-group="community">
              <h4>Community</h4>
              <a href={SITE.xUrl} target="_blank" rel="noopener noreferrer" aria-label={`Follow PropBetEdge on X (${SITE.twitter})`} title="Follow PropBetEdge on X"><span aria-hidden="true">𝕏</span> {SITE.twitter}</a>
            </div>
            <div className="col" data-ufc-footer-group="company-legal">
              <h4>Company &amp; Legal</h4>
              <a href="https://propbetedge.ai/about">About PropBetEdge</a>
              <a href="https://propbetedge.ai/privacy">Privacy</a>
              <a href="https://propbetedge.ai/terms">Terms</a>
              <a href="https://propbetedge.ai/legal">Legal</a>
            </div>
          </div>
        </div>
        <PreferredSource surface="footer" />
        {/* The PropBetEdge network directory: 10 sports from the registry, then
            the non-sport products in their own row (never counted as a sport). */}
        <section className="net-sec" aria-labelledby="net-sec-title">
          <div className="net-head">
            <span className="net-head-k">PropBetEdge Network</span>
            <h2 id="net-sec-title">Explore the intelligence network</h2>
            <p>{NETWORK.sports.length} sports + PropBetEdge Predictions.</p>
          </div>
          <nav className="net" aria-label="PropBetEdge sports">
            {NETWORK.sports.map((s) => s.key === CURRENT_SPORT
              ? <Link key={s.key} href={s.href} className="here"><b>{s.label}</b><span>{s.name}</span><small>{s.blurb}</small><em className="net-here">Here</em></Link>
              : <a key={s.key} href={s.href}><b>{s.label}</b><span>{s.name}</span><small>{s.blurb}</small></a>)}
          </nav>
          <nav className="net-intel" aria-label="PropBetEdge All Access">
            <a href="https://propbetedge.ai/pro"><span className="net-intel-k">All Access</span><span className="net-intel-name">PropBetEdge All Access</span><small>One membership. The premium PropBetEdge network.</small><em className="net-intel-tag">All Access</em><i aria-hidden="true">→</i></a>
            {NETWORK_PRODUCTS.map((p) => <a key={p.key} href={p.href}><span className="net-intel-k">All Access</span><span className="net-intel-name">{p.label}</span><small>{p.blurb}</small><em className="net-intel-tag">Included</em><i aria-hidden="true">→</i></a>)}
          </nav>
        </section>
        <div className="disclaimer">
          <p>PropBetEdge is an independent sports intelligence product and is not affiliated with the UFC, Zuffa LLC, TKO Group, ESPN, Paramount, or any sportsbook. Links labeled Official UFC go directly to UFC-owned destinations so readers can verify the official record, watch licensed programming and shop official merchandise.{/* source-brand:allow (legal non-affiliation disclaimer) */}</p>
          <p>Rights-cleared fighter media carries source/license provenance. Nothing on this site is betting advice. Model output is labelled MODEL; provider data is labelled LIVE; anything unavailable is labelled as such. Please gamble responsibly. 21+ where applicable.</p>
        </div>
        <div className="ftr-rail">
          <div><strong style={{ color: "var(--pbe-paper)" }}>PropBetEdge</strong> · Independent sports intelligence built from the data layer up.</div>
          <div>© {year} {SITE.publisher} · <a href={SITE.parent}>propbetedge.ai</a></div>
        </div>
      </div>
    </footer>
  );
}
