import type { Metadata } from "next";
import { getCurrentAccount } from "@/lib/auth";
import { getUfcAccess } from "@/lib/access";
import { LOCAL_ALL_ACCESS_PATH } from "@/lib/accountSurface";
import { AllAccessView } from "@/components/AllAccessView";

/* Native /all-access route: a real local page (no redirect, no iframe). */

export const metadata: Metadata = {
  title: "PropBetEdge All Access on UFC — 10 sports + Predictions, $29/month",
  description: "UFC Fight Intelligence is one desk in the PropBetEdge network. All Access adds MLB, NFL, NBA, WNBA, NHL, Tennis, Soccer, Golf and F1 Intelligence, plus PropBetEdge Predictions, for $29/month.",
  alternates: { canonical: LOCAL_ALL_ACCESS_PATH },
  openGraph: { title: "PropBetEdge All Access · UFC", description: "Fight Intelligence is one desk. All Access opens the network: 10 sports + PropBetEdge Predictions.", url: LOCAL_ALL_ACCESS_PATH },
};

export default async function AllAccessPage() {
  const [access, account] = await Promise.all([getUfcAccess(), getCurrentAccount().catch(() => null)]);
  return <AllAccessView access={access} accountEmail={account?.email ?? null} />;
}
