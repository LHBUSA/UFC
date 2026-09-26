import type { ReactNode } from "react";
import { monthYear, startLabel, yearSpan, type TrainingPayload } from "@/lib/training";
import { fmtDate } from "@/lib/format";
import s from "./TrainingCorner.module.css";

/* Training & Corner on the fighter profile (migration 032).
 *
 * Only facts on file render; an empty row is never drawn and nothing is
 * filled in. Customer-facing attribution is PropSports (network convention);
 * upstream provenance stays in the database and the API. Cited manual facts
 * link to the page they were read from; captured affiliations show their
 * capture dates instead. */

const MANUAL = "ufc_training_manual";

function hasAnything(t: TrainingPayload) {
  return Boolean(t.current_camp || t.fighting_out_of || t.training_location || t.coaches.length || t.other_camps.length || t.camp_history.length);
}

export function TrainingCorner({ training: t, fighterName }: { training: TrainingPayload; fighterName: string }) {
  if (!hasAnything(t)) return null;
  const latest = t.changes.find((c) => c.kind === "CAMP_CHANGED_CONFIRMED" || c.kind === "AFFILIATION_CHANGED_OBSERVED") || null;
  const cc = t.current_camp;
  return (
    <section className="segment" id="training" data-testid="training-corner">
      <h3>Training &amp; Corner <small>{fighterName}</small></h3>
      <div className={s.panel}>
        <dl className={s.facts}>
          {cc && (
            <>
              <dt>Current camp</dt>
              <dd data-testid="training-current-camp">
                <span className={s.camp}>{cc.name}</span>
                <span className={s.meta}>{startLabel({ joined_on: cc.since.kind === "joined" ? cc.since.date : null, first_observed_at: cc.first_observed_at, certainty: cc.certainty })}</span>
              </dd>
            </>
          )}
          {t.fighting_out_of?.label && (<><dt>Fighting out of</dt><dd data-testid="training-fighting-out-of">{t.fighting_out_of.label}</dd></>)}
          {t.training_location?.label && (
            <>
              <dt>Training base</dt>
              <dd data-testid="training-location">{t.training_location.label}{t.training_location.camp_name ? <span className={s.meta}>{t.training_location.camp_name}</span> : null}</dd>
            </>
          )}
          {t.coaches.length > 0 && (
            <>
              <dt>Coaches</dt>
              <dd>
                <ul className={s.list} data-testid="training-coaches">
                  {t.coaches.map((c) => (
                    <li key={`${c.coach_id}:${c.role}`}>{c.name} <span className={s.meta}>· {c.role_label}{c.since ? ` · since ${monthYear(c.since)}` : ""}</span></li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {t.other_camps.length > 0 && (
            <>
              <dt>Also trains at</dt>
              <dd>
                <ul className={s.list}>
                  {t.other_camps.map((c) => (
                    <li key={`${c.camp_id}:${c.relationship_type}`}>{c.name} <span className={s.meta}>· {c.relationship_label}{c.since ? ` · since ${monthYear(c.since)}` : ""}</span></li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>

        {latest && (
          <p className={s.change} data-testid="training-latest-change">
            {latest.kind === "CAMP_CHANGED_CONFIRMED"
              ? <><b>{latest.previous_value ? "Switched camps" : "Joined"}</b> {latest.previous_value ? `${latest.previous_value} → ${latest.new_value}` : latest.new_value}{latest.effective_on ? ` · ${fmtDate(latest.effective_on, { month: "short", day: "numeric", year: "numeric" })}` : ""}</>
              : <><b>Camp affiliation changed</b> First observed at {latest.new_value} on {fmtDate(latest.observed_at.slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}</>}
          </p>
        )}

        {t.camp_history.length > 1 && (
          <div className={s.history} data-testid="training-camp-history">
            <div className="eyebrow dim">Camp history</div>
            <ol className={s.timeline}>
              {t.camp_history.map((h, i) => (
                <li key={`${h.camp_id}:${i}`} className={h.is_current ? s.now : undefined}>
                  <span className={s.years}>{yearSpan(h.from, h.to)}</span>
                  <span className={s.camp}>{h.name}</span>
                  <span className={s.meta}>
                    {h.from.kind === "joined" ? "Joined" : "First observed"} {monthYear(h.from.date)}
                    {h.to ? ` · ${h.to.kind === "left" ? "left" : "observed through"} ${monthYear(h.to.date)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
            <details className={s.sources}>
              <summary>How these dates are known</summary>
              <ul>
                {t.camp_history.map((h, i) => (
                  <li key={`src:${h.camp_id}:${i}`}>
                    <b>{h.name}</b>{" "}
                    {h.sources.map((src, j) => src.source_key === MANUAL
                      ? <a key={j} href={src.source_url} rel="nofollow noopener" target="_blank">cited source ({fmtDate(src.captured_at.slice(0, 10), { month: "short", year: "numeric" })})</a>
                      : <span key={j}>PropSports capture, first observed {fmtDate(src.captured_at.slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}</span>)
                      .reduce<ReactNode[]>((acc, n, k) => (k ? [...acc, " · ", n] : [n]), [])}
                  </li>
                ))}
              </ul>
              <p>&quot;First observed&quot; is when our capture first saw the affiliation, not a join date. &quot;Joined&quot; is shown only when a cited source states it.</p>
            </details>
          </div>
        )}

        <p className={s.credit}>Data source · PropSports{t.updated_at ? ` · updated ${fmtDate(t.updated_at.slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}` : ""}</p>
      </div>
    </section>
  );
}

/* NEW CAMP SINCE LAST UFC BOUT, inside an upcoming matchup. Rendered only when
 * lib/training.ts proves the chronology; no claim about what it means. */
export function NewCampNote({ note, fighterName }: { note: TrainingPayload["new_camp_since_last_bout"]; fighterName: string }) {
  if (!note) return null;
  const since = note.to.since.kind === "joined"
    ? `joined ${fmtDate(note.to.since.date, { month: "short", day: "numeric", year: "numeric" })}`
    : `affiliation first observed ${fmtDate(note.to.since.date, { month: "short", day: "numeric", year: "numeric" })}`;
  return (
    <p className="bout-note" data-testid="new-camp-since-last-bout">
      <b>New camp since last UFC bout.</b> {fighterName}: {note.from.name} → {note.to.name} ({since}; last UFC bout {fmtDate(note.last_bout_date, { month: "short", day: "numeric", year: "numeric" })}).
    </p>
  );
}
