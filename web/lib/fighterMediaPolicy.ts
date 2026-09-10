/* Fighter portrait policy: pure functions, no I/O.
 *
 * One implementation, three callers:
 *   web/lib/fighterMedia.ts                   the public resolver (server)
 *   web/app/admin/media                       the review UI
 *   scripts/media/fighter_portrait_queue.mjs  the candidate generator (Node
 *                                             imports this .ts file directly)
 *
 * The rule the whole module serves: a placeholder is always an acceptable
 * answer, a wrong face never is. Every check fails closed, and a reason is
 * returned for each refusal so coverage reports can say WHY a fighter has no
 * photo instead of just counting blanks.
 *
 * Keep this file free of imports so Node's type stripping can load it. */

/* Where a portrait is being rendered.
 *   high_visibility  homepage, fight week, fighter profile, matchup cards,
 *                    event cards, rankings, weigh-ins, news, share images.
 *                    Requires commercial_use_allowed.
 *   standard         archive and index surfaces (round-by-round archive,
 *                    A-Z fighter index, Hall of Fame, TUF, injuries). An
 *                    approved, identity-verified asset may appear here without
 *                    a commercial grant only if its surface_policy allows it.
 */
export type SurfaceTier = "high_visibility" | "standard";
export type SurfacePolicy = "all_surfaces" | "standard_surfaces" | "internal_only";
export type ReviewStatus = "pending" | "approved" | "rejected" | "quarantined" | "retired";
export type SourceType = "wikimedia_commons" | "public_domain" | "us_government" | "official_press" | "licensed_editorial" | "espn" | "first_party" | "other";
export type LicenseType = "cc0" | "public_domain" | "cc_by" | "cc_by_sa" | "editorial_license" | "press_kit" | "first_party" | "display_only" | "all_rights_reserved" | "unknown";

/* The columns the resolver reads (ufc_fighter_portrait_eligible). */
export type EligiblePortraitRow = {
  id: string;
  fighter_id: string;
  image_url: string;
  storage_key: string | null;
  legacy_image_id: string | null;
  source_url: string;
  source_name: string;
  source_type: SourceType;
  license_type: LicenseType;
  license_label: string | null;
  author: string | null;
  commercial_use_allowed: boolean;
  derivative_use_allowed: boolean;
  attribution_required: boolean;
  attribution_text: string | null;
  verified_identity: boolean;
  review_status: ReviewStatus;
  is_primary: boolean;
  surface_policy: SurfacePolicy;
  width: number | null;
  height: number | null;
  focal_x: number | null;
  focal_y: number | null;
  suitability_score: number | null;
  last_verified_at: string | null;
};

export type PortraitDecision = { ok: true } | { ok: false; reason: PortraitRefusal };
export type PortraitRefusal =
  | "no_asset" | "not_approved" | "identity_unverified" | "not_primary" | "never_verified"
  | "insecure_url" | "no_provenance" | "missing_attribution" | "internal_only"
  | "surface_restricted" | "commercial_rights_required" | "rights_basis_inconsistent";

const AFFIRMATIVE_COMMERCIAL_BASIS = new Set<LicenseType>(["cc0", "public_domain", "cc_by", "cc_by_sa", "editorial_license", "press_kit", "first_party"]);

/* The public-render gate. The database view already filters on most of these;
 * they are checked again here so a view regression, a hand-written query or a
 * fixture cannot put an unreviewed face on a page. */
