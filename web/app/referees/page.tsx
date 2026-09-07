import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { getReferees, refereeImpactRead } from "@/lib/referees";
import { SITE } from "@/lib/site";
import styles from "./referees.module.css";
import { RefereePhoto, tenureLine } from "@/components/RefereeBits";

export const revalidate = 900;

export const metadata: Metadata = {
  title: "UFC Referees — Officiating Directory, Stoppage & Decision History",
  description: "Referee intelligence directory: every named UFC referee in the loaded result archive with tenure, assignments, title-fight exposure, stoppage and decision history and sourced background where verified.",
  alternates: { canonical: "/referees" },
  openGraph: { title: "UFC Referee Intelligence — PropBetEdge", description: "Historical referee assignments and fight-impact context from the PropBetEdge UFC archive.", url: `${SITE.url}/referees` },
  twitter: { card: "summary_large_image", title: "UFC Referee Intelligence — PropBetEdge" },
};

const pct = (v: number | null) => (v == null ? "—" : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}%`);
export default async function RefereesPage() {
  const refs = await getReferees(200);
  const top = refs[0];
  const totalBouts = refs.reduce((n, r) => n + Number(r.bouts || 0), 0);
  const titleRefs = refs.filter((r) => r.title_bouts > 0).length;
  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Referees" }]} />
      <section className={styles.hero}>
        <div>
          <div className="eyebrow">Officials · the third fighter in the cage</div>
          <h1>Referee Intelligence</h1>
          <p>Every named referee currently present in the loaded UFC result archive, with tenure, assignments and outcome patterns computed from the same canonical bout history that powers PropBetEdge fight pages. These are historical tendencies, not claims that a referee causes a finish, a decision or a betting outcome. Counts are <strong>archived assignments</strong>, not career totals: historical referee coverage is still being backfilled, so a low number reflects how much of that official’s history we have loaded rather than how much they have worked.</p>
          <nav className="ref-filters" aria-label="Jump to">
            <a href="#by-assignments">By archived assignments</a>
            <a href="#title-referees">Title-fight referees · {titleRefs}</a>
            <a href="#methodology">Methodology</a>
          </nav>
        </div>
        <aside className={styles.heroAside}>
          <b>{refs.length.toLocaleString()}</b><span>referees indexed</span>
          <b style={{ marginTop: 18 }}>{totalBouts.toLocaleString()}</b><span>archived assignments</span>
          {top && <><b style={{ marginTop: 18 }}>{top.display_name}</b><span>largest archived sample · {top.bouts} assignments</span></>}
        </aside>
      </section>

      {refs.length ? (
        <>
          <section id="by-assignments" className="ref-grid" aria-label="Referee profiles">
            {refs.map((r, i) => {
              const read = refereeImpactRead(r);
              const tenure = tenureLine(r);
              return (
                <Link href={`/referees/${r.slug}`} className="ref-card" key={r.name}>
                  <RefereePhoto r={r} />
                  <span>
                    <h2>{r.display_name}</h2>
                    <span className="ref-role"><em>#{i + 1}</em> by archived assignments{tenure ? ` · active ${tenure}` : ""}{r.country ? ` · ${r.country}` : ""}</span>
                    <span className="ref-stats">
                      <span><b>{r.bouts}</b><span>Archived</span></span>
                      <span><b>{r.title_bouts || "—"}</b><span>Title fights</span></span>
                      <span><b>{pct(r.stoppage_rate)}</b><span>Stoppage</span></span>
                      <span><b>{pct(r.decision_rate)}</b><span>Decision</span></span>
                    </span>
                    <span className="ref-read"><strong>{read.headline}.</strong> {r.bio ? r.bio.slice(0, 140).replace(/\s+\S*$/, "") + "…" : read.body}</span>
                    <span className="ref-more">Open referee profile →</span>
                  </span>
                </Link>
              );
            })}
          </section>
          <section id="title-referees" className={styles.section}>
            <div className={styles.sectionHead}><h2>Title-fight referees</h2><p>Referees with at least one championship bout in the loaded archive. Championship status is only populated on a small share of archived bouts so far, so this list undercounts real title assignments.</p></div>
            <div className="ref-assign">
              {refs.filter((r) => r.title_bouts > 0).sort((a, b) => b.title_bouts - a.title_bouts).slice(0, 9).map((r) => (
                <Link href={`/referees/${r.slug}`} key={r.slug}><em>{r.title_bouts} title bout{r.title_bouts === 1 ? "" : "s"}</em><b>{r.display_name}</b><span>{r.five_round_bouts} five-round assignments · {r.bouts} bouts loaded</span></Link>
              ))}
            </div>
          </section>
        </>
      ) : <div className={styles.empty}>Referee assignments will appear here as completed UFC results are loaded.</div>}

      <div id="methodology" className={styles.note}>Methodology: PropBetEdge groups the referee name stored on each completed bout result, normalizes known spelling variants, and compares that referee&apos;s loaded outcome mix with the full loaded referee archive. Small samples are explicitly gated. Personal-background copy appears only when a verified source is attached; photos appear only when a rights-cleared image is on file, otherwise the monogram plate is shown.</div>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "CollectionPage", "@id": `${SITE.url}/referees#collection`, url: `${SITE.url}/referees`, name: "UFC referee intelligence directory", isPartOf: { "@id": `${SITE.url}/#site` }, mainEntity: { "@type": "ItemList", itemListElement: refs.slice(0, 50).map((r, i) => ({ "@type": "ListItem", position: i + 1, name: r.display_name, url: `${SITE.url}/referees/${r.slug}` })) } }} />
    </div>
  );
}
