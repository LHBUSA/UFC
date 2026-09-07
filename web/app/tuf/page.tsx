import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { coverage, editions, inventoryConflicts, inventoryProvenance, seasons, type SeasonRow } from "@/lib/tuf";
import { SITE } from "@/lib/site";

/* /tuf — the archive hub.
 *
 * Two things this page refuses to do. It does not show a winner for a season
 * that has not finished, and it does not describe our coverage as the show's
 * coverage: the status on each card is what WE hold, so "partial" means we
 * have the season and its finale but not its bracket, not that the season was
 * somehow incomplete. Saying "complete" about a season we have barely loaded
 * would be the easiest lie on the site to tell. */
export const revalidate = 3600;

const TITLE = "The Ultimate Fighter Archive | PropBetEdge UFC";
const DESCRIPTION =
  "Every season of The Ultimate Fighter, including the Brazil, Latin America, China, Nations and Smashes editions: coaches, weight classes, tournament winners and finale cards, with sources recorded and gaps stated.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/tuf" },
  keywords: ["The Ultimate Fighter", "TUF seasons", "TUF winners", "TUF coaches", "TUF Brazil", "TUF finale"],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: `${SITE.url}/tuf`,
    images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630, alt: "The Ultimate Fighter archive" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

function StatusPill({ s }: { s: SeasonRow }) {
  if (s.ongoing) return <span className="tuf-pill tuf-pill-live">Ongoing</span>;
  if (s.status === "complete") return <span className="tuf-pill tuf-pill-ok">Bracket loaded</span>;
  if (s.status === "partial") return <span className="tuf-pill">Season &amp; finale</span>;
  return <span className="tuf-pill tuf-pill-thin">Season only</span>;
}

function Card({ s }: { s: SeasonRow }) {
  const champions = s.winners ?? [];
  return (
    <Link href={`/tuf/${s.slug}`} className={`tuf-card${s.detail ? " has-detail" : ""}`}>
      <span className="tuf-card-top">
        <span className="tuf-num">{s.number}</span>
        <span className="tuf-year">{s.year}</span>
        <StatusPill s={s} />
      </span>
      <span className="tuf-card-name">{s.name.replace(/^The Ultimate Fighter( Brazil| Latin America| China| Nations)?[: ]*/i, "") || s.name}</span>
      <span className="tuf-coaches">
        {s.coaches.length ? s.coaches.join("  vs  ") : <em>{s.coaches_note ? "Rotating coaches" : "Coaches unrecorded"}</em>}
      </span>
      <span className="tuf-wc">{s.weight_classes.join(" · ")}</span>
      <span className="tuf-champs">
        {s.ongoing ? (
          /* No winner exists yet. Not "TBD" in a slot shaped like a result —
           * an empty result slot reads as a result nobody has typed in. */
          <em className="tuf-none">Season in progress — no tournament winner yet</em>
        ) : champions.length ? (
          champions.map((w) => (
            <span key={w.weight_class} className="tuf-champ">
              <b>{w.fighter}</b>
              <small>{w.weight_class}</small>
            </span>
          ))
        ) : s.finalists?.length ? (
          <em className="tuf-none">Finalists known, winner unverified</em>
        ) : (
          <em className="tuf-none">Winner unrecorded</em>
        )}
      </span>
    </Link>
  );
}

export default function TufHub() {
  const rows = seasons();
  const eds = editions();
  const cov = coverage();
  const conflicts = inventoryConflicts();
  const prov = inventoryProvenance();

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="Archive"
            title="The Ultimate Fighter"
            lede="Every season across every edition, with the coaches who ran the teams and the fighters who won the tournaments. Where a source is thin or two sources disagree, this archive says so rather than picking one."
            crumbs={[{ name: "The Ultimate Fighter" }]}
          />
        </div>
      </div>

      <section className="wrap tuf-cov">
        <div className="tuf-cov-grid">
          <div className="tuf-cov-cell"><b>{cov.seasons}</b><span>seasons catalogued</span></div>
          <div className="tuf-cov-cell"><b>{cov.complete}</b><span>with a loaded bracket</span></div>
          <div className="tuf-cov-cell"><b>{cov.partial}</b><span>season &amp; finale only</span></div>
          <div className="tuf-cov-cell"><b>{cov.missing}</b><span>season metadata only</span></div>
        </div>
        <p className="tuf-note">
          These counts describe <strong>our coverage</strong>, not the show&rsquo;s. A season marked &ldquo;season only&rdquo; is
          fully documented elsewhere; we simply have not loaded its card or its bracket yet.
        </p>
      </section>

      {conflicts.length > 0 && (
        <section className="wrap tuf-conflicts" aria-label="Source conflicts">
          <h2>Where sources disagree</h2>
          {conflicts.map((c, i) => (
            <p key={i}>
              <b>{c.scope}</b> · {c.field} — {c.detail}
            </p>
          ))}
        </section>
      )}

      {eds.map((ed) => {
        const list = rows.filter((r) => r.edition === ed.key);
        if (!list.length) return null;
        return (
          <section className="wrap tuf-section" key={ed.key} id={ed.key}>
            <div className="tuf-section-head">
              <h2>{ed.name}</h2>
              <p>{ed.blurb}</p>
              <span className="tuf-count">{list.length} season{list.length === 1 ? "" : "s"}</span>
            </div>
            <div className="tuf-grid">
              {list.map((s) => (
                <Card key={s.slug} s={s} />
              ))}
            </div>
          </section>
        );
      })}

      {prov && (
        <section className="wrap tuf-section">
          <p className="tuf-note">
            Season metadata sourced from <a href={prov.primary} rel="nofollow noopener" target="_blank">the franchise record</a>,
            retrieved {prov.retrieved}. Finale cards and every professional result come from our own fight database, so nothing
            on this page duplicates a bout we already hold.
          </p>
        </section>
      )}

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: TITLE,
          description: DESCRIPTION,
          url: `${SITE.url}/tuf`,
          isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
        }}
      />
    </>
  );
}
