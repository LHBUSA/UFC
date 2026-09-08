import Link from "next/link";
import { buildBoutScorecard, DECISION_LABEL, DRAW_LABEL, wentToTheJudges } from "@/lib/judgeScoring";
import { fmtTime, METHOD_LABEL } from "@/lib/format";

/* The Official Scorecards section.
 *
 * Two states, and the second one matters as much as the first.
 *
 * A decision or draw renders the panel: every judge, both fighters' scores,
 * who each card went to, the decision shape, the dissenting judge where there
 * is one, and the source the card came from.
 *
 * A KO/TKO, submission, DQ or no contest renders an explicit absence. The
 * fight never reached the judges, so there is no card — and saying that in
 * words is the correct rendering. What this component must never do is show a
 * blank grid, a dash where a score would be, or a zero: each of those reads as
 * "we are missing this", and the absence of a scorecard on a finish is not a
 * gap in the archive, it is the result.
 *
 * Where the archive cannot say which number belongs to which fighter — every
 * draw, and a small number of bouts whose cards contradict the recorded
 * winner — the pair is shown as a pair and labelled as unattributed. */

type ResultLike = {
  method: string;
  method_raw: string;
  round: number | null;
  time_sec: number | null;
  winner_id: string | null;
  finish_detail: string | null;
  result_source: string;
  scorecards: Array<{ judge?: string; score?: string }> | null;
};

type FighterLike = { id: string; name: string };

