import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { editions, inventoryConflicts, inventoryProvenance, seasonStatuses, seasons, statusReport, type SeasonRow } from "@/lib/tuf";
import type { HubStatus } from "@/lib/tufStatus";
import { SITE } from "@/lib/site";

/* /tuf — the archive hub.
 *
 * Two things this page refuses to do. It does not show a winner for a season
 * that has not finished, and it does not turn the archive's research backlog
 * into a card-level verdict. Each card says whether the season is represented
 * in the format it actually used (lib/tufStatus.ts): Complete, Partial or
 * Season ongoing, plus a Verified badge where every result and classification
 * is also backed by primary records. Open research questions live on the
 * season page, where they can be read in context. */
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

/* One primary pill and, only where it applies, the positive Verified badge.
 * The internal blocker vocabulary stays in the completeness matrix. */
const TONE = { live: "tuf-pill-live", ok: "tuf-pill-ok", thin: "tuf-pill-thin" } as const;
function StatusPills({ st }: { st: HubStatus }) {
  return (
    <span className="tuf-status">
      <span className={`tuf-pill ${TONE[st.primary.tone]}`}>{st.primary.label}</span>
      {st.secondary && <span className={`tuf-status-sub is-${st.secondary.tone}`}>{st.secondary.label}</span>}
    </span>
  );
}

function Card({ s, st }: { s: SeasonRow; st: HubStatus }) {
  const champions = s.winners ?? [];
  return (
    <Link href={`/tuf/${s.slug}`} className={`tuf-card${s.detail ? " has-detail" : ""}`}>
      <span className="tuf-card-top">
        <span className="tuf-num">{s.number}</span>
        <span className="tuf-year">{s.year}</span>
        <StatusPills st={st} />
      </span>
      <span className="tuf-card-name">{s.name.replace(/^The Ultimate Fighter( Brazil| Latin America| China| Nations)?[: ]*/i, "") || s.name}</span>
      <span className="tuf-coaches">
        {s.coaches.length ? s.coaches.join("  vs  ") : <em>{s.coaches_note ? "Rotating coaches" : "Coaches unrecorded"}</em>}
      </span>
      <span className="tuf-wc">{s.weight_classes.join(" · ")}</span>
      <span className="tuf-champs">
        {s.season_state === "ongoing" ? (
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
  const report = statusReport();
  const statuses = seasonStatuses();
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

      <nav className="wrap tuf-hubnav" aria-label="TUF archive sections">
        <Link href="/tuf/champions">Champions</Link>
        <Link href="/tuf/alumni">Alumni</Link>
        <Link href="/tuf/coaches">Coaches</Link>
      </nav>

      <section className="wrap tuf-cov">
        <div className="tuf-cov-grid">
          <div className="tuf-cov-cell"><b>{report.complete}</b><span>complete seasons</span></div>
          <div className="tuf-cov-cell"><b>{report.ongoing}</b><span>ongoing</span></div>
          {report.partial > 0 && <div className="tuf-cov-cell"><b>{report.partial}</b><span>partial</span></div>}
          <div className="tuf-cov-cell"><b>{report.verified}</b><span>verified by primary records</span></div>
          <div className="tuf-cov-cell is-total"><b>{report.seasons}</b><span>seasons catalogued</span></div>
        </div>
        <p className="tuf-note">
          A season is <strong>complete</strong> when the competition it actually ran is fully represented in its own format.
          <strong> Verified</strong> is an extra layer on top: every house result and classification is also backed by a primary
          record, such as the athletic commission&apos;s own results. Where sources still disagree, the season page says so.
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
                <Card key={s.slug} s={s} st={statuses.get(s.slug)!} />
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
