import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { eventSlug, fighterSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";
import { editions, linkFighters, linkedFinale, seasonBySlug, seasons } from "@/lib/tuf";

/* /tuf/champions — every tournament winner, by edition, season and division.
 *
 * Two things are kept apart that are usually run together. Winning the
 * tournament and being awarded a UFC contract are different facts and have not
 * always gone together, so they are shown as separate claims and a season we
 * cannot establish the contract for says so rather than implying one. And a
 * champion whose winning bout we can point at is linked to it; a champion
 * whose finale we have not loaded is named without a link, rather than being
 * given one that goes nowhere. */
export const revalidate = 3600;

const TITLE = "The Ultimate Fighter champions | PropBetEdge UFC";
const DESCRIPTION =
  "Every winner of The Ultimate Fighter, by season, edition and weight class, linked to the fighter profile and the finale that decided it.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/tuf/champions" },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: `${SITE.url}/tuf/champions` },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default async function TufChampions() {
  const rows = seasons();
  const eds = editions();

  /* One champion row per weight class, carrying its season. */
  const champs = rows.flatMap((s) => {
    const detail = seasonBySlug(s.slug);
    return s.winners.map((w) => ({
      season: s,
      weight_class: w.weight_class,
      fighter: w.fighter,
      verified: detail?.champions?.find((c) => c.fighter === w.fighter)?.verified_against ?? null,
      contract: detail?.champions?.find((c) => c.fighter === w.fighter)?.received_contract ?? null,
      winning_bout: detail?.champions?.find((c) => c.fighter === w.fighter)?.winning_bout ?? null,
    }));
  });

  const [linked, finales] = await Promise.all([
    linkFighters(champs.map((c) => c.fighter)),
    Promise.all(
      rows.map(async (s) => [s.slug, await linkedFinale(s.finale_event, s.finale_date)] as const),
    ).then((pairs) => new Map(pairs)),
  ]);

  /* Fighters who won more than once. Worth surfacing: it has happened, and a
   * flat list buries it. */
  const tally = new Map<string, number>();
  for (const c of champs) tally.set(c.fighter, (tally.get(c.fighter) ?? 0) + 1);
  const repeats = [...tally.entries()].filter(([, n]) => n > 1).map(([name]) => name);

  const undecided = rows.filter((s) => !s.winners.length);

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="Archive"
            title="TUF champions"
            lede="Every tournament winner across every edition. Winning the tournament and receiving a UFC contract are recorded as separate facts, because they are separate facts."
            crumbs={[{ name: "The Ultimate Fighter", href: "/tuf" }, { name: "Champions" }]}
          />
        </div>
      </div>

      <section className="wrap tuf-cov">
        <div className="tuf-cov-grid">
          <div className="tuf-cov-cell"><b>{champs.length}</b><span>tournament winners</span></div>
          <div className="tuf-cov-cell"><b>{champs.filter((c) => c.verified).length}</b><span>verified against a result</span></div>
          <div className="tuf-cov-cell"><b>{repeats.length}</b><span>multiple-time winners</span></div>
          <div className="tuf-cov-cell is-total"><b>{undecided.length}</b><span>seasons without a recorded winner</span></div>
        </div>
        <p className="tuf-note">
          &ldquo;Verified against a result&rdquo; means the winning bout was checked against our own fight records rather than
          taken from a season summary. The rest are sourced from the season record and are marked as such — they are not
          less likely to be right, they are simply less checked.
        </p>
      </section>

      {eds.map((ed) => {
        const list = champs.filter((c) => c.season.edition === ed.key);
        if (!list.length) return null;
        return (
          <section className="wrap tuf-section" key={ed.key}>
            <div className="tuf-section-head">
              <h2>{ed.name}</h2>
              <span className="tuf-count">{list.length} winner{list.length === 1 ? "" : "s"}</span>
            </div>
            <div className="tuf-champ-table" role="table">
              <div className="tuf-champ-row is-head" role="row">
                <span role="columnheader">Season</span>
                <span role="columnheader">Weight class</span>
                <span role="columnheader">Champion</span>
                <span role="columnheader">Decided at</span>
              </div>
              {list.map((c) => {
                const f = linked.get(c.fighter);
                const finale = finales.get(c.season.slug) ?? null;
                return (
                  <div className="tuf-champ-row" role="row" key={`${c.season.slug}-${c.weight_class}`}>
                    <span role="cell">
                      <Link href={`/tuf/${c.season.slug}`}>
                        <b>{c.season.number}</b> <small>{c.season.year}</small>
                      </Link>
                    </span>
                    <span role="cell" className="tuf-wc">{c.weight_class}</span>
                    <span role="cell">
                      {f ? (
                        <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(f)}`}>{c.fighter}</Link>
                      ) : (
                        <span className="tuf-name">{c.fighter}</span>
                      )}
                      {c.verified ? <small className="tuf-verified">verified</small> : null}
                      {c.contract === false ? <small>contract not recorded</small> : null}
                    </span>
                    <span role="cell">
                      {finale ? (
                        <Link href={`/events/${eventSlug(finale)}`}>{finale.event_date}</Link>
                      ) : c.season.finale_event ? (
                        <span className="tuf-none">{c.season.finale_date} · card not loaded</span>
                      ) : (
                        <span className="tuf-none">Finale not recorded</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {undecided.length ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head"><h2>No winner recorded</h2></div>
          <p className="tuf-note">
            {undecided.map((s, i) => (
              <span key={s.slug}>
                {i ? " · " : ""}
                <Link href={`/tuf/${s.slug}`}>{s.name}</Link>{" "}
                <em>({s.season_state === "ongoing" ? "still airing" : "winner unverified"})</em>
              </span>
            ))}
          </p>
        </section>
      ) : null}

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: TITLE,
          description: DESCRIPTION,
          url: `${SITE.url}/tuf/champions`,
          isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
        }}
      />
    </>
  );
}
