import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { MobileNav } from "./MobileNav";
import { Logo, Mark } from "./Brand";
import { StoreCartButton } from "./store/StoreCartButton";
import { SITE } from "@/lib/site";
import { UFC_OFFICIAL } from "@/lib/heritage";
import { getNextEvent } from "@/lib/db";
import { getCurrentAccount } from "@/lib/auth";
import { eventSlug } from "@/lib/slug";
import { daysUntil, eventShortName, fmtDate } from "@/lib/format";

export async function Header() {
  const [next, account] = await Promise.all([getNextEvent(), getCurrentAccount()]);
  const d = next ? daysUntil(next.event_date) : null;
  const live = d != null && d <= 0 && d >= -1;
  /* Inside fight week the chip is a second door to /fight-week (the page that
   * owns the event title); outside it, a compact pointer to the next card. */
  const inWeek = d != null && d <= 6 && d >= -1;
  const nextLabel = live ? "Fight night" : inWeek ? "Fight week" : "Next card";
  const nextHref = next ? (inWeek ? "/fight-week" : `/events/${eventSlug(next)}`) : "/events";
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
          {account ? <Link href="/account" className="btn account-btn">{account.unlimited ? "Owner" : account.plan === "pro" ? "Pro" : "Account"}</Link> : <Link href="/login" className="btn account-btn">Sign in</Link>}
          <Link href="/pro" className="btn gold">Go Pro</Link>
          <label htmlFor="mnav-toggle" className="menu-btn" aria-label="Open menu"><span /><span /><span /></label>
        </div>
      </div>
      <MobileNav>
        <NavLinks className="" variant="mobile" />
        <div className="mnav-foot">
          <StoreCartButton mobile />
          {next && <Link href={nextHref} className="btn">{nextLabel} · {fmtDate(next.event_date, { month: "short", day: "numeric" })}</Link>}
          <Link href={account ? "/account" : "/login"} className="btn">{account ? "Account" : "Sign in"}</Link>
          <Link href="/pro" className="btn gold">Go Pro</Link>
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
            <Link href="/store">PropBetEdge Store</Link>
            <a href={`mailto:${SITE.contact}`}>Contact the desk</a>
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
        <div className="net">
          <a href={SITE.network.mlb}><b>MLB</b><span>Baseball Intelligence</span><small>Live markets, model research, archives</small></a>
          <a href={SITE.network.nfl}><b>NFL</b><span>Football Intelligence</span><small>Prop board, Model Lab, Player DNA</small></a>
          <Link href="/" className="here"><b>UFC</b><span>Fight Intelligence</span><small>Cards, fighters, rankings, history, newsroom</small></Link>
        </div>
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
