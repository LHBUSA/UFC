import Link from "next/link";
import type { UfcAccess } from "@/lib/access";
import { ALL_ACCESS_CHECKOUT_URL, LOCAL_ALL_ACCESS_PATH, PLATINUM_TRUTH, accountView, designation } from "@/lib/accountSurface";
import { ALL_ACCESS_OFFER } from "@/lib/pbe-membership.js";
import { AccessCheckPanel, CapabilityGrid, MemberActions, NetworkLauncher, Story, VerifiedCard } from "@/components/AccountShell";
import family from "@/lib/family.json";

/* Native PropBetEdge All Access page body on the UFC site (owner decision
 * 2026-10-05). Renders one server verdict: it never decides access. The state
 * panel changes per verdict; the network and UFC content below it is static
 * and indexable. Only the explicit purchase CTA leaves for Stripe (the
 * canonical checkout URL, unchanged). */

type Entry = { key: string; label: string; name: string; url: string };
const SPORTS = (family as { sports: Entry[] }).sports;
const PREDICTIONS = (family as { products: Entry[] }).products.find((p) => p.key === "predictions")!;
const display = (s: Entry) => (s.key === "f1" ? "F1 Intelligence" : s.label);

const SPORT_LINES: Record<string, string> = {
  mlb: "Pitch-level evidence, HR and strikeout models, sharp tools",
  nfl: "PBE Algo, official picks, Player DNA, PBEcast",
  nba: "Game intelligence, Player DNA, load and rotations",
  wnba: "Game intelligence, WinBA, Player DNA",
  nhl: "Goalies, lines, shot intelligence, PBEcast",
  ufc: "Fight DNA, PBE Algo, Fight Simulator, matchup intelligence",
  tennis: "Player and match DNA, live match intelligence",
  soccer: "Match intelligence, PBEcast, tables, player intelligence",
  golf: "Player and Course DNA, field and tournament intelligence",
  f1: "Race, driver and circuit intelligence, PBEcast",
};

export type AllAccessInput = { access: Pick<UfcAccess, "signedIn" | "pro" | "ledger" | "membership" | "subscription">; accountEmail: string | null };

