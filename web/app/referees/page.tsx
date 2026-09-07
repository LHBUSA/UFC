import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/ui";
import { getReferees, refereeImpactRead } from "@/lib/referees";
import { SITE } from "@/lib/site";
import styles from "./referees.module.css";

export const revalidate = 900;

export const metadata: Metadata = {
  title: "UFC Referees — Fight Impact, Stoppage & Decision History",
  description: "Browse UFC referee profiles with archive-derived fight impact: assignments, stoppage and decision rates, title-fight exposure, average durations and sourced background where verified.",
  alternates: { canonical: "/referees" },
  openGraph: {
    title: "UFC Referee Intelligence — PropBetEdge",
    description: "Historical referee assignments and fight-impact context from the PropBetEdge UFC archive.",
    url: `${SITE.url}/referees`,
  },
  twitter: { card: "summary_large_image", title: "UFC Referee Intelligence — PropBetEdge" },
};

const pct = (v: number | null) => v == null ? "—" : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}%`;

export default async function RefereesPage() {
  const refs = await getReferees(200);
  const top = refs[0];
  const totalBouts = refs.reduce((n, r) => n + Number(r.bouts || 0), 0);
  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Referees" }]} />
      <section className={styles.hero}>
        <div>
          <div className="eyebrow">Officials · third fighter in the cage</div>
          <h1>Referee Intelligence</h1>
          <p>Every named referee currently present in the loaded UFC result archive, with assignments and outcome patterns computed from the same canonical bout history that powers PropBetEdge fight pages. These are historical tendencies, not claims that a referee causes a finish, decision or betting outcome.</p>
        </div>
        <aside className={styles.heroAside}>
          <b>{refs.length.toLocaleString()}</b><span>referees indexed</span>
          <b style={{ marginTop: 18 }}>{totalBouts.toLocaleString()}</b><span>referee-tagged bout assignments</span>
          {top && <><b style={{ marginTop: 18 }}>{top.display_name}</b><span>largest loaded sample · {top.bouts} bouts</span></>}
        </aside>
      </section>

      {refs.length ? (
        <section className={styles.grid} aria-label="Referee profiles">
          {refs.map((r, i) => {
            const read = refereeImpactRead(r);
            return (
              <Link href={`/referees/${r.slug}`} className={styles.card} key={r.name}>
                <div className={styles.rank}>#{i + 1} by loaded UFC assignments</div>
                <h2>{r.display_name}</h2>
                <div className={styles.metrics}>
                  <div className={styles.metric}><b>{r.bouts}</b><span>Bouts</span></div>
                  <div className={styles.metric}><b>{pct(r.stoppage_rate)}</b><span>Stoppage</span></div>
                  <div className={styles.metric}><b>{pct(r.decision_rate)}</b><span>Decision</span></div>
                </div>
                <p className={styles.read}><strong style={{ color: "var(--pbe-paper)" }}>{read.headline}.</strong> {read.body}</p>
                <span className={styles.more}>Open official profile →</span>
              </Link>
            );
          })}
        </section>
      ) : <div className={styles.empty}>Referee assignments will appear here as completed UFC results are loaded.</div>}

      <div className={styles.note}>Methodology: PropBetEdge groups the referee name stored on each completed bout result, normalizes known spelling variants, and compares that referee's loaded outcome mix with the full loaded referee archive. Small samples are explicitly gated. Personal-background copy appears only when a source has been verified; otherwise the profile uses the factual archive record as its biography.</div>
    </div>
  );
}
