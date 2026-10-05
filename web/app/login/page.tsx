import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { getUfcAccess } from "@/lib/access";
import { getCurrentAccount } from "@/lib/auth";
import { CapabilityGrid, Story } from "@/components/AccountShell";
import { LOCAL_ALL_ACCESS_PATH } from "@/lib/accountSurface";

export const metadata: Metadata = {
  title: "Sign in to UFC Fight Intelligence",
  description: "Secure passwordless access to PropBetEdge UFC, Fight DNA and UFC Pro account features.",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: true },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const [access, account] = await Promise.all([getUfcAccess(), getCurrentAccount().catch(() => null)]);
  /* Signed in, or a known account whose billing check did not answer (the
   * account page shows the access-check state): never ask them to sign in again. */
  if (access.signedIn || (account && access.ledger === "unavailable")) redirect("/account");
  const params = await searchParams;
  const next = params.next?.startsWith("/") && !params.next.startsWith("//") ? params.next : "/account";
  const error = params.error;

  return (
    <div className="wrap page login-page">
      <div className="acs-shell">
        <Story
          view="signed_out"
          eyebrow="PropBetEdge UFC · Member access"
          title={<>Every fighter<br /><em>leaves a pattern.</em></>}
          copy="Fight DNA, PBE Algo, the Fight Simulator and fight-page market intelligence: the UFC desk, one secure link away."
        />
        <div className="acs-panel" data-acs-view="signed_out">
          <div className="acs-panel-body">
          <span className="acs-eyebrow">Verified member access</span>
          <h2 className="acs-head">Welcome back.</h2>
          <p className="acs-lede">Sign in with the email attached to your UFC Pro or PropBetEdge All Access membership. Everything free on PropBetEdge UFC needs no account.</p>
          {error && (
            <div className="login-status error" role="alert">
              {error === "expired" ? "That sign-in link has expired or was already used. Request a fresh one below." : error === "not_authorized" ? "That sign-in link can no longer be used. UFC accounts require an active UFC Pro subscription." : "Secure sign-in is temporarily unavailable. Please request a fresh link."}
            </div>
          )}
          <LoginForm next={next} />
          <ul className="login-trust">
            <li><b>Passwordless secure access.</b> No password required.</li>
            <li>A single-use link goes to the address on your membership.</li>
          </ul>
          <p className="acs-lede">Need access? <Link href={LOCAL_ALL_ACCESS_PATH}>View PropBetEdge All Access</Link> · <Link href="/pro">UFC Pro</Link></p>
          <CapabilityGrid unlocked={false} title="What membership contains on UFC" />
          </div>
        </div>
      </div>
      <div className="login-foot"><Link href="/pro">See UFC Pro →</Link><span>·</span><Link href="/about">Editorial &amp; data methodology →</Link></div>
    </div>
  );
}
