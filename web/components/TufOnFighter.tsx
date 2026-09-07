import Link from "next/link";
import { nonProfessionalAppearances, tufSeasonsFor } from "@/lib/tuf";

/* The Ultimate Fighter on a fighter profile.
 *
 * Deliberately its own section, below the fight history and visually apart
 * from it. These bouts are not part of the professional record and the page
 * says so in words rather than relying on a reader to infer it from a badge:
 * a fighter's record above is 12-3 whether or not they went 4-0 in the house,
 * and the two must never look like one list.
 *
 * Renders nothing at all when a fighter has no TUF history, so every other
 * profile on the site is untouched. */
export function TufOnFighter({ name }: { name: string }) {
  const appearances = nonProfessionalAppearances(name);
  const seasonsAsCoachOrContestant = tufSeasonsFor(name);
  if (!appearances.length && !seasonsAsCoachOrContestant.length) return null;

  return (
    <section className="segment tuf-fighter">
      <h3>
        The Ultimate Fighter{" "}
        <small>
          {seasonsAsCoachOrContestant.length
            ? `${seasonsAsCoachOrContestant.length} season${seasonsAsCoachOrContestant.length === 1 ? "" : "s"}`
            : "appearances"}
        </small>
      </h3>

      {seasonsAsCoachOrContestant.length > 0 && (
        <ul className="tuf-people" style={{ marginBottom: "var(--s-4)" }}>
          {seasonsAsCoachOrContestant.map((r) => (
            <li key={`${r.season.slug}-${r.role}`}>
              <Link className="tuf-name is-linked" href={`/tuf/${r.season.slug}`}>
                {r.season.name}
              </Link>
              <small>
                {r.role === "coach" ? "Coach" : r.role === "champion" ? "Tournament winner" : "Contestant"}
                {r.team ? ` · ${r.team}` : ""}
                {r.weight_class ? ` · ${r.weight_class}` : ""}
              </small>
            </li>
          ))}
        </ul>
      )}

      {appearances.length > 0 && (
        <>
          <p className="tuf-fighter-note">
            <b>Not part of the professional record.</b> These bouts were contested inside the TUF house rather than on a
            sanctioned card, so they are shown here and excluded from the record and every stat aggregate above. Where a
            bout&rsquo;s status could not be established it is marked unverified, and unverified is excluded too.
          </p>
          <ul className="tuf-bouts">
            {appearances.map(({ season, bout }, i) => {
              const opponent = bout.a === name ? bout.b : bout.a;
              const won = bout.winner === name;
              return (
                <li className="tuf-bout" key={`${season.slug}-${i}`}>
                  <span className="tuf-bout-names">
                    <span className={`tuf-res ${won ? "" : "tuf-none"}`}>
                      <b>{bout.winner ? (won ? "Win" : "Loss") : "—"}</b>
                    </span>
                    <em>vs</em>
                    <span className="tuf-name">{opponent}</span>
                  </span>
                  <span className="tuf-bout-meta">
                    <span className="tuf-res">
                      {bout.method || "Method unavailable"}
                      {bout.round ? ` · R${bout.round}` : ""}
                    </span>
                    <span className={`tuf-class tuf-class-${bout.classification}`}>
                      {bout.classification === "exhibition" ? "Exhibition" : "Unverified"}
                    </span>
                    <Link className="tuf-ep" href={`/tuf/${season.slug}`}>
                      S{season.number} · {bout.stage.replace(/_/g, " ")}
                    </Link>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
