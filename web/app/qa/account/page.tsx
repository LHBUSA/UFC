import { notFound } from "next/navigation";
import { AllAccessView } from "@/components/AllAccessView";
import { deriveMembership } from "@/lib/pbe-membership.js";

/* Development-only visual QA for the /all-access states. Returns 404 on
 * production and on any Vercel deployment (same guard as /qa/preview). Each
 * fixture is built through the shared contract's deriveMembership, so the
 * membership objects are shaped exactly like the server verdicts. Emails are
 * synthetic. */
export const dynamic = "force-dynamic";

const end = "2026-11-05T00:00:00Z";
const FIXTURES = {
  anonymous: { access: { signedIn: false, pro: false, ledger: "skipped", membership: deriveMembership({ sport: "ufc" }), subscription: null }, accountEmail: null },
  signed_in: { access: { signedIn: true, pro: false, ledger: "ok", membership: deriveMembership({ sport: "ufc", email: "member@example.com" }), subscription: null }, accountEmail: "member@example.com" },
  sport_pro: { access: { signedIn: true, pro: true, ledger: "ok", membership: deriveMembership({ sport: "ufc", entitled: true, accessSource: "sport", plan: "monthly", email: "pro@example.com", currentPeriodEnd: end, hasBilling: true }), subscription: { plan: "monthly", status: "active", current_period_end: end, cancel_at_period_end: false } }, accountEmail: "pro@example.com" },
  all_access: { access: { signedIn: true, pro: true, ledger: "skipped", membership: deriveMembership({ sport: "ufc", entitled: true, accessSource: "all_access", productKey: "pbe_all_access", email: "platinum@example.com", currentPeriodEnd: end, hasBilling: true }), subscription: { plan: null, status: "active", current_period_end: end, cancel_at_period_end: false } }, accountEmail: "platinum@example.com" },
  owner: { access: { signedIn: true, pro: true, ledger: "ok", membership: deriveMembership({ sport: "ufc", entitled: true, accessSource: "owner", email: "owner@example.com" }), subscription: null }, accountEmail: "owner@example.com" },
  check: { access: { signedIn: false, pro: false, ledger: "unavailable", membership: deriveMembership({ sport: "ufc" }), subscription: null }, accountEmail: "member@example.com" },
} as const;

export default async function QaAccount({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.VERCEL_ENV || process.env.NODE_ENV === "production" && process.env.PBE_QA_PREVIEW !== "1") notFound();
  const { state = "anonymous" } = await searchParams;
  const f = FIXTURES[state as keyof typeof FIXTURES];
  if (!f) notFound();
  return <AllAccessView access={f.access as never} accountEmail={f.accountEmail} />;
}
