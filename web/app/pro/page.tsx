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
import { algoCallsActive, getAlgoPublicRecord, getAlgoUpsetProof } from "@/lib/algo";
import { PbeUpsetRadar } from "@/components/PbeUpsetRadar";
import { AllAccessHero, ManageLink, MembershipBadge } from "@/components/Membership";

export const metadata: Metadata = {
  title: "UFC Pro — PBE Picks, UFC Predictions, Fight DNA & Market Edge",
  description: "UFC Pro unlocks PBE Picks from the PropBetEdge fight model: independent win probabilities, confidence, PBE Edge, model drivers and a locked graded record for eligible UFC bouts, plus Fight DNA and fight-week intelligence. $9.99/month or $3.99/week.",
  alternates: { canonical: "/pro" },
};

const safeNext = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.startsWith("/") && !s.startsWith("//") && !/[\r\n]/.test(s) ? s : null;
};

export default async function ProPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [access, rawAccount, algoIsLive, algoRecord, upsetProof] = await Promise.all([getUfcAccess(), getCurrentAccount(), algoCallsActive(), getAlgoPublicRecord(), getAlgoUpsetProof()]);
  const account = access.signedIn ? rawAccount : null;
  const owner = access.tier === "owner";
  const active = access.pro;
  const membership = access.membership;
  const allAccess = membership.state === "all_access";
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
        eyebrow="UFC Pro · PBE Picks · Proprietary fight model"
        title="PBE Algo calls the fights. UFC Pro shows you every call."
        lede="Every eligible bout. Independent win probabilities. Confidence. PBE Edge. Fight DNA. Official calls lock before the fight and are graded afterward — with the record left intact."
      />

      {returning !== "not_returning" && (
        <section className="checkout-return" role="status" aria-live="polite">
          {returning === "active" ? (
            <>
              <div className="eyebrow">Payment received · access verified</div>
              <h2>{owner ? "Owner access is active." : allAccess ? "All Access is active on this account." : "UFC Pro is active on this account."}</h2>
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
              <div className="eyebrow">{owner ? "Owner access" : allAccess ? "PropBetEdge All Access" : "UFC Pro"}</div>
              <h2 className="serif" style={{ margin: "7px 0 8px" }}>{owner ? "Unlimited UFC access is active." : allAccess ? "All Access covers UFC Pro on this account." : "Your UFC Pro access is active."}</h2>
              <p className="dim sm" style={{ maxWidth: 720 }}>
                {owner ? "No usage cap. No expiry. No checkout required." : allAccess ? "Every current and future PropBetEdge Pro sport is active for this account." : "Your server-side entitlement is active for this account."} Fight DNA and every released Pro surface are available to your account; features that do not yet have verified source/model output remain truthfully unavailable rather than being fabricated.
              </p>
            </div>
            <MembershipBadge m={membership} className="account-plan" />
          </div>
          <div className="row mt-4">
            <Link href="/account" className="btn gold">Account &amp; access</Link>
            <Link href="/events" className="btn">Open fight cards</Link>
            <Link href="/fighters" className="btn">Explore Fight DNA</Link>
            <ManageLink m={membership} label="Manage subscription" className="btn" />
          </div>
        </section>
      ) : returning === "verifying" || returning === "sign_in" ? null : <ProPlans email={account?.email ?? null} membership={membership} />}
      {/* UFC Pro members are offered the network umbrella beneath their member
          panel (UPGRADE TO ALL ACCESS). AllAccessHero renders nothing for
          ALL ACCESS ACTIVE / OWNER, so those accounts see no purchase CTA here. */}
      {active && <div className="mt-4"><AllAccessHero m={membership} variant="panel" email={account?.email ?? null} /></div>}

      <section className="card hi mt-6 pro-algo pro-algo-sales" aria-labelledby="pro-algo-title">
        <div className="eyebrow">UFC Pro flagship · PBE Picks · {algoIsLive ? (algoRecord.locked_predictions ? `${algoRecord.locked_predictions} official call${algoRecord.locked_predictions === 1 ? "" : "s"} locked` : "official calls active · first lock pending") : "official record begins at first lock"}</div>
        <h2 id="pro-algo-title" className="serif">The call. The probability. The edge. The receipt.</h2>
        <p className="dim sm pro-algo-sales-lede">
          PBE Algo scores every eligible UFC bout from pre-fight data only. UFC Pro gets the fighter call, win probability, confidence and data quality, fight-week consensus and best available odds, the de-vigged market probability, PBE Edge, and the model&apos;s own drivers for and against. Ineligible bouts show NO MODEL CALL with the reason instead of forcing a pick.
        </p>

        {algoRecord.locked_predictions > 0 ? (
          <div className="pro-algo-proof" aria-label="Live PBE Algo record">
            <div><b>{algoRecord.locked_predictions}</b><span>Locked calls</span></div>
            <div><b>{algoRecord.decided ? `${algoRecord.wins}-${algoRecord.losses}` : "—"}</b><span>Live record</span></div>
            <div><b>{algoRecord.hit_rate == null ? "—" : `${(Number(algoRecord.hit_rate) * 100).toFixed(1)}%`}</b><span>Hit rate</span></div>
            <div><b>{algoRecord.pending}</b><span>Awaiting result</span></div>
          </div>
        ) : (
          <div className="pro-algo-proof-empty">
            <b>THE LIVE RECORD STARTS AT THE FIRST OFFICIAL LOCK.</b>
            <span>No backtest result is borrowed into the live record, and provisional calls are not counted as official picks.</span>
          </div>
        )}

        <PbeUpsetRadar access={access} proof={upsetProof} />

        <div className="pro-algo-receipt">
          <div><span className="eyebrow">Accountability by design</span><strong>Every official call has a receipt.</strong></div>
          <p>Locked on the database clock before the fight. Graded against the stored official result. Corrections are dated revisions; losses do not disappear. Graded fights can train challenger models, but the live champion cannot silently replace itself.</p>
        </div>

        <div className="row mt-3">
          <Link href={active ? "/algo/card" : "/algo"} className="btn gold">{active ? "Open Current PBE Picks" : "See PBE Algo proof"}</Link>
          {active ? <Link href="/algo/record" className="btn">Full track record</Link> : <Link href="#pro" className="btn">Unlock UFC Pro</Link>}
        </div>
      </section>

      <section className="pro-dna" aria-labelledby="pro-dna-title">
        <div className="pro-dna-grid">
          <div>
            <div className="eyebrow">Proprietary intelligence · PropBetEdge Fight DNA</div>
            <h2 id="pro-dna-title">The intelligence layer beneath the call.</h2>
            <p>PBE Picks are the decision surface. Fight DNA is the evidence-backed fighter and matchup layer underneath it — versioned context that goes far beyond a record or a raw stat dump:</p>
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
          ["Fight DNA beneath the model", "Opponent stance, pace, attack distribution, grappling context and as-of historical features are rebuilt as versioned intelligence rather than a stat dump."],
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
          <div style={{ fontWeight: 700, color: "var(--pbe-paper)", fontSize: 18 }}>{active ? (owner ? "Owner entitlement: unlimited." : allAccess ? "All Access entitlement: active." : "UFC Pro entitlement: active.") : "Founding season pricing."}</div>
          <div className="faint sm">{active ? "Access is controlled server-side by your UFC account entitlement." : `UFC Pro is ${PRO_OFFER.plans.monthly.display}/month or ${PRO_OFFER.plans.weekly.display}/week. No free trial. Cancel anytime.`} Model-only surfaces still require actual validated model output regardless of plan.</div>
        </div>
        <Link href={access.signedIn ? "/account" : signInHref} className="btn">{access.signedIn ? "Account status" : "Sign in"}</Link>
      </div>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "Product",
        name: "PropBetEdge UFC Pro",
        description: "UFC Pro unlocks PBE Picks from the PropBetEdge fight model: independent win probabilities, confidence, PBE Edge, model drivers and a locked graded record for eligible UFC bouts, plus Fight DNA and fight-week intelligence.",
        brand: { "@type": "Brand", name: "PropBetEdge" },
        url: `${SITE.url}/pro`,
        offers: offerJsonLd(SITE.url),
      }} />
    </div>
  );
}
