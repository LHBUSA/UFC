import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth";
import { getUfcAccessWithBilling } from "@/lib/access";
import { PRO_OFFER } from "@/lib/proOffer";
import { getCustomerOrders } from "@/lib/store/customer-orders";
import { formatPrice } from "@/lib/store/types";
import { Mark } from "@/components/Brand";
import { planText } from "@/lib/pbe-membership.js";
import { AllAccessHero, ManageLink, MembershipBadge, NetworkLink, NetworkRow } from "@/components/Membership";

export const metadata: Metadata = { title: "UFC Account", description: "Your PropBetEdge UFC access, entitlements and store orders.", robots: { index: false, follow: false } };

function orderStatus(status: "paid" | "in_production" | "cancelled"): string {
  if (status === "in_production") return "IN PRODUCTION";
  if (status === "cancelled") return "CANCELLED";
  return "PAID";
}

export default async function AccountPage() {
  const [account, access] = await Promise.all([getCurrentAccount(), getUfcAccessWithBilling()]);
  if (!account || !access.signedIn) redirect("/login?next=/account");
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

  return (
    <div className="wrap page account-page">
      <div className="account-hero card hi">
        <div className="account-mark"><Mark size={44} /></div>
        <div>
          <div className="eyebrow">PropBetEdge UFC account</div>
          <h1 className="serif">{account.display_name || account.email}</h1>
          <p className="dim sm">{account.email}</p>
        </div>
        <MembershipBadge m={m} className="account-plan" />
      </div>

      <div className="grid-3 mt-5">
        <div className="card">
          <div className="eyebrow dim">Access</div>
          <div className="account-value">{m.state === "owner" ? "Owner · unlimited" : m.state === "all_access" ? "All Access active" : m.state === "sport_pro" ? "UFC Pro active" : "Free"}</div>
          {m.state === "owner" ? <p className="faint sm">No expiry and no usage cap.</p>
            : m.show_manage && sub ? (
              <dl className="billing-rows">
                <dt>Plan</dt><dd>{m.state === "all_access" ? planText(m) : sportPrice ? `${planText(m)} · ${sportPrice}` : planText(m)}</dd>
                <dt>Status</dt><dd>{sub.cancel_at_period_end ? "Active · cancels at period end" : "Active"}</dd>
                {accessThrough && <><dt>{sub.cancel_at_period_end ? "Access through" : "Renews"}</dt><dd>{accessThrough}</dd></>}
              </dl>
            )
            : sub ? <p className="faint sm">Your UFC Pro subscription is {sub.status === "past_due" ? "past due: update your payment method to restore access" : sub.status === "canceled" ? "canceled" : `not active (${sub.status})`}.</p>
            : access.ledger === "unavailable" ? <p className="faint sm">Billing status could not be checked just now. Refresh in a moment.</p>
            : <p className="faint sm">Upgrade any time.</p>}
          <div className="row mt-3">
            {/* Manage billing follows the shared rule: UFC Pro and All Access
                members manage a subscription; the owner has none. A lapsed
                subscription (entitled:false) still gets the portal to fix it. */}
            {m.show_manage ? <ManageLink m={m} label="Manage billing" className="btn" />
              : m.state === "free" && sub ? <a href={PRO_OFFER.customerPortalLoginUrl} className="btn" target="_blank" rel="noopener noreferrer">Manage billing ↗</a> : null}
            {m.show_purchase_cta && <Link href="/pro" className="btn gold">{sub ? "Resubscribe" : "Unlock UFC Pro"}</Link>}
          </div>
          <div className="pbe-mbr-panel mt-4">
            <div className="pbe-mbr-links"><NetworkLink m={m} /></div>
            <NetworkRow current="ufc" />
          </div>
        </div>
        <div className="card"><div className="eyebrow dim">Role</div><div className="account-value">{account.role === "owner" ? "Owner" : account.role === "admin" ? "Admin" : "Member"}</div><p className="faint sm">Server-side entitlement; never inferred from the browser.</p></div>
        <div className="card"><div className="eyebrow dim">Session</div><div className="account-value">Secure</div><p className="faint sm">Passwordless session established with an HttpOnly cookie.</p></div>
      </div>

      {/* UFC Pro members see the network umbrella as an optional upgrade; All
          Access members and the owner are never sold anything here. */}
      {m.show_all_access_upgrade && <div className="mt-5"><AllAccessHero m={m} variant="panel" email={m.email} /></div>}

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

      <div className="card mt-5 between">
        <div><div className="eyebrow">Fight room</div><h2 className="serif" style={{ marginTop: 6 }}>Your access is ready.</h2><p className="dim sm mt-2">Fight DNA, cards, fighters and newsroom surfaces remain evidence-first. An entitlement never manufactures model output that has not been produced.</p></div>
        <div className="row"><Link href="/events" className="btn gold">Open fight cards</Link><Link href="/fighters" className="btn">Fighter DNA</Link></div>
      </div>

      <form action="/api/auth/logout" method="post" className="mt-5"><button type="submit" className="btn ghost">Sign out</button></form>
    </div>
  );
}
