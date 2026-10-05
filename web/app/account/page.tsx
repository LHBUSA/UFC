import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth";
import { getUfcAccessWithBilling } from "@/lib/access";
import { PRO_OFFER } from "@/lib/proOffer";
import { getCustomerOrders } from "@/lib/store/customer-orders";
import { formatPrice } from "@/lib/store/types";
import { AllAccessActive } from "@/components/Membership";
import { AccessCheckPanel, CapabilityGrid, MemberActions, NetworkExpansion, SignOut, Story, VerifiedCard } from "@/components/AccountShell";
import { LOCAL_ALL_ACCESS_PATH, accountView, designation } from "@/lib/accountSurface";

export const metadata: Metadata = { title: "UFC Account", description: "Your PropBetEdge UFC access, entitlements and store orders.", robots: { index: false, follow: false } };

function orderStatus(status: "paid" | "in_production" | "cancelled"): string {
  if (status === "in_production") return "IN PRODUCTION";
  if (status === "cancelled") return "CANCELLED";
  return "PAID";
}

export default async function AccountPage() {
  const [account, access] = await Promise.all([getCurrentAccount(), getUfcAccessWithBilling()]);
  if (!account) redirect("/login?next=/account");
  /* A known account whose billing check did not answer is the access-check
   * state, never a bounce to sign-in or a sales screen. */
  const view = accountView({ signedIn: access.signedIn, pro: access.pro, ledger: access.ledger, membership: access.membership, hasAccount: true });
  if (view === "signed_out") redirect("/login?next=/account");
  const [orders] = await Promise.all([
    getCustomerOrders(account.email, 20).catch((error) => {
      console.error("[account] order history", String((error as Error)?.message || error).slice(0, 180));
      return [];
    }),
  ]);
  const sub = access.subscription;
  /* The shared membership state (FREE / UFC PRO ACTIVE / ALL ACCESS ACTIVE /
   * OWNER) was derived server-side from the billing verdict's access_source. */
  const m = access.membership;
  const sportPrice = sub?.plan === "weekly" ? `${PRO_OFFER.plans.weekly.display}/week` : sub?.plan === "monthly" ? `${PRO_OFFER.plans.monthly.display}/month` : null;
  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const accessThrough = sub?.current_period_end ? fmtDay(sub.current_period_end) : null;

  const d = designation(m.state);
  const member = view === "sport_pro" || view === "all_access" || view === "owner";
  const period = m.state === "owner" ? null : accessThrough ? `${sub?.cancel_at_period_end ? "Access through" : "Current period through"} ${accessThrough}${sportPrice && m.state === "sport_pro" ? ` · ${sportPrice}` : ""}` : null;
  const story = view === "all_access"
    ? { eyebrow: "UFC · Platinum Member", title: <>Your full UFC desk<br /><em>is unlocked.</em></>, copy: "PropBetEdge All Access covers this account: every UFC Pro surface here, and the rest of the network on the same membership." }
    : view === "owner"
      ? { eyebrow: "UFC · Verified Owner", title: <>Owner access<br /><em>is active.</em></>, copy: "Verified server-side from your emailed sign-in link. Every UFC Pro surface is open, with no subscription required." }
      : view === "sport_pro"
        ? { eyebrow: "UFC Pro · Verified", title: <>Every fighter<br /><em>leaves a pattern.</em></>, copy: "Fight DNA, PBE Algo and the Fight Simulator read each fight from the stored record. Every part of that desk is open on this account." }
        : view === "check"
          ? { eyebrow: "UFC · Access check", title: <>Your access<br /><em>is protected.</em></>, copy: "While verification is unavailable, nothing about your membership changes, and public UFC intelligence keeps working." }
          : { eyebrow: "PropBetEdge UFC · Account", title: <>Every fighter<br /><em>leaves a pattern.</em></>, copy: "Fight DNA, PBE Algo and the Fight Simulator are the UFC desk. Your account is ready for access." };

  return (
    <div className="wrap page account-page">
      <div className="acs-shell">
        <Story view={view} eyebrow={story.eyebrow} title={story.title} copy={story.copy} />
        <div className="acs-panel" data-acs-view={view}>
          {view === "check" && <AccessCheckPanel email={account.email} retryHref="/account" />}

          {member && d && (
            <div className="acs-panel-body">
              <span className="acs-eyebrow is-member">{d.eyebrow}</span>
              <h2 className="acs-head is-member">{view === "owner" ? "Owner access is active." : view === "all_access" ? <>Your full UFC desk<br />is unlocked.</> : "You're in."}</h2>
              <p className="acs-lede">{view === "all_access"
                ? "Your PropBetEdge All Access membership unlocks the full network — 10 sports plus PropBetEdge Predictions. UFC is one of them."
                : view === "owner" ? "Every UFC Pro surface is unlocked on this verified owner account."
                : "Your UFC Pro desk is live: Fight DNA, PBE Algo, PBE Picks, the Fight Simulator and fight-page market intelligence."}</p>
              <VerifiedCard m={m} email={account.email} period={period} />
              {view === "all_access" && <AllAccessActive m={m} />}
              <CapabilityGrid unlocked title="Unlocked on this account" />
              <MemberActions m={m} refreshHref="/account" />
              {view === "sport_pro" && m.show_all_access_upgrade && <NetworkExpansion />}
              {view === "all_access" && <Link href={LOCAL_ALL_ACCESS_PATH} className="acs-btn">Your network · launch any desk →</Link>}
              <p className="acs-secure is-member">◆ {d.status} · verified by PropBetEdge{view === "owner" ? " · no subscription required" : ""}</p>
            </div>
          )}

          {view === "signed_in" && (
            <div className="acs-panel-body">
              <div className="acs-identity"><i />SIGNED IN<b>{account.email}</b></div>
              <span className="acs-eyebrow">Account ready</span>
              <h2 className="acs-head">Your account is ready.</h2>
              <p className="acs-lede">{sub
                ? sub.status === "past_due" ? "Your UFC Pro payment is past due: update your payment method to restore access."
                  : sub.status === "canceled" ? "Your UFC Pro subscription has ended. Choose your access to continue."
                  : "No active UFC access is attached to this email yet."
                : "No active UFC access is attached to this email yet."}</p>
              <CapabilityGrid unlocked={false} title="What membership contains on UFC" />
              <div className="acs-actions">
                <Link href={LOCAL_ALL_ACCESS_PATH} className="acs-cta">View All Access</Link>
                <Link href="/pro" className="acs-btn">UFC Pro options</Link>
                {sub && <a href={PRO_OFFER.customerPortalLoginUrl} className="acs-btn" target="_blank" rel="noopener noreferrer">Manage billing ↗</a>}
                <Link href="/account" className="acs-btn" prefetch={false}>Refresh access</Link>
                <SignOut />
              </div>
            </div>
          )}
        </div>
      </div>

      <section id="orders" className="card mt-5">
        <div className="between" style={{ gap: 18, alignItems: "flex-start" }}>
          <div>
            <div className="eyebrow">Store orders</div>
            <h2 className="serif" style={{ marginTop: 6 }}>Your PropBetEdge gear.</h2>
            <p className="dim sm mt-2">Guest checkout stays fast. Any order purchased with this verified email appears here automatically.</p>
          </div>
          <Link href="/store" className="btn">Shop UFC gear</Link>
        </div>

        {orders.length ? (
          <div className="stack mt-5" style={{ gap: 12 }}>
            {orders.map((order) => (
              <div key={order.token} className="card" style={{ padding: 18 }}>
                <div className="between" style={{ gap: 14, alignItems: "flex-start" }}>
                  <div>
                    <div className="eyebrow dim">Order #{order.token.slice(-8).toUpperCase()} · {orderStatus(order.status)}</div>
                    <div className="serif" style={{ fontWeight: 800, fontSize: 20, marginTop: 7 }}>
                      {order.lines.map((line) => line.quantity > 1 ? `${line.quantity}× ${line.name}` : line.name).join(" · ")}
                    </div>
                    <p className="faint sm mt-2">
                      {new Date(order.placed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      {order.ships_to ? ` · ${order.ships_to}` : ""}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {order.total_cents != null ? <div className="st-price st-price-lg">{formatPrice(order.total_cents)}</div> : null}
                    <Link href={`/store/order/${order.token}`} className="btn mt-3">View order →</Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="card mt-5" style={{ padding: 18 }}>
            <div className="serif" style={{ fontWeight: 800, fontSize: 18 }}>No store orders on this email yet.</div>
            <p className="faint sm mt-2">Orders appear here after Stripe confirms payment. You never have to create an account before checkout.</p>
          </div>
        )}
      </section>

    </div>
  );
}
