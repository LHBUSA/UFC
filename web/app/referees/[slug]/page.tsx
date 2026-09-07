import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { eventSlug } from "@/lib/slug";
import { fmtDate, fmtTime, METHOD_LABEL } from "@/lib/format";
import { getRefereeBouts, getRefereeBySlug, refereeArchiveBio, refereeImpactRead } from "@/lib/referees";
import { SITE } from "@/lib/site";
import styles from "../referees.module.css";

export const revalidate = 900;

const pct = (v: number | null) => v == null ? "—" : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}%`;
const duration = (v: number | null) => v == null ? "—" : fmtTime(v);

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const r = await getRefereeBySlug((await params).slug);
  if (!r) return { title: "Referee not found", robots: { index: false } };
  const title = `${r.display_name} — UFC Referee Stats & Fight Impact`;
  const description = `${r.display_name} referee profile: ${r.bouts} loaded UFC assignments, ${pct(r.stoppage_rate)} stoppage rate, ${pct(r.decision_rate)} decision rate, title-fight history and recent bouts.`;
  return {
    title,
    description,
    alternates: { canonical: `/referees/${r.slug}` },
    openGraph: { title, description, url: `${SITE.url}/referees/${r.slug}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function RefereeProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const [r, bouts] = await Promise.all([getRefereeBySlug(slug), getRefereeBouts(slug, 60)]);
  if (!r) notFound();
  const impact = refereeImpactRead(r);
  const recent = bouts.slice(0, 6);
  const bio = r.bio || refereeArchiveBio(r);
  const schema = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    name: `${r.display_name} UFC referee profile`,
    url: `${SITE.url}/referees/${r.slug}`,
    dateModified: r.bio_verified_at || r.last_event_date || undefined,
    mainEntity: {
      "@type": "Person",
      name: r.display_name,
      jobTitle: "Mixed martial arts referee",
      description: bio,
      sameAs: r.bio_source_url ? [r.bio_source_url] : undefined,
    },
    isPartOf: { "@id": `${SITE.url}/#site` },
  };

  return (
    <div className="wrap page">
      <JsonLd data={schema} />
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Referees", href: "/referees" }, { name: r.display_name }]} />

      <section className={styles.profileHero}>
        <div>
          <div className="eyebrow">Referee intelligence · archive profile</div>
          <h1>{r.display_name}</h1>
          <p>{refereeArchiveBio(r)}</p>
          <div className={styles.bio}>
            <strong style={{ color: "var(--pbe-paper)" }}>{r.bio ? "Verified background" : "Archive biography"}</strong><br />
            {bio}
            {r.bio_source_url && <><br /><a className={styles.source} href={r.bio_source_url} target="_blank" rel="noopener">Source · {r.bio_source_name || "Verified biography"} ↗</a></>}
          </div>
        </div>
        <aside className={styles.impact}>
          <div className={styles.impactKicker}>Fight impact · historical context</div>
          <h2>{impact.headline}</h2>
          <p>{impact.body}</p>
          <div className={styles.timeline} style={{ marginTop: 18 }}>
            <div><b>{pct(r.stoppage_rate)}</b><span>Referee sample stoppage rate</span></div>
            <div><b>{pct(r.archive_stoppage_rate)}</b><span>Loaded archive baseline</span></div>
          </div>
        </aside>
      </section>

      <section className={styles.stats} aria-label="Referee metrics">
        <div className={styles.stat}><b>{r.bouts}</b><span>Loaded bouts</span></div>
        <div className={styles.stat}><b>{r.stoppages}</b><span>Stoppages</span></div>
        <div className={styles.stat}><b>{r.decisions}</b><span>Decisions</span></div>
        <div className={styles.stat}><b>{r.title_bouts}</b><span>Title bouts</span></div>
        <div className={styles.stat}><b>{r.five_round_bouts}</b><span>5-round assignments</span></div>
        <div className={styles.stat}><b>{duration(r.avg_stoppage_seconds)}</b><span>Avg stoppage time</span></div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>What the sample says</h2>
          <p>Descriptive outcome history only. Referee assignment is one piece of fight context and should never override matchup, fighter, round-profile or market evidence.</p>
        </div>
        <div className={styles.timeline}>
          <div><b>KO/TKO · {r.ko_tko}</b><span>{r.bouts ? `${((r.ko_tko / r.bouts) * 100).toFixed(1)}% of loaded assignments` : "No sample"}</span></div>
          <div><b>Submissions · {r.submissions}</b><span>{r.bouts ? `${((r.submissions / r.bouts) * 100).toFixed(1)}% of loaded assignments` : "No sample"}</span></div>
          <div><b>Decisions · {r.decisions}</b><span>{pct(r.decision_rate)} of loaded assignments</span></div>
          <div><b>Split decisions · {r.split_decisions}</b><span>{r.decisions ? `${pct(r.split_decision_share)} of decisions` : "No decision sample"}</span></div>
          <div><b>Average fight duration · {duration(r.avg_fight_seconds)}</b><span>Measured from the stored result round/time across this referee's loaded assignments.</span></div>
          <div><b>Archive span · {r.first_event_date ? fmtDate(r.first_event_date, { year: "numeric" }) : "—"} to {r.last_event_date ? fmtDate(r.last_event_date, { year: "numeric" }) : "—"}</b><span>The profile expands automatically as historical and new results land.</span></div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}><h2>Recent UFC assignments</h2><p>The newest referee-tagged results currently present in the PropBetEdge UFC archive.</p></div>
        <div className={styles.timeline}>
          {recent.map((b) => (
            <div key={b.bout_id}>
              <b>{b.fighter_a_name} vs {b.fighter_b_name}</b>
              <span>{b.event_date ? fmtDate(b.event_date, { month: "short", day: "numeric", year: "numeric" }) : "Date unavailable"} · {b.event_name}</span>
              <span>{METHOD_LABEL[b.method] || b.method_raw}{b.round ? ` · R${b.round}` : ""}{b.time_sec != null ? ` · ${fmtTime(b.time_sec)}` : ""}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}><h2>Assignment archive</h2><p>Up to 60 recent loaded UFC bouts. Result source links remain attached at row level.</p></div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Date</th><th>Event</th><th>Fight</th><th>Result</th><th>Round / time</th><th>Source</th></tr></thead>
            <tbody>
              {bouts.map((b) => (
                <tr key={b.bout_id}>
                  <td>{b.event_date ? fmtDate(b.event_date, { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                  <td><Link href={`/events/${eventSlug({ name: b.event_name, event_date: b.event_date })}`}>{b.event_name}</Link></td>
                  <td>{b.fighter_a_name} <span className="faint">vs</span> {b.fighter_b_name}</td>
                  <td><span className={styles.method}>{METHOD_LABEL[b.method] || b.method_raw}</span>{b.winner_name ? <><br /><span className="faint">{b.winner_name} won</span></> : null}</td>
                  <td>{b.round ? `R${b.round}` : "—"}{b.time_sec != null ? ` · ${fmtTime(b.time_sec)}` : ""}</td>
                  <td><a href={b.source_url} target="_blank" rel="noopener">{b.result_source === "espn" ? "ESPN" : "UFC Stats"} ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className={styles.note}>Important: “fight impact” here means historical context, not causation. A referee does not choose the matchup, fighter styles, skill gap or scheduled length, so finish/decision rates must be interpreted with sample size and those confounders in mind. PropBetEdge will only elevate referee tendencies into Pregame Desk when a specific assignment is verified and the sample clears the minimum-data gate.</div>
    </div>
  );
}
