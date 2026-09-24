/* PBE LABS access, isolated from the UFC Pro paywall on purpose.
 *
 * Product contract (owner, Phase 1/2 of the Fight Simulator program): the
 * simulator is PBE LABS, a separate future paid add-on, NOT a "UFC Pro
 * feature" and NOT a PropBetEdge Pro SPORT. No Labs product is on sale yet and
 * no Stripe object exists for it.
 *
 * Until it is, simulation RESULTS are a Labs preview for current paying
 * members (UFC PRO ACTIVE, ALL ACCESS ACTIVE) and the owner. The page itself,
 * the product explanation, the model card and the upcoming-fight list are
 * public, so a free reader understands the product and can upgrade.
 *
 * The decision reuses the single verified access decision (access.pro, from
 * getUfcAccess) and never re-derives entitlement. When a Labs entitlement
 * ledger exists, this module is the one place that changes. */
import type { UfcAccess } from "./accessDecision";

export const LABS_PRODUCT_KEY = "fight_simulator";
export const LABS_ACCESS_POLICY = "labs-preview-members-v1" as const;

export type LabsSimulatorAccess = {
  allowed: boolean;
  policy: typeof LABS_ACCESS_POLICY;
  /** Why results are hidden, for the locked panel's copy. */
  reason: "member" | "signed_out" | "no_membership";
};

export function labsSimulatorAccess(access: Pick<UfcAccess, "pro" | "signedIn">): LabsSimulatorAccess {
  if (access.pro === true) return { allowed: true, policy: LABS_ACCESS_POLICY, reason: "member" };
  return { allowed: false, policy: LABS_ACCESS_POLICY, reason: access.signedIn ? "no_membership" : "signed_out" };
}
