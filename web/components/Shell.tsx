import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { Logo, Mark } from "./Brand";
import { SITE } from "@/lib/site";
import { getNextEvent } from "@/lib/db";
import { getCurrentAccount } from "@/lib/auth";
import { eventSlug } from "@/lib/slug";
import { daysUntil, eventShortName, fmtDate } from "@/lib/format";

export async function Header() {
  const [next, account] = await Promise.all([getNextEvent(), getCurrentAccount()]);
  const d = next ? daysUntil(next.event_date) : null;
  const live = d != null && d <= 0 && d >= -1;
  const nextLabel = live ? "Fight night" : d === 1 ? "Tomorrow" : d != null && d <= 6 ? "Fight week" : "Next card";
  return (
    <header className="hdr">
      <input id="mnav-toggle" type="checkbox" aria-hidden="true" />
      <div className="wrap hdr-in hdr-wrap">
        <Logo />
        <NavLinks className="nav" />
        <div className="hdr-cta">
          {next && (
            <Link href={`/events/${eventSlug(next)}`} className="hdr-next" title={`${nextLabel}: ${next.name} — ${fmtDate(next.event_date)}`}>
              <i className={`dot${live ? " live" : ""}`} aria-hidden="true" />
              <span className="hdr-next-copy">
                <b>{nextLabel}</b>
                <span className="hdr-next-event">{eventShortName(next.name)}</span>
                <span className="hdr-next-date">{fmtDate(next.event_date, { month: "short", day: "numeric" })}</span>
              </span>
            </Link>
          )}
          {account ? <Link href="/account" className="btn account-btn">{account.unlimited ? "Owner" : account.plan === "pro" ? "Pro" : "Account"}</Link> : <Link href="/login" className="btn account-btn">Sign in</Link>}
          <Link href="/pro" className="btn gold">Go Pro</Link>
          <label htmlFor="mnav-toggle" className="menu-btn" aria-label="Open menu"><span /><span /><span /></label>
        </div>
      </div>
      <div className="mnav">
        <NavLinks className="" />
        <div className="mnav-foot">
          {next && <Link href={`/events/${eventSlug(next)}`} className="btn">{nextLabel}</Link>}
          <Link href={account ? "/account" : "/login"} className="btn">{account ? "Account" : "Sign in"}</Link>
        </div>
      </div>
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
              <em>From raw signal to decision infrastructure.</em> Fight intelligence built from the data layer up: every card,
              every fighter, every round, and a newsroom that only writes what the tables can prove.
            </p>
          </div>
          <div className="col">
            <h4>UFC</h4>
            <Link href="/events">Events &amp; cards</Link>
            <Link href="/fighters">Fighters</Link>
            <Link href="/rankings">Rankings</Link>
            <Link href="/news">News</Link>
            <a href="/feed.xml">RSS feed</a>
          </div>
          <div className="col">
            <h4>Company</h4>
            <Link href="/pro">UFC Pro</Link>
            <Link href="/login">Sign in</Link>
            <Link href="/account">Account</Link>
            <Link href="/about">About &amp; editorial policy</Link>
            <a href={`mailto:${SITE.contact}`}>Contact the desk</a>
          </div>
          <div className="col">
            <h4>Network</h4>
            <a href={SITE.parent}>PropBetEdge</a>
            <a href={SITE.network.mlb}>MLB Intelligence</a>
            <a href={SITE.network.nfl}>NFL Intelligence</a>
            <a href={SITE.network.api}>PropSports API</a>
          </div>
        </div>
        <div className="net">
          <a href={SITE.network.mlb}><b>MLB</b><span>Baseball Intelligence</span><small>Live markets, model research, archives</small></a>
          <a href={SITE.network.nfl}><b>NFL</b><span>Football Intelligence</span><small>Prop board, Model Lab, Player DNA</small></a>
          <Link href="/" className="here"><b>UFC</b><span>Fight Intelligence</span><small>Cards, fighters, rankings, newsroom</small></Link>
        </div>
        <p className="disclaimer">
          PropBetEdge is an independent sports intelligence product and is not affiliated with the UFC, Zuffa LLC, TKO Group, ESPN, or any sportsbook.
          Rights-cleared fighter media carries source/license provenance; selected upstream athlete images may be used as display-only fallbacks and are not part of the redistributable PropBetEdge media catalog.
          Nothing on this site is betting advice. Model output is labelled MODEL; provider data is labelled LIVE; anything unavailable is labelled as such. Please gamble responsibly. 21+ where applicable.
        </p>
        <div className="ftr-rail">
          <div><strong style={{ color: "var(--pbe-paper)" }}>PropBetEdge</strong> · Independent sports intelligence built from the data layer up.</div>
          <div>© {year} {SITE.publisher} · <a href={SITE.parent}>propbetedge.ai</a></div>
        </div>
      </div>
    </footer>
  );
}
