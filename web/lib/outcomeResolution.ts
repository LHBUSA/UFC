/* Contender Series outcome display gate — pure, no I/O, testable.
 *
 *   SOURCE CLAIM  !=  CANONICAL FACT  !=  DISPLAY RESOLUTION
 *
 * A row in ufc_dwcs_outcome_claims is evidence: a sentence, from a source,
 * naming a fighter. It is never shown on its own. An outcome is public only
 * when an operator has recorded an APPROVED row in
 * ufc_dwcs_outcome_resolutions that selects an eligible official claim for
 * the same fighter, event and outcome type. The database enforces the same
 * rules (migration 20260913000006); this repeats them at the last step before
 * render so a wrong read — a stale view, a widened query — still shows nothing.
 *
 * A win is never an input here. Nothing about a bout result can create an
 * outcome; absence of an outcome is absence, never "no contract". */

export type OutcomeClaimType = "contract_awarded" | "developmental_deal" | "tuf_invite" | "other_opportunity";

export type OutcomeClaimRow = {
  id: string; fighter_id: string; event_id: string; bout_id: string | null;
  claim_type: OutcomeClaimType; claim_status: string;
  source_url: string; source_title: string | null; source_date: string | null;
  source_family: string; source_excerpt_short: string | null;
};

export type OutcomeResolutionRow = {
  id: string; fighter_id: string; event_id: string; claim_type: OutcomeClaimType;
  selected_claim_id: string; resolution_status: string; resolution_rule: string;
  resolved_by: string; reviewed_at: string;
};

/** What a page may render: one per approved resolution. */
export type PublicOutcome = {
  id: string; fighter_id: string; event_id: string; bout_id: string | null;
  claim_type: OutcomeClaimType;
  source_url: string; source_title: string | null; source_date: string | null;
  source_family: string; source_excerpt_short: string | null;
  resolved_by: string; reviewed_at: string;
};

export const CLAIM_LABEL: Record<OutcomeClaimType, string> = {
  contract_awarded: "Contract awarded",
  developmental_deal: "Developmental deal",
  tuf_invite: "TUF invite",
  other_opportunity: "UFC opportunity",
};

const OFFICIAL = "ufc.com";

export function resolvePublicOutcomes(claims: OutcomeClaimRow[], resolutions: OutcomeResolutionRow[]): PublicOutcome[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: PublicOutcome[] = [];
  for (const r of resolutions) {
    if (r.resolution_status !== "approved" || r.resolution_rule !== "operator_decision" || !r.resolved_by) continue;
    const c = byId.get(r.selected_claim_id);
    if (!c) continue;
    /* The decision must be about exactly this claim's fighter, event and outcome. */
    if (c.fighter_id !== r.fighter_id || c.event_id !== r.event_id || c.claim_type !== r.claim_type) continue;
    /* Only eligible official evidence is displayable; ESPN, review and conflicted never are. */
    if (c.source_family !== OFFICIAL || c.claim_status !== "eligible") continue;
    const key = `${r.fighter_id}|${r.event_id}|${r.claim_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id, fighter_id: c.fighter_id, event_id: c.event_id, bout_id: c.bout_id, claim_type: c.claim_type,
      source_url: c.source_url, source_title: c.source_title, source_date: c.source_date,
      source_family: c.source_family, source_excerpt_short: c.source_excerpt_short,
      resolved_by: r.resolved_by, reviewed_at: r.reviewed_at,
    });
  }
  return out;
}

export function groupByFighter(outcomes: PublicOutcome[]): Map<string, PublicOutcome[]> {
  const m = new Map<string, PublicOutcome[]>();
  for (const o of outcomes) m.set(o.fighter_id, [...(m.get(o.fighter_id) || []), o]);
  return m;
}

/** Fighters with at least one resolved public contract. */
export function resolvedContractCount(byFighter: Map<string, PublicOutcome[]>): number {
  let n = 0;
  for (const list of byFighter.values()) if (list.some((o) => o.claim_type === "contract_awarded")) n += 1;
  return n;
}

/** The alumni "Contract awarded" filter exists only when a resolved public contract exists. */
export const contractFilterAvailable = (byFighter: Map<string, PublicOutcome[]>): boolean => resolvedContractCount(byFighter) > 0;
