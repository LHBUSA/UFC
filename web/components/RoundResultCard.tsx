/* One completed fight, as a premium result card.
 *
 * WHAT THIS COMPONENT IS ALLOWED TO SAY
 * -------------------------------------
 * Only what is stored. Every field below renders if and only if it is present:
 * a null referee produces no "Referee:" label, an empty scorecard set produces
 * no scorecard block, and a bout with no round rows gets no pips, no counts
 * and no link into the round experience. Absent data is absent, never an empty
 * label and never a placeholder.
 *
 * Two facts are kept visibly apart, as everywhere else in this feature:
 *   OFFICIAL RESULT     ESPN — the bout is final, with method/round/time
 *   ROUND INTELLIGENCE  UFC Stats — its round observations have landed
 *
 * Nothing here is in-fight telemetry. No current round, no live strikes, no
 * clock. Those sources do not exist and none is invented.
 *
 * Progressive disclosure is a native <details>: keyboard accessible, works
 * without JS, and cannot desynchronise from the server render on a 90-second
 * refresh the way a useState accordion would.
 */
import Link from "next/link";
import { Avatar } from "@/components/ui";
import { fmtRecord, METHOD_LABEL, weightClassLabel, fmtTime } from "@/lib/format";
import { matchupSlug } from "@/lib/slug";
import type { PortraitSet } from "@/lib/db";
import type { TonightBout } from "@/lib/roundLive";
import styles from "@/app/round-by-round/round-live.module.css";

