import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { SITE } from "@/lib/site";

export function Header() {
  return (
    <header className="hdr">
      <div className="wrap hdr-in">
        <Link href="/" className="brand" aria-label="PropBetEdge UFC home">
          PropBet<em>Edge</em> <strong>UFC</strong>
        </Link>
        <NavLinks className="nav" />
        <div className="hdr-cta">
          <Link href="/login" className="btn hide-m">Sign in</Link>
          <Link href="/pro" className="btn gold">Go Pro</Link>
        </div>
        <label htmlFor="mnav-toggle" className="menu-btn" aria-label="Open menu"><span /><span /><span /></label>
      </div>
      <input id="mnav-toggle" type="checkbox" aria-hidden="true" />
      <div className="mnav">
        <NavLinks className="" />
        <Link href="/login">Sign in</Link>
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
          <div>
            <div className="brand">PropBet<em>Edge</em> <strong>UFC</strong></div>
            <p className="brand-blurb">
              <em>From raw signal to decision infrastructure.</em> Fight intelligence built from the data layer up: card
              tracking, fighter archives, and a model graded on calibration and closing-line value, not hit rate.
            </p>
          </div>
          <div>
            <h4>UFC</h4>
            <Link href="/events">Events</Link>
            <Link href="/fighters">Fighters</Link>
            <Link href="/rankings">Rankings</Link>
            <Link href="/news">News</Link>
            <Link href="/feed.xml">RSS</Link>
          </div>
          <div>
            <h4>Account</h4>
            <Link href="/pro">UFC Pro</Link>
            <Link href="/login">Sign in / access</Link>
            <Link href="/about">Editorial policy</Link>
          </div>
          <div>
            <h4>Network</h4>
            <a href={SITE.parent}>PropBetEdge</a>
            <a href={SITE.network.mlb}>MLB Intelligence</a>
            <a href={SITE.network.nfl}>NFL Intelligence</a>
            <a href="https://propsports.proptechusa.ai">PropSports API</a>
          </div>
        </div>
        <div className="net">
          <a href={SITE.network.mlb}><b>MLB</b><span>Baseball Intelligence OS</span><small>Live markets, model research, archives</small></a>
          <a href={SITE.network.nfl}><b>NFL</b><span>Football Intelligence OS</span><small>Prop board, Model Lab, line sim</small></a>
          <Link href="/"><b>UFC</b><span>Fight Intelligence OS</span><small>Cards, fighters, model &amp; card-change intel</small></Link>
        </div>
        <p className="disclaimer">
          PropBetEdge is an independent sports intelligence product and is not affiliated with the UFC, Zuffa LLC, or any sportsbook.
          Nothing on this site is betting advice. Model output is labelled MODEL; provider data is labelled LIVE; anything unavailable is labelled as such.
          Please gamble responsibly. 21+ where applicable.
        </p>
        <div className="ftr-rail">
          <div><strong style={{ color: "var(--pbe-paper)" }}>PropBetEdge</strong> · Independent sports intelligence built from the data layer up.</div>
          <div>© {year} {SITE.publisher} <a href={SITE.parent}>propbetedge.ai</a></div>
        </div>
      </div>
    </footer>
  );
}