export function portraitDecision(row: EligiblePortraitRow | null | undefined, surface: SurfaceTier): PortraitDecision {
  if (!row) return { ok: false, reason: "no_asset" };
  if (row.review_status !== "approved") return { ok: false, reason: "not_approved" };
  if (row.verified_identity !== true) return { ok: false, reason: "identity_unverified" };
  if (row.is_primary !== true) return { ok: false, reason: "not_primary" };
  if (!row.last_verified_at) return { ok: false, reason: "never_verified" };
  if (!/^https:\/\//i.test(row.image_url || "")) return { ok: false, reason: "insecure_url" };
  if (!row.source_url || !row.source_name) return { ok: false, reason: "no_provenance" };
  if (row.attribution_required && !String(row.attribution_text || "").trim()) return { ok: false, reason: "missing_attribution" };
  if (row.surface_policy === "internal_only") return { ok: false, reason: "internal_only" };
  if (row.commercial_use_allowed && !AFFIRMATIVE_COMMERCIAL_BASIS.has(row.license_type)) return { ok: false, reason: "rights_basis_inconsistent" };
  if (surface === "high_visibility") {
    if (row.surface_policy !== "all_surfaces") return { ok: false, reason: "surface_restricted" };
    if (row.commercial_use_allowed !== true) return { ok: false, reason: "commercial_rights_required" };
  }
  return { ok: true };
}

/* ---- rights ------------------------------------------------------------- */

export type RightsProfile = {
  license_type: LicenseType;
  commercial_use_allowed: boolean;
  derivative_use_allowed: boolean;
  attribution_required: boolean;
};

/* The same allowlist fetch_fighter_portraits.mjs admits (CC0, Public domain,
 * CC BY x.x, CC BY-SA x.x). Anything else is unknown, and unknown grants
 * nothing. NC / ND / GFDL-only never match. */
export function classifyLicense(label: string | null | undefined): RightsProfile {
  const l = String(label || "").trim().toLowerCase();
  if (/^cc0(\s*1\.0)?$/.test(l)) return { license_type: "cc0", commercial_use_allowed: true, derivative_use_allowed: true, attribution_required: false };
  if (/^public domain/.test(l) || l === "pd") return { license_type: "public_domain", commercial_use_allowed: true, derivative_use_allowed: true, attribution_required: false };
  if (/^cc by-sa \d(\.\d)?$/.test(l)) return { license_type: "cc_by_sa", commercial_use_allowed: true, derivative_use_allowed: true, attribution_required: true };
  if (/^cc by \d(\.\d)?$/.test(l)) return { license_type: "cc_by", commercial_use_allowed: true, derivative_use_allowed: true, attribution_required: true };
  return { license_type: "unknown", commercial_use_allowed: false, derivative_use_allowed: false, attribution_required: true };
}

/* ESPN headshots: no license grant to PropBetEdge. Identity can be reviewed,
 * rights cannot be assumed, so they are never commercial and never allowed on
 * a high-visibility surface. */
export const ESPN_RIGHTS: RightsProfile = { license_type: "display_only", commercial_use_allowed: false, derivative_use_allowed: false, attribution_required: true };

/* ---- identity ------------------------------------------------------------ */

/* How much the recorded evidence says about identity, 0..1. This orders the
 * review queue and colours the review UI. It NEVER approves anything: only a
 * named reviewer sets verified_identity. */
export function identityConfidence(evidence: Record<string, unknown> | null | undefined, sourceType: SourceType): number {
  const e = evidence || {};
  if (!Object.keys(e).length || e.recorded_evidence === false) return 0.2;
  if (e.former_fighter_id || e.status === "detached") return 0;
  const dob = e.dob_match === true;
  const nameSignals = Array.isArray(e.name_match) ? e.name_match.length : e.name_match === true ? 1 : 0;
  if (sourceType === "espn") {
    if (e.athlete_id_match !== true || e.name_exact !== true) return 0.3;
    if (e.dob_match === false) return 0.05;
    return dob ? 0.9 : 0.7;
  }
  if (e.method === "wikidata_p18" && dob) return 0.95;
  if (typeof e.wikidata_qid === "string" && dob && nameSignals >= 2) return 0.9;
  if (dob && nameSignals >= 1) return 0.8;
  if (e.wikidata_evidence === "dob_match" && e.fighter_name_in_metadata === true) return e.mma_context === true ? 0.8 : 0.65;
  if (nameSignals >= 2) return 0.6;
  if (typeof e.identity_confidence === "number") return Math.max(0, Math.min(1, e.identity_confidence));
  return 0.35;
}

/* ---- suitability ---------------------------------------------------------- */

const NON_PHOTO_EXT = /\.(djvu|pdf|svg|tiff?|ogg|ogv|webm|mp3|mp4|gif)(\?|$)/i;

/* Is this a usable fighter portrait at all, 0..100, with the reasons. */
export function suitability(input: {
  image_url: string; width?: number | null; height?: number | null; framing_status?: string | null; source_type: SourceType;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  if (NON_PHOTO_EXT.test(input.image_url)) return { score: 0, flags: ["not_a_photo_format"] };
  let score = 60;
  const w = Number(input.width || 0), h = Number(input.height || 0);
  if (w && h) {
    const edge = Math.min(w, h);
    if (edge < 300) { score -= 30; flags.push("low_resolution"); }
    else if (edge < 420) { score -= 10; flags.push("small_source"); }
    else score += 10;
    const aspect = w / h;
    if (aspect > 1.9 || aspect < 0.45) { score -= 20; flags.push("extreme_aspect"); }
    else if (aspect <= 1) score += 10; /* portrait orientation crops cleanly */
  } else if (input.source_type !== "espn") {
    flags.push("dimensions_unknown");
  }
  if (input.framing_status === "ok") score += 15;
  else if (input.framing_status === "no_face") { score -= 15; flags.push("no_face_detected"); }
  if (input.source_type === "espn") score += 10; /* studio headshot, consistent framing */
  return { score: Math.max(0, Math.min(100, score)), flags };
}

/* ---- queue priority --------------------------------------------------------- */

export type QueueReason =
  | "champion" | "ranked_top5" | "ranked" | "p4p"
  | "next_card_main_event" | "next_card" | "card_2" | "card_3"
  | "featured" | "active_roster" | "legacy_portrait";

const REASON_WEIGHT: Record<QueueReason, number> = {
  champion: 100, next_card_main_event: 98, ranked_top5: 90, next_card: 88, featured: 85, ranked: 80,
  p4p: 80, card_2: 72, card_3: 64, active_roster: 30,
  /* Fighters outside every other group whose page showed a stored photo before
   * this pipeline: reviewed last, but reviewed, so their profile pages can get
   * that photo back. */
  legacy_portrait: 20,
};

/* The strongest reason sets the base; each additional reason adds a little,
 * so a ranked fighter on the next card sorts above either alone. */
export function fighterPriority(reasons: Iterable<QueueReason>): number {
  const uniq = [...new Set(reasons)];
  if (!uniq.length) return 0;
  const top = Math.max(...uniq.map((r) => REASON_WEIGHT[r] ?? 0));
  return Math.min(120, top + 2 * (uniq.length - 1));
}

/* Which fighters the queue covers, and why. Callers gather the raw inputs
 * (rankings snapshot, the next cards' bouts in bout_order desc, the homepage
 * featured ids, the active roster) and this decides the reasons, so the review
 * UI, the coverage report and the generator can never disagree on scope. */
export type ScopeInput = {
  rankings: { divisions: Array<{ is_p4p?: boolean; champion?: { fighter_id?: string | null } | null; entries: Array<{ rank: number; fighter_id?: string | null }> }> } | null;
  /* Index 0 = next card. Bouts ordered main event first. */
  cards: Array<Array<{ fighter_a_id: string; fighter_b_id: string }>>;
  featuredIds: Iterable<string>;
  activeIds: Iterable<string>;
  /* Fighters with a pre-pipeline stored portrait (ufc_images). Optional. */
  legacyIds?: Iterable<string>;
};
export type ScopeEntry = { reasons: QueueReason[]; priority: number };

export function buildScope(input: ScopeInput): Map<string, ScopeEntry> {
  const reasons = new Map<string, Set<QueueReason>>();
  const add = (id: string | null | undefined, r: QueueReason) => {
    if (!id) return;
    if (!reasons.has(id)) reasons.set(id, new Set());
    reasons.get(id)!.add(r);
  };
  for (const d of input.rankings?.divisions || []) {
    if (d.is_p4p) { for (const e of d.entries) add(e.fighter_id, "p4p"); continue; }
    add(d.champion?.fighter_id, "champion");
    for (const e of d.entries) add(e.fighter_id, e.rank <= 5 ? "ranked_top5" : "ranked");
  }
  input.cards.slice(0, 3).forEach((bouts, i) => {
    bouts.forEach((b, j) => {
      const r: QueueReason = i === 0 ? (j === 0 ? "next_card_main_event" : "next_card") : i === 1 ? "card_2" : "card_3";
      add(b.fighter_a_id, r);
      add(b.fighter_b_id, r);
    });
  });
  for (const id of input.featuredIds) add(id, "featured");
  for (const id of input.activeIds) add(id, "active_roster");
  for (const id of input.legacyIds || []) add(id, "legacy_portrait");
  const out = new Map<string, ScopeEntry>();
  for (const [id, set] of reasons) out.set(id, { reasons: [...set], priority: fighterPriority(set) });
  return out;
}

export const RANKED_REASONS: ReadonlySet<QueueReason> = new Set(["champion", "ranked_top5", "ranked"]);
export const NEXT_CARD_REASONS: ReadonlySet<QueueReason> = new Set(["next_card_main_event", "next_card"]);
export const UPCOMING_CARD_REASONS: ReadonlySet<QueueReason> = new Set(["next_card_main_event", "next_card", "card_2", "card_3"]);

/* Candidate order inside the queue: fighter first, then the candidate most
 * likely to be approvable. */
export function candidatePriority(fighterPriorityScore: number, identity: number, suitabilityScore: number, commercial: boolean): number {
  const v = fighterPriorityScore + identity * 10 + suitabilityScore / 20 + (commercial ? 3 : 0);
  return Math.round(v * 100) / 100;
}

/* Refusal reasons in reader language, for the coverage report. */
export const REFUSAL_LABEL: Record<PortraitRefusal, string> = {
  no_asset: "No approved portrait",
  not_approved: "Not approved",
  identity_unverified: "Identity not verified",
  not_primary: "Not the primary portrait",
  never_verified: "Never verified",
  insecure_url: "Non-HTTPS image URL",
  no_provenance: "Missing source",
  missing_attribution: "Attribution required but missing",
  internal_only: "Internal only",
  surface_restricted: "Not cleared for high-visibility surfaces",
  commercial_rights_required: "No commercial-use grant",
  rights_basis_inconsistent: "Commercial flag without a rights basis",
};