export function RoundResultCard({
  entry, images, eventName, eventDate, latest = false,
}: {
  entry: TonightBout;
  images: Map<string, PortraitSet>;
  eventName: string;
  eventDate: string | null;
  latest?: boolean;
}) {
  const { bout, coverage, roundReady, scorecard } = entry;
  const r = bout.result;
  const a = bout.fighter_a;
  const b = bout.fighter_b;
  const winnerId = r?.winner_id ?? null;
  const winner = winnerId === a.id ? a : winnerId === b.id ? b : null;
  const loser = winner ? (winner.id === a.id ? b : a) : null;

  const method = r?.method ? METHOD_LABEL[r.method] ?? r.method : null;

  /* "R1 · 4:25" is ambiguous: a reader cannot tell elapsed from remaining.
   *
   * ESPN's displayClock — the value behind time_sec — is ELAPSED. Verified
   * against UFC.com's published results for this card (0:36, 2:46 and 4:25 all
   * match exactly) and across 34 completed bouts on three prior cards, where
   * every decision reads exactly 5:00 at the final round; under a remaining
   * clock a decision would read 0:00. So the number is right and only the
   * label was unclear.
   *
   * A bout that went to the judges did not "finish" at 5:00 — it completed its
   * scheduled rounds, so it says that instead of implying a stoppage. */
  const decided = scorecard?.wentToTheJudges ?? false;
  const roundLine = decided
    ? (r?.round ? `Completed ${r.round} round${r.round === 1 ? "" : "s"}` : null)
    : r?.round
      ? (r.time_sec != null
        ? `Finish: ${fmtTime(r.time_sec)} of Round ${r.round}`
        : `Round ${r.round}`)
      : null;
  const wc = weightClassLabel(bout.weight_class, bout.is_womens);

  /* Scorecards only where the bout actually went to the judges AND cards are
   * stored. buildBoutScorecard already encodes that rule; this never second
   * guesses it, and never renders an empty block. */
  const cards = scorecard?.hasOfficialScorecard ? scorecard.cards : [];
  const showScorecards = cards.length > 0;

  /* The expander only exists when there is something behind it. */
  const hasDetail = Boolean(r?.referee || r?.finish_detail || showScorecards || roundReady);

  const href = `/fights/${matchupSlug(a, b, { name: eventName, event_date: eventDate })}`;

  const corner = (f: typeof a, isWinner: boolean) => {
    const img = images.get(f.id);
    return (
      <div className={styles.corner} data-win={isWinner ? "true" : undefined}>
        <span className={styles.cornerPortrait}>
          <Avatar f={f} img={img} size={72} className={styles.cornerAvatar} />
        </span>
        <span className={styles.cornerName}>
          <b>{f.name}{isWinner ? <i className={styles.tick} aria-label="winner"> ✓</i> : null}</b>
          <small>{fmtRecord(f)}</small>
        </span>
      </div>
    );
  };

  return (
    <li className={styles.resultCard} data-latest={latest ? "true" : undefined} data-pending={roundReady ? undefined : "true"}>
      <div className={styles.chips}>
        {latest && <span className={styles.chipLatest}>Latest</span>}
        <span className={styles.chipOfficial}>Official result</span>
        {showScorecards && <span className={styles.chipCards}>Scorecards available</span>}
        <span className={roundReady ? styles.chipReady : styles.chipPending}>
          {roundReady ? "Round intelligence ready" : "Round data pending"}
        </span>
        {wc && <span className={styles.chipMeta}>{wc}</span>}
        {bout.is_title && <span className={styles.chipTitle}>Title</span>}
      </div>

      <div className={styles.bout}>
        {corner(a, winner?.id === a.id)}

        <div className={styles.verdict}>
          {winner && loser ? (
            <p className={styles.decision}>
              <b>{winner.name}</b>
              <span>def. {loser.name}</span>
            </p>
          ) : (
            <p className={styles.decision}><b>{method ?? "Result recorded"}</b><span>no winner declared</span></p>
          )}
          {method && <p className={styles.method}>{method}</p>}
          {roundLine && <p className={styles.clock}>{roundLine}</p>}
          {r?.result_source && <p className={styles.source}>Source: {r.result_source.toUpperCase()}</p>}
        </div>

        {corner(b, winner?.id === b.id)}
      </div>

      {hasDetail && (
        <details className={styles.detail}>
          <summary className={styles.summary}>
            <span>Fight detail</span>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>

          <div className={styles.detailIn}>
            {(r?.referee || r?.finish_detail || r?.time_format || (!decided && r?.time_sec != null)) && (
              <dl className={styles.facts}>
                {!decided && r?.time_sec != null && r?.round && (
                  <><dt>Finish time</dt><dd>{fmtTime(r.time_sec)} elapsed in Round {r.round}</dd></>
                )}
                {r?.referee && (<><dt>Referee</dt><dd>{r.referee}</dd></>)}
                {r?.finish_detail && (<><dt>Finish</dt><dd>{r.finish_detail}</dd></>)}
                {r?.time_format && (<><dt>Format</dt><dd>{r.time_format}</dd></>)}
              </dl>
            )}

            {showScorecards && (
              <div className={styles.cards}>
                <span className={styles.cardsHead}>Official scorecards</span>
                <ul>
                  {cards.map((c) => (
                    <li key={c.cardIndex}>
                      {/* Judge names link only where the archive can resolve a
                          profile slug for them. */}
                      {c.judgeSlug
                        ? <Link href={`/judges/${c.judgeSlug}`}>{c.judge}</Link>
                        : <span>{c.judge}</span>}
                      <b>{c.rawScore}</b>
                    </li>
                  ))}
                </ul>
                {scorecard?.decisionType && <span className={styles.cardsFoot}>{scorecard.decisionType.replace(/_/g, " ")}</span>}
              </div>
            )}

            {roundReady && coverage ? (
              <div className={styles.roundBlock}>
                <span className={styles.roundHead}>Round intelligence ready</span>
                <span className={styles.pips} aria-hidden="true">
                  {Array.from({ length: Math.max(1, coverage.rounds) }, (_, n) => <i key={n} />)}
                </span>
                <b>{coverage.rounds} round{coverage.rounds === 1 ? "" : "s"} recorded</b>
                <em>{coverage.bothCorners ? "Both corners verified" : "One-corner coverage"}</em>
                <Link href={href} className={styles.roundLink}>Open round intelligence →</Link>
              </div>
            ) : (
              <div className={styles.roundBlock} data-pending="true">
                <span className={styles.roundHead}>Round intelligence</span>
                <em>Pending official round observations</em>
              </div>
            )}
          </div>
        </details>
      )}

      {!hasDetail && (
        <div className={styles.pendingFoot}>
          <b>Round intelligence</b>
          <em>Pending official round observations</em>
        </div>
      )}
    </li>
  );
}
