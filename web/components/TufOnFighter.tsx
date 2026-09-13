import Link from "next/link";
import { nonProfessionalAppearances, tufSeasonsForFighter, type TufRole } from "@/lib/tuf";

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
const ROLE_LABEL: Record<TufRole, string> = {
  coach: "Head coach",
  assistant_coach: "Assistant coach",
  guest_coach: "Guest coach",
  contestant: "Contestant",
  champion: "Tournament winner",
};

/* By canonical fighter id. Matching the profile's name against the archive's
 * printed names missed every accented spelling, so Julianna Peña's profile had
 * no TUF history at all. */
export function TufOnFighter({ fighterId }: { fighterId: string }) {
  const appearances = nonProfessionalAppearances(fighterId);
  const seasonsAsCoachOrContestant = tufSeasonsForFighter(fighterId);
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
                {ROLE_LABEL[r.role]}
                {r.team ? ` · ${r.team}` : ""}
                {r.discipline ? ` · ${r.discipline}` : ""}
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
            {appearances.map(({ season, bout, side }, i) => {
              const printed = side === "a" ? bout.a : bout.b;
              const opponent = side === "a" ? bout.b : bout.a;
              const won = bout.winner === printed;
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
