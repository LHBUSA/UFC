import type { Metadata } from "next";
import Link from "next/link";
import { ProPlans, PageHead, JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";
import { Origin } from "@/components/dna";
import { getUfcAccess } from "@/lib/access";
import { checkoutReturnState, parseCheckoutReturn } from "@/lib/accessDecision";
import { PRO_OFFER, offerJsonLd } from "@/lib/proOffer";
import { CheckoutVerifyRefresh } from "@/components/CheckoutVerifyRefresh";
import { getCurrentAccount } from "@/lib/auth";
import { algoCallsActive, getAlgoPublicRecord } from "@/lib/algo";

export const metadata: Metadata = {
  title: "UFC Pro — Fight DNA Intelligence Layer & Fight Week Access",
  description: "PropBetEdge UFC Pro founding season: $9.99/month or $3.99/week, no free trial, cancel anytime. PBE Algo win probabilities with a locked, graded record, plus the proprietary Fight DNA intelligence layer (matchup DNA, round intelligence, fight-week desk, market movement, officials tendencies).",
  alternates: { canonical: "/pro" },
};

const safeNext = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.startsWith("/") && !s.startsWith("//") && !/[\r\n]/.test(s) ? s : null;
};

export default async function ProPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [access, rawAccount, algoIsLive, algoRecord] = await Promise.all([getUfcAccess(), getCurrentAccount(), algoCallsActive(), getAlgoPublicRecord()]);
  const account = access.signedIn ? rawAccount : null;
  const owner = access.tier === "owner";
  const active = access.pro;
  /* The query string picks which sentence to show. It is never an input to
   * access: `access` above was decided from the session and the ledger. */
  const ret = parseCheckoutReturn(params);
  const returning = checkoutReturnState(ret, access);
  const next = safeNext(params.next);
  const planLabel = ret.plan ? PRO_OFFER.plans[ret.plan].label : "UFC Pro";
  const signInHref = `/login?next=${encodeURIComponent(ret.success ? `/pro?checkout=success${ret.plan ? `&plan=${ret.plan}` : ""}` : next || "/pro")}`;

  return (
    <div className="wrap page">
      <PageHead
        crumbs={[{ name: "Pro" }]}
        eyebrow="UFC Pro"
        title="PBE Algo and Fight DNA. Model claims only when earned."
        lede="UFC Pro is built around PBE Algo, Fight DNA and fight-week intelligence. Every PBE Algo call is locked before the fight and graded after it, and nothing is shown that the model did not produce."
      />

      {returning !== "not_returning" && (
        <section className="checkout-return" role="status" aria-live="polite">
          {returning === "active" ? (
            <>
              <div className="eyebrow">Payment received · access verified</div>
              <h2>{owner ? "Owner access is active." : "UFC Pro is active on this account."}</h2>
              <p>Your account&apos;s entitlement was confirmed server-side. Every Pro surface is unlocked.</p>
              <div className="row mt-3">{next ? <Link href={next} className="btn gold">Back to where you were</Link> : <Link href="/fighters" className="btn gold">Explore Fight DNA</Link>}<Link href="/account" className="btn">Account &amp; billing</Link></div>
            </>
          ) : returning === "sign_in" ? (
            <>
              <div className="eyebrow">Payment received · verifying UFC Pro access</div>
              <h2>Sign in with the email you used at checkout.</h2>
              <p>{planLabel} unlocks on the PropBetEdge UFC account with the same email Stripe collected. Signing in is passwordless: a one-use link is emailed only once Stripe&apos;s confirmation has reached our billing system, so if it does not arrive, wait a minute and request it again.</p>
              <div className="row mt-3"><Link href={signInHref} className="btn gold">Sign in to activate</Link></div>
            </>
          ) : (
            <>
              <div className="eyebrow">Payment received · verifying UFC Pro access</div>
              <h2>Confirming your subscription with Stripe…</h2>
              <p>
                This usually takes a few seconds and this page re-checks automatically. Access is granted only when Stripe&apos;s confirmation reaches our billing system, never from this page&apos;s address.
                {account?.email ? <> You are signed in as <b>{account.email}</b>; if you used a different email at checkout, sign out and sign in with that one.</> : null}
              </p>
              <CheckoutVerifyRefresh />
            </>
          )}
        </section>
      )}

      {active ? (
        <section className="card hi pro-access-active">
          <div className="between" style={{ gap: 18, alignItems: "flex-start" }}>
            <div>
              <div className="eyebrow">{owner ? "Owner access" : "UFC Pro"}</div>
              <h2 className="serif" style={{ margin: "7px 0 8px" }}>{owner ? "Unlimited UFC access is active." : "Your UFC Pro access is active."}</h2>
              <p className="dim sm" style={{ maxWidth: 720 }}>
                {owner ? "No usage cap. No expiry. No checkout required." : "Your server-side entitlement is active for this account."} Fight DNA and every released Pro surface are available to your account; features that do not yet have verified source/model output remain truthfully unavailable rather than being fabricated.
              </p>
            </div>
            <span className="account-plan owner">{owner ? "OWNER · UNLIMITED" : "UFC PRO · ACTIVE"}</span>
          </div>
          <div className="row mt-4">
            <Link href="/account" className="btn gold">Account &amp; access</Link>
            <Link href="/events" className="btn">Open fight cards</Link>
            <Link href="/fighters" className="btn">Explore Fight DNA</Link>
          </div>
        </section>
      ) : returning === "verifying" || returning === "sign_in" ? null : <ProPlans email={account?.email ?? null} />}

      <section className="card hi mt-6 pro-algo" aria-labelledby="pro-algo-title">
        <div className="eyebrow">UFC Pro flagship · PBE Algo · {algoIsLive ? (algoRecord.locked_predictions ? `${algoRecord.locked_predictions} locked call${algoRecord.locked_predictions === 1 ? "" : "s"}` : "official calls active, first lock pending") : "pre-launch"}</div>
        <h2 id="pro-algo-title" className="serif" style={{ margin: "7px 0 8px" }}>The call, the probability, the edge and the history.</h2>
        <p className="dim sm" style={{ maxWidth: 760 }}>
          PBE Algo scores every eligible UFC bout from pre-fight data only: pick, win probability, confidence and data quality, the market-implied probability with the vig removed, the PBE delta, and the model&apos;s own drivers for and against. Calls lock on the database clock before the fight and are graded after it; ineligible bouts show NO MODEL CALL with the reason.
          {algoIsLive ? "" : " The first official call has not been locked yet, and the record will start at zero rather than borrow from the backtest."}
        </p>
        <div className="row mt-3">
          <Link href={active ? "/algo/card" : "/algo"} className="btn gold">{active ? "Current PBE Picks" : "How PBE Algo works"}</Link>
          {active && <Link href="/algo/record" className="btn">Track record</Link>}
        </div>
      </section>

      <section className="pro-dna" aria-labelledby="pro-dna-title">
        <div className="pro-dna-grid">
          <div>
            <div className="eyebrow">Proprietary intelligence · PropBetEdge Fight DNA</div>
            <h2 id="pro-dna-title">Go beyond the fight record.</h2>
            <p>UFC Pro is founding access to the Fight DNA intelligence layer as it deepens, not simply more stats. Pro surfaces ship against the same evidence-backed system:</p>
            <ul>
              <li>Matchup-specific DNA</li><li>Stance splits</li><li>Striking geography</li><li>Grappling efficiency</li><li>Finish patterns</li><li>Round progression</li><li>Context splits</li><li>Fight Week intelligence</li><li>Deeper evidence packets</li>
            </ul>
            <div className="pro-dna-actions"><Link href="/learn/fight-dna" className="btn">See how Fight DNA works →</Link><Link href="/fight-week" className="btn">Open Fight Week</Link></div>
          </div>
          <div className="pro-dna-why">
            <div className="eyebrow">Why this is different</div>
            <h3>Most fight pages display source statistics.</h3>
            <p>Fight DNA reconstructs the underlying fight record into a versioned analytical feature system with explicit sample size, confidence and provenance. <span className="dna-derived-line" style={{ display: "inline-flex", marginTop: 0 }}><Origin explain /></span></p>
            <p className="fine">Raw data tells you what happened. Fight DNA describes the fighter the data reveals. No promise of profitable betting, no claim of predictive certainty: Pro sells intelligence, not guaranteed outcomes.</p>
          </div>
        </div>
      </section>

      <div className="grid-3 mt-6">
        {[
          ["Fight DNA over surface stats", "Opponent stance, pace, attack distribution, grappling context and as-of historical features are being built as a versioned intelligence layer rather than a stat dump."],
          ["Fight week is part of the product", "Card changes, official weigh-ins, news state and future market snapshots belong in the same bout timeline so the context present when a decision was made is never lost."],
          ["No manufactured edge", "If PropBetEdge does not have a verified line, model output or enough sample to support a claim, the product says so. Locked means locked until the evidence exists."],
        ].map(([h, p]) => (
          <div key={h} className="card">
            <h3 className="serif" style={{ marginBottom: 8, fontSize: 20 }}>{h}</h3>
            <p className="dim sm">{p}</p>
          </div>
        ))}
      </div>

      <div className="card hi mt-6 between">
        <div>
          <div className="eyebrow">Access status</div>
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>{active ? (owner ? "Owner entitlement: unlimited." : "UFC Pro entitlement: active.") : "Founding season pricing."}</div>
          <div className="faint sm">{active ? "Access is controlled server-side by your UFC account entitlement." : `UFC Pro is ${PRO_OFFER.plans.monthly.display}/month or ${PRO_OFFER.plans.weekly.display}/week. No free trial. Cancel anytime.`} Model-only surfaces still require actual validated model output regardless of plan.</div>
        </div>
        <Link href={access.signedIn ? "/account" : signInHref} className="btn">{access.signedIn ? "Account status" : "Sign in"}</Link>
      </div>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "Product",
        name: "PropBetEdge UFC Pro",
        description: "Founding access to the PropBetEdge Fight DNA intelligence layer, Fight Week intelligence and deeper evidence packets for UFC, with model-derived claims displayed only when validated. No free trial; cancel anytime.",
        brand: { "@type": "Brand", name: "PropBetEdge" },
        url: `${SITE.url}/pro`,
        offers: offerJsonLd(SITE.url),
      }} />
    </div>
  );
}
