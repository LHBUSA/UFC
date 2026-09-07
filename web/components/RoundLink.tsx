import Link from "next/link";
import { isEligible, type RoundCoverage } from "@/lib/roundIndex";

/* The one entry point into Round-by-Round Analysis from anywhere else.
 *
 * It renders nothing when the bout has no stored round observations. There is
 * deliberately no disabled state: a greyed-out link advertises a feature the
 * archive cannot deliver for that fight, which is worse than saying nothing.
 *
 * `source` records which surface a reader came from, so we can find out
 * whether the feature is actually being discovered rather than guessing.
 */
export function RoundLink({
  href,
  coverage,
  source,
  variant = "link",
}: {
  href: string;
  coverage: RoundCoverage | null | undefined;
  source: "fight_week" | "event_page" | "fighter_history" | "fight_detail";
  variant?: "link" | "badge";
}) {
  if (!isEligible(coverage)) return null;
  const n = coverage!.rounds;
  const rounds = `${n} round${n === 1 ? "" : "s"} available`;

  if (variant === "badge") {
    return (
      <Link href={`${href}#round-by-round`} className="rl-badge" data-rba-source={source} title={`Round-by-Round Analysis · ${rounds}`}>
        <b>Round-by-Round</b>
        <span>{rounds}</span>
      </Link>
    );
  }
  return (
    <Link href={`${href}#round-by-round`} className="rl-link" data-rba-source={source}>
      Round-by-Round Analysis →
    </Link>
  );
}
