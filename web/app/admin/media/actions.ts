"use server";
/* Review actions. Server actions are public POST endpoints, so every one
 * re-checks the session role itself; the page gate alone is not enough. */
import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { FIGHTER_MEDIA_TAG } from "@/lib/fighterMedia";
import { MediaAdminError, currentMediaReviewer, quarantineAsset, reviewCandidate, type ReviewAction } from "@/lib/fighterMediaAdmin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set<ReviewAction>(["approve", "reject", "quarantine"]);

function back(formData: FormData, params: Record<string, string>): never {
  const ret = String(formData.get("return_to") || "/admin/media");
  const base = ret.startsWith("/admin/media") && !ret.startsWith("//") ? ret : "/admin/media";
  const url = new URL(base, "http://x");
  url.searchParams.delete("done");
  url.searchParams.delete("error");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v.slice(0, 300));
  redirect(`${url.pathname}${url.search}${params.anchor ? `#${params.anchor}` : ""}`);
}

function publish() {
  /* Approvals and quarantines must reach public pages on the next request,
   * not after the resolver's TTL. */
  revalidateTag(FIGHTER_MEDIA_TAG);
  revalidatePath("/admin/media");
}

export async function reviewCandidateAction(formData: FormData): Promise<void> {
  const reviewer = await currentMediaReviewer();
  if (!reviewer) back(formData, { error: "Not authorised." });
  const candidateId = String(formData.get("candidate_id") || "");
  const action = String(formData.get("action") || "") as ReviewAction;
  const reason = String(formData.get("reason") || "").trim();
  const anchor = String(formData.get("fighter_id") || "");
  if (!UUID.test(candidateId) || !ACTIONS.has(action)) back(formData, { error: "Malformed review request." });
  if (action === "approve" && formData.get("confirm_identity") !== "yes") back(formData, { error: "Approving requires confirming the identity checkbox.", anchor });
  if (action !== "approve" && !reason) back(formData, { error: `A reason is required to ${action}.`, anchor });
  try {
    await reviewCandidate({
      candidateId, action, reviewer: reviewer!,
      reason: reason || "identity confirmed in review UI",
      makePrimary: formData.get("make_primary") !== "no",
    });
  } catch (e) {
    back(formData, { error: e instanceof MediaAdminError ? e.message : "Review failed.", anchor });
  }
  publish();
  back(formData, { done: `${action}d`, anchor });
}

export async function quarantineAssetAction(formData: FormData): Promise<void> {
  const reviewer = await currentMediaReviewer();
  if (!reviewer) back(formData, { error: "Not authorised." });
  const assetId = String(formData.get("asset_id") || "");
  const reason = String(formData.get("reason") || "").trim();
  const anchor = String(formData.get("fighter_id") || "");
  if (!UUID.test(assetId)) back(formData, { error: "Malformed request." });
  if (!reason) back(formData, { error: "A reason is required to quarantine.", anchor });
  try {
    await quarantineAsset({ assetId, reason, reviewer: reviewer! });
  } catch (e) {
    back(formData, { error: e instanceof MediaAdminError ? e.message : "Quarantine failed.", anchor });
  }
  publish();
  back(formData, { done: "quarantined", anchor });
}

export async function refreshPublicPortraitsAction(formData: FormData): Promise<void> {
  const reviewer = await currentMediaReviewer();
  if (!reviewer) back(formData, { error: "Not authorised." });
  publish();
  back(formData, { done: "public portrait cache refreshed" });
}
