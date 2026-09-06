import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { Logo, Mark } from "./Brand";
import { SITE } from "@/lib/site";
import { getNextEvent } from "@/lib/db";
import { eventSlug } from "@/lib/slug";
import { daysUntil, eventShortName, fmtDate } from "@/lib/format";

export async function Header() {
  const next = await getNextEvent();
  const d = next ? daysUntil(next.event_date) : null;
  const live = d != null && d <= 0 && d >= -1;
  return (
    <header className="hdr">
      <input id="mnav-toggle" type="checkbox" aria-hidden="true" />
      <div className="wrap hdr-in">
        <Logo />
        <NavLinks className="nav" />
        <div className="hdr-cta">
          {next && (
            <Link href={`/events/${eventSlug(next)}`} className="hdr-next" title={next.name}>
              <i className={`dot${live ? " live" : ""}`} aria-hidden="true" />
              <span><b>{live ? "Fight night" : d === 1 ? "Tomorrow" : d != null && d <= 6 ? "Fight week" : "Next"}</b> · {eventShortName(next.name)} · {fmtDate(next.event_date, { month: "short", day: "numeric" })}</span>
            </Link>
          )}
          <Link href="/pro" className="btn gold">Go Pro</Link>
          <label htmlFor="mnav-toggle" className="menu-btn" aria-label="Open menu"><span /><span /><span /></label>
        </div>
      </div>
      <div className="mnav">
        <NavLinks className="" />
        <div className="mnav-foot">
          {next && <Link href={`/events/${eventSlug(next)}`} className="btn">Next card</Link>}
          <Link href="/login" className="btn">Sign in</Link>
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
          <div>
            <div className="brand"><Mark size={30} /><span className="brand-word">PropBet<em>Edge</em></span> <strong className="brand-tag">UFC</strong></div>
            <p className="brand-blurb">
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
          Fighter portraits are Creative Commons images from Wikimedia Commons, credited on every page they appear. Nothing on this site is betting advice.
          Model output is labelled MODEL; provider data is labelled LIVE; anything unavailable is labelled as such. Please gamble responsibly. 21+ where applicable.
        </p>
        <div className="ftr-rail">
          <div><strong style={{ color: "var(--pbe-paper)" }}>PropBetEdge</strong> · Independent sports intelligence built from the data layer up.</div>
          <div>© {year} {SITE.publisher} · <a href={SITE.parent}>propbetedge.ai</a></div>
        </div>
      </div>
    </footer>
  );
}