/** The /all-access page body for one server verdict (the route passes the live one; dev QA passes fixtures). */
export function AllAccessView({ access, accountEmail }: AllAccessInput) {
  const account = accountEmail ? { email: accountEmail } : null;
  const view = accountView({ signedIn: access.signedIn, pro: access.pro, ledger: access.ledger, membership: access.membership, hasAccount: Boolean(account) });
  const m = access.membership;
  const email = m.email || account?.email || null;
  const checkout = email ? `${ALL_ACCESS_CHECKOUT_URL}?prefilled_email=${encodeURIComponent(email)}` : ALL_ACCESS_CHECKOUT_URL;
  const d = designation(m.state);
  const others = SPORTS.filter((s) => s.key !== "ufc");
  const period = access.subscription?.current_period_end
    ? `${access.subscription.cancel_at_period_end ? "Access through" : "Renews"} ${new Date(access.subscription.current_period_end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`
    : null;

  const story = view === "all_access"
    ? { eyebrow: "PropBetEdge All Access · Platinum Member", title: <>Your network<br /><em>is unlocked.</em></>, copy: "UFC Fight Intelligence and every other PropBetEdge desk are open on this account. Launch any product from here." }
    : view === "owner"
      ? { eyebrow: "PropBetEdge · Verified Owner", title: <>The full network<br /><em>is unlocked.</em></>, copy: "Owner access is verified server-side. Every PropBetEdge sport and PropBetEdge Predictions are open, with no subscription required." }
      : view === "check"
        ? { eyebrow: "PropBetEdge All Access · Access check", title: <>Your access<br /><em>is protected.</em></>, copy: "While verification is unavailable, nothing about your membership changes, and public UFC intelligence keeps working." }
        : { eyebrow: "PropBetEdge Network · All Access", title: <>Fight Intelligence is one desk.<br /><em>All Access opens the network.</em></>, copy: "Fight DNA, PBE Algo and the Fight Simulator are how PropBetEdge reads a fight. All Access brings the same evidence-first intelligence to every sport in the network, plus PropBetEdge Predictions." };

  return (
    <div className="wrap page aap-page">
      <div className="acs-shell">
        <Story view={view} eyebrow={story.eyebrow} title={story.title} copy={story.copy} chips={["10 SPORTS · ONE MEMBERSHIP", "PREDICTIONS · INCLUDED", "UFC · YOU ARE HERE"]} />
        <div className="acs-panel" data-acs-view={view}>
          {view === "check" && <AccessCheckPanel email={account?.email || null} retryHref={LOCAL_ALL_ACCESS_PATH} />}

          {(view === "signed_out" || view === "signed_in") && (
            <div className="acs-panel-body">
              {view === "signed_in" && email && <div className="acs-identity"><i />SIGNED IN<b>{email}</b></div>}
              <span className="acs-eyebrow">PropBetEdge All Access</span>
              <h2 className="acs-head">{view === "signed_in" ? "Your account is ready." : <>10 sports + PropBetEdge Predictions.<br />One membership.</>}</h2>
              <div className="aap-price"><b>$29</b><span>/month</span><small>{ALL_ACCESS_OFFER.promoLine}</small></div>
              <SportsAndIntel />
              <div className="acs-actions">
                <a className="acs-cta" href={checkout} rel="noopener" data-pbe-placement="all_access_checkout" data-aap-cta="checkout">Get All Access</a>
                {view === "signed_out" && <Link href={`/login?next=${encodeURIComponent(LOCAL_ALL_ACCESS_PATH)}`} className="acs-btn">Sign in</Link>}
                <Link href="/pro" className="acs-btn">Only want UFC? UFC Pro</Link>
              </div>
              <p className="acs-secure">◆ Secure checkout by Stripe · Passwordless PropBetEdge access</p>
            </div>
          )}

          {view === "sport_pro" && (
            <div className="acs-panel-body">
              <span className="acs-eyebrow is-member">{d?.eyebrow}</span>
              <h2 className="acs-head is-member">Your UFC desk is<br />already unlocked.</h2>
              <VerifiedCard m={m} email={email} period={period} />
              <p className="acs-lede">Upgrade to PropBetEdge All Access to add the rest of the network to the same membership:</p>
              <ul className="aap-adds" aria-label="What All Access adds">
                {others.map((s) => <li key={s.key}>+ {display(s)}</li>)}
                <li className="is-intel">+ ◆ {PREDICTIONS.name}</li>
              </ul>
              <div className="acs-actions">
                <a className="acs-cta" href={checkout} rel="noopener" data-pbe-placement="all_access_upgrade" data-aap-cta="checkout">Upgrade to All Access · $29/month</a>
                <Link href="/fight-week" className="acs-btn">Open Fight Intelligence</Link>
                <Link href="/account" className="acs-btn">Your UFC account</Link>
              </div>
              <p className="acs-secure">{ALL_ACCESS_OFFER.promoLine} · UFC stays included</p>
            </div>
          )}

          {(view === "all_access" || view === "owner") && (
            <div className="acs-panel-body">
              <span className="acs-eyebrow is-member">{view === "owner" ? "PropBetEdge · Verified Owner" : "PropBetEdge All Access · Platinum Member"}</span>
              <h2 className="acs-head is-member">{view === "owner" ? "Owner access is active." : <>Your network<br />is unlocked.</>}</h2>
              <VerifiedCard m={m} email={email} period={view === "owner" ? null : period} />
              <NetworkLauncher owner={view === "owner"} />
              <MemberActions m={m} refreshHref={LOCAL_ALL_ACCESS_PATH} primary={{ href: "/fight-week", label: "Open Fight Intelligence →" }} />
              <p className="acs-secure is-member">◆ {view === "owner" ? "Verified owner · no checkout, no subscription required" : `Platinum Access Active · ${PLATINUM_TRUTH}`}</p>
            </div>
          )}
        </div>
      </div>

      <section className="aap-section" aria-labelledby="aap-network">
        <div className="eyebrow">The PropBetEdge network</div>
        <h2 id="aap-network" className="serif">Ten sport desks. One intelligence product.</h2>
        <p className="dim">Every desk is built for how its sport actually works, from the data layer up. Features vary by sport; each one lists only what it actually ships.</p>
        <ul className="aap-grid">
          {SPORTS.map((s) => (
            <li key={s.key} className={s.key === "ufc" ? "is-here" : undefined}>
              {s.key === "ufc"
                ? <span aria-current="page"><b>{display(s)}</b><em>YOU ARE HERE</em><small>{SPORT_LINES[s.key]}</small></span>
                : <a href={s.url} rel="noopener"><b>{display(s)}</b><em>{s.name.replace("PropBetEdge F1", "PropBetEdge F1 Intelligence")} →</em><small>{SPORT_LINES[s.key]}</small></a>}
            </li>
          ))}
        </ul>
        <a className="aap-intel" href={PREDICTIONS.url} rel="noopener">
          <span>Intelligence product · not a sport</span>
          <b>◆ {PREDICTIONS.name}</b>
          <small>Independent, source-backed forecasts with model probability, market comparison and a scored record.</small>
        </a>
      </section>

      <section className="aap-section" aria-labelledby="aap-ufc">
        <div className="eyebrow">Through the UFC lens</div>
        <h2 id="aap-ufc" className="serif">What the UFC desk brings to All Access.</h2>
        <CapabilityGrid unlocked={view === "sport_pro" || view === "all_access" || view === "owner"} title={view === "sport_pro" || view === "all_access" || view === "owner" ? "Unlocked on this account" : "What membership contains on UFC"} />
        <p className="faint sm mt-3">PropBetEdge is independent and is not affiliated with the UFC, Zuffa, TKO or any sportsbook. Intelligence is evidence, not a guarantee.</p>
      </section>
    </div>
  );
}

function SportsAndIntel() {
  return (
    <div className="aap-incl">
      <div><span>Sports · {SPORTS.length}</span><ul>{SPORTS.map((s) => <li key={s.key} className={s.key === "ufc" ? "is-here" : undefined}>{display(s)}</li>)}</ul></div>
      <div className="is-intel"><span>Intelligence</span><b>◆ {PREDICTIONS.name}</b></div>
    </div>
  );
}
