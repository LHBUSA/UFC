import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAccount, hasProAccess } from "@/lib/auth";
import { getCustomerOrders } from "@/lib/store/customer-orders";
import { formatPrice } from "@/lib/store/types";
import { Mark } from "@/components/Brand";

export const metadata: Metadata = { title: "UFC Account", description: "Your PropBetEdge UFC access, entitlements and store orders.", robots: { index: false, follow: false } };

function orderStatus(status: "paid" | "in_production" | "cancelled"): string {
  if (status === "in_production") return "IN PRODUCTION";
  if (status === "cancelled") return "CANCELLED";
  return "PAID";
}

export default async function AccountPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/login?next=/account");
  const [pro, orders] = await Promise.all([
    Promise.resolve(hasProAccess(account)),
    getCustomerOrders(account.email, 20).catch((error) => {
      console.error("[account] order history", String((error as Error)?.message || error).slice(0, 180));
      return [];
    }),
  ]);

  return (
    <div className="wrap page account-page">
      <div className="account-hero card hi">
        <div className="account-mark"><Mark size={44} /></div>
        <div>
          <div className="eyebrow">PropBetEdge UFC account</div>
          <h1 className="serif">{account.display_name || account.email}</h1>
          <p className="dim sm">{account.email}</p>
        </div>
        <span className={`account-plan${account.unlimited ? " owner" : pro ? " pro" : ""}`}>{account.unlimited ? "OWNER · UNLIMITED" : pro ? "UFC PRO" : "FREE"}</span>
      </div>

      <div className="grid-3 mt-5">
        <div className="card"><div className="eyebrow dim">Access</div><div className="account-value">{account.unlimited ? "Unlimited" : pro ? "Pro active" : "Free"}</div><p className="faint sm">{account.unlimited ? "No expiry and no usage cap." : account.access_expires_at ? `Expires ${new Date(account.access_expires_at).toLocaleDateString("en-US")}.` : pro ? "Active entitlement." : "Upgrade any time."}</p></div>
        <div className="card"><div className="eyebrow dim">Role</div><div className="account-value">{account.role === "owner" ? "Owner" : account.role === "admin" ? "Admin" : "Member"}</div><p className="faint sm">Server-side entitlement; never inferred from the browser.</p></div>
        <div className="card"><div className="eyebrow dim">Session</div><div className="account-value">Secure</div><p className="faint sm">Passwordless session established with an HttpOnly cookie.</p></div>
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

      <div className="card mt-5 between">
        <div><div className="eyebrow">Fight room</div><h2 className="serif" style={{ marginTop: 6 }}>Your access is ready.</h2><p className="dim sm mt-2">Fight DNA, cards, fighters and newsroom surfaces remain evidence-first. An entitlement never manufactures model output that has not been produced.</p></div>
        <div className="row"><Link href="/events" className="btn gold">Open fight cards</Link><Link href="/fighters" className="btn">Fighter DNA</Link></div>
      </div>

      <form action="/api/auth/logout" method="post" className="mt-5"><button type="submit" className="btn ghost">Sign out</button></form>
    </div>
  );
}
