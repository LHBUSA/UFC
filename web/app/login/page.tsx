import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SITE } from "@/lib/site";
import { Mark } from "@/components/Brand";
import { LoginForm } from "@/components/LoginForm";
import { getCurrentAccount } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Sign in to UFC Fight Intelligence",
  description: "Secure passwordless access to PropBetEdge UFC, Fight DNA and UFC Pro account features.",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: true },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const account = await getCurrentAccount();
  if (account) redirect("/account");
  const params = await searchParams;
  const next = params.next?.startsWith("/") && !params.next.startsWith("//") ? params.next : "/account";
  const error = params.error;

  return (
    <div className="wrap page login-page">
      <div className="login-shell">
        <div className="login-brand-panel">
          <div className="login-mark"><Mark size={58} /></div>
          <div className="eyebrow">PropBetEdge UFC · Secure access</div>
          <h1 className="serif">One identity. Your fight room.</h1>
          <p className="dim">Sign in by email to carry your UFC account, Pro entitlement and future Fight DNA tools across the product without another password to remember.</p>
          <div className="login-points">
            <span><b>30-day session</b><small>HttpOnly secure browser session</small></span>
            <span><b>Passwordless</b><small>One-use link delivered by Resend</small></span>
            <span><b>Network-ready</b><small>Built on the same PropBetEdge access pattern</small></span>
          </div>
        </div>
        <div className="login-card card hi">
          <div className="eyebrow dim">Member access</div>
          <h2 className="serif">Sign in to PropBetEdge UFC</h2>
          <p className="dim sm">Use the email tied to your subscription or internal access. New users can still browse the complete free UFC product without an account.</p>
          {error && (
            <div className="login-status error" role="alert">
              {error === "expired" ? "That sign-in link has expired or was already used. Request a fresh one below." : "Secure sign-in is temporarily unavailable. Please request a fresh link."}
            </div>
          )}
          <LoginForm next={next} />
          <div className="login-divider"><span>PropBetEdge network</span></div>
          <div className="login-network">
            <a href={SITE.parent}>PropBetEdge</a>
            <a href={SITE.network.nfl}>NFL</a>
            <a href={SITE.network.mlb}>MLB</a>
          </div>
          <p className="faint label">The same parent network, specialized products. UFC access is managed independently so no entitlement is assumed across sports.</p>
        </div>
      </div>
      <div className="login-foot"><Link href="/pro">See UFC Pro →</Link><span>·</span><Link href="/about">Editorial &amp; data methodology →</Link></div>
    </div>
  );
}