export function OfficialScorecards({ result, a, b, sourceUrl }: { result: ResultLike; a: FighterLike; b: FighterLike; sourceUrl?: string | null }) {
  const sheet = buildBoutScorecard({
    method: result.method, scorecards: result.scorecards, winnerId: result.winner_id,
    fighterAId: a.id, fighterBId: b.id,
  });
  const judged = wentToTheJudges(result.method);
  const sourceLabel = result.result_source === "espn" ? "ESPN" : "UFC Stats";

  /* ---- no scorecard exists ---- */
  if (!sheet.hasOfficialScorecard) {
    const how = `${METHOD_LABEL[result.method] || result.method_raw}${result.finish_detail ? ` (${result.finish_detail})` : ""}`;
    const when = result.round ? `round ${result.round}${result.time_sec != null ? ` at ${fmtTime(result.time_sec)}` : ""}` : null;
    return (
      <section className="segment" id="scorecards">
        <h3>Official scorecards</h3>
        <div className="sc-none">
          <div className="sc-none-mark" aria-hidden="true">—</div>
          <div>
            <b>{judged ? "No scorecard on file for this decision" : "No official scorecard exists for this fight"}</b>
            {judged ? (
              <p>
                This bout reached the judges — {how} — but the archive holds no judges&rsquo; scores for it. That is a coverage gap,
                not an absent decision, and it is tracked in the <Link href="/judges#coverage">scorecard coverage register</Link>. No score is
                estimated here.
              </p>
            ) : (
              <p>
                The fight ended by <strong>{how}</strong>{when ? ` in ${when}` : ""}, so it never went to the judges and no scorecard
                was rendered. Nothing is missing: an official scorecard only exists where a bout goes the distance or is stopped and
                scored. PropBetEdge does not estimate, reconstruct or infer scores for a finish.
              </p>
            )}
            {sourceUrl && <p className="sc-src">Result source · <a href={sourceUrl} target="_blank" rel="noopener">{sourceLabel} ↗</a></p>}
          </div>
        </div>
      </section>
    );
  }

  /* ---- the panel ---- */
  const attributed = sheet.orientationBasis === "derived_from_result";
  const winnerName = result.winner_id === a.id ? a.name : result.winner_id === b.id ? b.name : null;
  const typeLabel = sheet.drawType ? DRAW_LABEL[sheet.drawType] : sheet.decisionType ? DECISION_LABEL[sheet.decisionType] : result.method_raw;
  const notes = sheet.cards.filter((c) => c.cardNote);
  /* Cards that went to the winner: not simply "not a dissent", because a
     level card is neither. A majority decision has one of each. */
  const decidedCards = sheet.cardCount - sheet.dissentCards - sheet.evenCards;

  return (
    <section className="segment" id="scorecards">
      <h3>
        Official scorecards <small>{typeLabel} · {sheet.cardCount} judge{sheet.cardCount === 1 ? "" : "s"}</small>
      </h3>

      <div className="sc-card">
        <div className="sc-head">
          <span className="sc-h-judge">Judge</span>
          {attributed ? (
            <>
              <span className="sc-h-score">{a.name}</span>
              <span className="sc-h-score">{b.name}</span>
            </>
          ) : (
            /* No fighter can head these columns, so the header names the pair
               rather than putting a fighter over a number that may not be
               theirs. */
            <span className="sc-h-score" style={{ gridColumn: "span 2" }}>Score as recorded</span>
          )}
          <span className="sc-h-fav">Card went to</span>
        </div>

        {sheet.cards.map((c) => {
          const favName = c.favoredFighterId === a.id ? a.name : c.favoredFighterId === b.id ? b.name : null;
          const aWins = c.fighterAScore != null && c.fighterBScore != null && c.fighterAScore > c.fighterBScore;
          const bWins = c.fighterAScore != null && c.fighterBScore != null && c.fighterBScore > c.fighterAScore;
          return (
            <div className={`sc-row${c.isDissent ? " dissent" : ""}`} key={`${c.cardIndex}-${c.judge}`}>
              <span className="sc-judge">
                <Link href={`/judges/${c.judgeSlug}`}>{c.judge}</Link>
                {c.cardNote && <em className="sc-note">{c.cardNote}</em>}
              </span>
              {attributed ? (
                <>
                  <b className={`sc-score${aWins ? " hi" : ""}`}>{c.fighterAScore}</b>
                  <b className={`sc-score${bWins ? " hi" : ""}`}>{c.fighterBScore}</b>
                </>
              ) : (
                <b className="sc-score pair" style={{ gridColumn: "span 2" }}>{c.scoreFirst} – {c.scoreSecond}</b>
              )}
              <span className="sc-fav">
                {/* A level card is level whichever fighter holds which
                    number, so it stays readable even when the pair cannot be
                    attributed. Only a card with a winner needs orientation. */}
                {c.isEvenCard ? <em>Even card</em>
                  : !attributed ? <em className="sc-unattributed">Unattributed</em>
                  : <>{favName}{c.isDissent ? <span className="sc-flag">Dissent</span> : null}</>}
              </span>
            </div>
          );
        })}

        {attributed && sheet.fighterATotal != null && (
          <div className="sc-row total">
            <span className="sc-judge">Totals <em className="sc-note">across {sheet.cardCount} card{sheet.cardCount === 1 ? "" : "s"}</em></span>
            <b className="sc-score">{sheet.fighterATotal}</b>
            <b className="sc-score">{sheet.fighterBTotal}</b>
            <span className="sc-fav">{winnerName ? `${winnerName} won` : "Draw"}</span>
          </div>
        )}
      </div>

      <div className="sc-reads">
        <p>
          <strong>{typeLabel}.</strong>{" "}
          {sheet.decisionType === "draw"
            ? `Neither fighter took the bout${sheet.evenCards ? `; ${sheet.evenCards} of ${sheet.cardCount} cards were level` : ""}. With no winner on record the archive cannot say which number on each card belongs to which fighter, so both are shown exactly as stored.`
            : `${decidedCards === sheet.cardCount ? "Every judge" : `${decidedCards} of ${sheet.cardCount} judges`} scored the bout for ${winnerName || "the winner"}${sheet.evenCards ? `, and ${sheet.evenCards} card${sheet.evenCards === 1 ? " was" : "s were"} level` : ""}${sheet.dissentCards ? `; ${sheet.dissentingJudges.join(" and ")} had it for ${result.winner_id === a.id ? b.name : a.name}` : ""}.`}
        </p>

        {sheet.orientationBasis === "unresolved_conflicting_cards" && (
          <p className="sc-warn">
            The stored cards do not add up to the recorded result for this bout, so no card can be assigned to a fighter with
            confidence. The scores are shown as recorded and left unattributed rather than guessed.
          </p>
        )}
        {sheet.cardShapeMatchesMethod === false && (
          <p className="sc-warn">
            The card shape and the recorded method disagree: this is stored as a {result.method_raw.toLowerCase()} but the cards read{" "}
            {sheet.cardCount - sheet.dissentCards - sheet.evenCards}–{sheet.dissentCards}
            {sheet.evenCards ? ` with ${sheet.evenCards} level card` : ""}. Both are shown as the source holds them; neither has been
            silently corrected.
          </p>
        )}
        {sheet.cardCount < 3 && (
          <p className="sc-warn">
            Only {sheet.cardCount} of the three official cards is held for this bout. The missing card is not reconstructed, and the
            totals above cover the cards shown.
          </p>
        )}
        {notes.length > 0 && (
          <p className="sc-warn">
            {notes.length === 1 ? "A point deduction was recorded on this bout" : "Point deductions were recorded on this bout"}:{" "}
            {notes.map((n) => n.cardNote).join("; ")}. The upstream source stored that note against the judge&rsquo;s name; it is a
            property of the fight, not of the official.
          </p>
        )}
        <p className="sc-src">
          Scorecards as recorded by {sourceLabel}
          {sourceUrl ? <> · <a href={sourceUrl} target="_blank" rel="noopener">source ↗</a></> : null}
          {" "}· fighter attribution derived from the recorded result, not assumed from score order ·{" "}
          <Link href="/judges#methodology">how this is built</Link>
        </p>
      </div>
    </section>
  );
}
