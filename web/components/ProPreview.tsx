import Link from "next/link";
import { unlockHref, type UfcAccess } from "@/lib/accessDecision";

/* The compact UFC Pro preview that sits where a premium module belongs.
 *
 * It describes the locked capability and nothing else: it receives no
 * premium data, so there is no value to render, serialize, blur or hide. The
 * page decided entitlement before fetching; a free reader's render never had
 * the numbers in the first place. */

export type ProFeature = "fight_dna" | "matchup_dna" | "round_intelligence" | "market" | "fight_week" | "officials" | "article_intel" | "algo" | "picks";

const COPY: Record<ProFeature, { title: string; body: string }> = {
  fight_dna: {
    title: "Unlock Fight DNA",
    body: "The fighter's versioned Fight DNA profile: striking geography, grappling efficiency, pace, finish patterns and archetype, each with sample size and confidence.",
  },
  matchup_dna: {
    title: "Unlock Matchup DNA",
    body: "Side-by-side Fight DNA for this pairing, with the matchup insights, confidence and evidence behind each edge.",
  },
  round_intelligence: {
    title: "Unlock Round Intelligence",
    body: "Round-over-round signals, statistical edges and this performance measured against each fighter's pre-fight Fight DNA baseline. Round statistics above stay free.",
  },
  market: {
    title: "Unlock Market Intelligence",
    body: "Consensus and best available prices, book range and line movement since first observed for this bout.",
  },
  fight_week: {
    title: "Unlock Fight-Week Intelligence",
    body: "Fight DNA reads folded into the fight-week desk: style collision and how the fight changes if it goes long.",
  },
  officials: {
    title: "Unlock Officials Intelligence",
    body: "Tendency reads measured against the archive baseline, with method and round distributions and dissent significance.",
  },
  algo: {
    title: "Unlock the PBE Algo call",
    body: "The PBE Algo pick for this fight: win probability, confidence, data quality, the market-implied probability and the PBE delta, plus the model's own drivers for and against. Locked on the database clock before the fight and graded after it.",
  },
  picks: {
    title: "Unlock PBE Picks with UFC Pro",
    body: "Every official PBE Pick on the upcoming UFC cards: the selected fighter, win probability, confidence, data quality, the market-implied probability and PBE edge where a current market exists, the model's own drivers for and against, and the exact reason for every bout the model passes on.",
  },
  article_intel: {
    title: "Unlock the Pro modules in this story",
    body: "The Fight DNA, market and bettor-angle modules built for this story. The reporting stays free.",
  },
};

export function ProPreview({ feature, access, returnPath, compact = false, id }: {
  feature: ProFeature;
  access: Pick<UfcAccess, "signedIn">;
  returnPath: string | null;
  compact?: boolean;
  id?: string;
}) {
  const copy = COPY[feature];
  return (
    <aside id={id} className={`pro-preview${compact ? " compact" : ""}`} aria-label={`UFC Pro: ${copy.title}`} data-pro-feature={feature}>
      <div className="pro-preview-copy">
        <div className="eyebrow">UFC Pro</div>
        <div className="pro-preview-title">{copy.title}</div>
        {!compact && <p>{copy.body}</p>}
      </div>
      <Link href={unlockHref(access, returnPath)} className="btn gold pro-preview-cta">Unlock UFC Pro</Link>
    </aside>
  );
}
