import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAccount, hasProAccess } from "@/lib/auth";
import { Mark } from "@/components/Brand";

export const metadata: Metadata = { title: "UFC Account", description: "Your PropBetEdge UFC access and entitlement status.", robots: { index: false, follow: false } };

export default async function AccountPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/login?next=/account");
  const pro = hasProAccess(account);
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

      <div className="card mt-5 between">
        <div><div className="eyebrow">Fight room</div><h2 className="serif" style={{ marginTop: 6 }}>Your access is ready.</h2><p className="dim sm mt-2">Fight DNA, cards, fighters and newsroom surfaces remain evidence-first. An entitlement never manufactures model output that has not been produced.</p></div>
        <div className="row"><Link href="/events" className="btn gold">Open fight cards</Link><Link href="/fighters" className="btn">Fighter DNA</Link></div>
      </div>

      <form action="/api/auth/logout" method="post" className="mt-5"><button type="submit" className="btn ghost">Sign out</button></form>
    </div>
  );
}
