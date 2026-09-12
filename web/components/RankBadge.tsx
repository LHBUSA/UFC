import { type FighterRankingContext, type RankDisplay, rankForDivision, rankStack, bestRank } from "@/lib/rankingContext";

/* The one ranking badge.
 *
 * Two jobs, and the second is the reason it exists: render the rank, and make
 * it impossible to render a misleading one. A pound-for-pound standing always
 * carries its label, a champion is "C" and never "#0", and a fighter with no
 * ranking renders NOTHING — no empty chip, no "#—", because an empty badge
 * reads as missing data when the truth is simply that the fighter is unranked.
 */

function chipClass(kind: RankDisplay["kind"]): string {
  return kind === "champion" ? "rkb rkb-c" : kind === "p4p" ? "rkb rkb-p" : "rkb";
}

/** One chip. Null renders nothing at all. */
export function RankChip({ rank, title }: { rank: RankDisplay | null; title?: string }) {
  if (!rank) return null;
  return (
    <span className={chipClass(rank.kind)} title={title ?? rank.full} aria-label={rank.full}>
      {rank.compact}
    </span>
  );
}

/**
 * Bout-aware badge: champion of THIS division, else rank in THIS division,
 * else a labelled P4P standing. `secondary` adds the P4P chip alongside, for
 * surfaces with room (a fight hero); compact lists leave it off.
 */
export function FighterRank({
  ctx, division, showSecondary = false,
}: {
  ctx: FighterRankingContext | undefined | null;
  division: { key: string | null; isWomens: boolean };
  showSecondary?: boolean;
}) {
  const { primary, secondary } = rankForDivision(ctx, division);
  if (!primary && !(showSecondary && secondary)) return null;
  return (
    <span className="rkb-set">
      <RankChip rank={primary} />
      {showSecondary && secondary && primary?.kind !== "p4p" && <RankChip rank={secondary} />}
    </span>
  );
}

/** Division-free badge, for a directory card or a search row. */
export function BestRank({ ctx }: { ctx: FighterRankingContext | undefined | null }) {
  return <RankChip rank={bestRank(ctx)} />;
}

/**
 * The full stack, for a fighter profile. Every current ranking identity with
 * its division named, plus the snapshot date so "currently #4" is always
 * attached to the date it was true.
 */
export function RankStack({ ctx }: { ctx: FighterRankingContext | undefined | null }) {
  const rows = rankStack(ctx);
  if (!rows.length || !ctx) return null;
  return (
    <div className="rkstack">
      <div className="rkstack-h">Current UFC rankings</div>
      <ul>
        {rows.map((r, i) => (
          <li key={`${r.kind}-${r.divisionLabel}-${i}`}>
            <span className={chipClass(r.kind)}>{r.kind === "champion" ? "C" : `#${r.rank}`}</span>
            <span className="rkstack-l">{r.kind === "champion" ? `${r.divisionLabel} Champion` : r.divisionLabel}</span>
            {r.isNew
              ? <em className="rkstack-m rkstack-new">New</em>
              : r.change
                ? <em className={`rkstack-m ${r.change > 0 ? "rkstack-up" : "rkstack-down"}`}>{r.change > 0 ? `▲ ${r.change}` : `▼ ${Math.abs(r.change)}`}</em>
                : null}
          </li>
        ))}
      </ul>
      <small className="rkstack-s">
        Official UFC rankings · snapshot <time dateTime={ctx.snapshotDate}>{ctx.snapshotDate}</time>
      </small>
    </div>
  );
}
