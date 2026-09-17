export type EvidenceOmission = { id: string; reason?: string };

export type EditorialEvidenceInput = {
  gate?: { ok?: boolean; green_path?: boolean };
  sourceLinked?: boolean;
  chartCount?: number;
  oddsStatus?: string;
  modelStatus?: string;
  dataFamilies?: string[];
  corroborationCount?: number;
  omitted?: EvidenceOmission[];
};

export type EvidenceBadge = {
  label: string;
  tone: "verified" | "neutral";
};

const LIMITATION_BY_MODULE: Record<string, string> = {
  fighter_comparison: "A verified two-fighter comparison was not available for this story.",
  fight_dna: "Fight DNA was not included because the required first-party coverage was incomplete.",
  market_snapshot: "No verified market snapshot was attached when this analysis was published.",
  recent_form: "Verified recent-form coverage was not sufficient for this story.",
  round_style_stats: "Verified round-level coverage was not sufficient for this story.",
};

const QUALITATIVE_LIMIT =
  "PropBetEdge cannot independently observe undisclosed injuries, private camp conditions, late game-plan changes, or a fighter’s current physical condition. Those factors enter an article only when a named, timestamped source reports them.";

export function buildEditorialEvidence(input: EditorialEvidenceInput) {
  const gateVerified = input.gate?.ok === true || input.gate?.green_path === true;
  const chartCount = Number.isFinite(input.chartCount) ? Math.max(0, Math.floor(input.chartCount || 0)) : 0;
  const familyCount = input.dataFamilies?.filter(Boolean).length || 0;
  const corroborationCount = Math.max(0, Math.floor(input.corroborationCount || 0));

  const badges: EvidenceBadge[] = [{ label: "Automated editorial", tone: "neutral" }];
  if (gateVerified) badges.unshift({ label: "Fact packet verified", tone: "verified" });
  if (input.sourceLinked === true) badges.push({ label: "Source linked", tone: "verified" });
  if (chartCount > 0) badges.push({ label: "Data-drawn charts", tone: "verified" });

  const receipts: string[] = [];
  if (input.sourceLinked === true) receipts.push("Original report linked");
  if (familyCount > 0) receipts.push(`${familyCount} first-party data ${familyCount === 1 ? "family" : "families"} attached`);
  if (corroborationCount > 0) receipts.push(`${corroborationCount} corroborating ${corroborationCount === 1 ? "report" : "reports"} linked`);
  if (chartCount > 0) receipts.push(`${chartCount} ${chartCount === 1 ? "chart" : "charts"} drawn from the fact packet`);
  if (input.oddsStatus === "available") receipts.push("Timestamped odds snapshot attached");
  if (input.modelStatus === "available") receipts.push("Model output attached");

  const limitations = [QUALITATIVE_LIMIT];
  const seen = new Set<string>();
  for (const omission of input.omitted || []) {
    const message = LIMITATION_BY_MODULE[omission.id];
    if (message && !seen.has(message)) {
      limitations.push(message);
      seen.add(message);
    }
  }
  if (input.oddsStatus !== "available" && !seen.has(LIMITATION_BY_MODULE.market_snapshot)) {
    limitations.push(LIMITATION_BY_MODULE.market_snapshot);
  }

  return { badges, receipts, limitations, gateVerified };
}
