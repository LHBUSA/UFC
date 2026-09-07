import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { eventSlug, matchupSlug } from "@/lib/slug";
import { fmtDate, fmtTime, METHOD_LABEL, weightClassLabel } from "@/lib/format";
import { getRefereeBouts, getRefereeBySlug, refereeArchiveBio, refereeImpactRead, type RefereeBout } from "@/lib/referees";
import { SITE } from "@/lib/site";
import { RefereePhoto, tenureLine } from "@/components/RefereeBits";
import styles from "../referees.module.css";

/* /referees/[slug] — premium intelligence profile: photo (or monogram),
 * name, role line, key stats, what to know, recent and notable assignments
 * with links into the fight and event archive, profile details, full
 * assignment table. Every number is the loaded archive; nothing is inferred. */
export const revalidate = 900;

const pct = (v: number | null) => (v == null ? "—" : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}%`);
const duration = (v: number | null) => (v == null ? "—" : fmtTime(v));
const fightHref = (b: RefereeBout) => `/fights/${matchupSlug({ name: b.fighter_a_name }, { name: b.fighter_b_name }, { name: b.event_name, event_date: b.event_date })}`;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const r = await getRefereeBySlug((await params).slug);
  if (!r) return { title: "Referee not found", robots: { index: false } };
  const title = `${r.display_name} — UFC Referee Profile, Assignments & Fight Impact`;
  const description = `${r.display_name} referee profile: ${r.bouts} loaded UFC assignments${r.title_bouts ? `, ${r.title_bouts} title fights` : ""}, ${pct(r.stoppage_rate)} stoppage rate, ${pct(r.decision_rate)} decision rate, tenure, recent and notable bouts.`;
  return { title, description, alternates: { canonical: `/referees/${r.slug}` }, openGraph: { title, description, url: `${SITE.url}/referees/${r.slug}` }, twitter: { card: "summary_large_image", title, description } };
}

export default async function RefereeProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const [r, bouts] = await Promise.all([getRefereeBySlug(slug), getRefereeBouts(slug, 80)]);
  if (!r) notFound();
  const impact = refereeImpactRead(r);
  const tenure = tenureLine(r);
  const recent = bouts.slice(0, 6);
  const notable = bouts.filter((b) => b.is_title || b.scheduled_rounds === 5 || b.card_position === "main").slice(0, 6);
  const events = [...new Map(bouts.filter((b) => b.event_date).map((b) => [b.event_id, b])).values()].slice(0, 8);
  const bio = r.bio || refereeArchiveBio(r);
  const tendencies: string[] = [];
  if (r.bouts >= 20) {
    if (r.stoppage_rate != null) tendencies.push(`${pct(r.stoppage_rate)} of loaded assignments ended by stoppage (${r.ko_tko} KO/TKO, ${r.submissions} submissions) against a ${pct(r.archive_stoppage_rate)} archive baseline.`);
    if (r.decision_rate != null) tendencies.push(`${pct(r.decision_rate)} reached the judges; ${r.split_decisions} of ${r.decisions} decisions were split (${pct(r.split_decision_share)}).`);
    if (r.avg_stoppage_seconds != null) tendencies.push(`Average elapsed time to a stoppage in this sample: ${duration(r.avg_stoppage_seconds)} of fight time.`);
  }
  if (r.title_bouts > 0) tendencies.push(`${r.title_bouts} championship assignment${r.title_bouts === 1 ? "" : "s"} and ${r.five_round_bouts} five-round bout${r.five_round_bouts === 1 ? "" : "s"} in the loaded archive.`);
  const schema = {
    "@context": "https://schema.org", "@type": "ProfilePage", name: `${r.display_name} UFC referee profile`, url: `${SITE.url}/referees/${r.slug}`, dateModified: r.bio_verified_at || r.last_event_date || undefined,
    mainEntity: { "@type": "Person", name: r.display_name, jobTitle: "Mixed martial arts referee", nationality: r.country || undefined, description: bio, image: r.image_url || undefined, sameAs: r.bio_source_url ? [r.bio_source_url] : undefined },
    isPartOf: { "@id": `${SITE.url}/#site` },
  };

  return (
    <div className="wrap page">
      <JsonLd data={schema} />
      <Breadcrumbs items={[{ name: "Referees", href: "/referees" }, { name: r.display_name }]} />

      <header className="ref-hero">
        <RefereePhoto r={r} size="lg" />
        <div>
          <div className="eyebrow">Referee intelligence · archive profile</div>
          <h1>{r.display_name}</h1>
          <p className="ref-line">UFC referee{r.country ? ` · ${r.country}` : ""}{tenure ? ` · active in the loaded archive ${tenure}` : ""}. <em>{r.bouts} assignments</em>{r.title_bouts ? <>, <em>{r.title_bouts} title fight{r.title_bouts === 1 ? "" : "s"}</em></> : null}.</p>
          {r.bio && r.bio_source_url && <p className="faint sm mt-2">Background verified · <a className={styles.source} href={r.bio_source_url} target="_blank" rel="noopener">{r.bio_source_name || "source"} ↗</a></p>}
        </div>
        <div className="ref-keystats" aria-label="Key stats">
          <div><b>{r.bouts}</b><span>Loaded bouts</span></div>
          <div><b>{r.title_bouts}</b><span>Title fights</span></div>
          <div><b>{r.five_round_bouts}</b><span>Five-round</span></div>
          <div><b>{pct(r.stoppage_rate)}</b><span>Stoppage rate</span></div>
          <div><b>{pct(r.decision_rate)}</b><span>Decision rate</span></div>
          <div><b>{duration(r.avg_fight_seconds)}</b><span>Avg fight time</span></div>
        </div>
      </header>

      <section className="ref-know">
        <div className="hi">
          <div className="eyebrow">What to know</div>
          <h2>{impact.headline}</h2>
          <p>{impact.body}</p>
          {tendencies.length > 0 && <ul>{tendencies.map((t) => <li key={t}>{t}</li>)}</ul>}
          <p className="faint sm">Descriptive history from the loaded archive. A referee does not choose the matchup, styles or scheduled length, so finish and decision rates are context, not a causal signal.</p>
        </div>
        <div>
          <div className="eyebrow">{r.bio ? "Verified background" : "Archive biography"}</div>
          <h2>{r.display_name}</h2>
          <p>{bio}</p>
          {r.bio_source_url && <p><a className={styles.source} href={r.bio_source_url} target="_blank" rel="noopener">Source · {r.bio_source_name || "Verified biography"} ↗</a></p>}
        </div>
      </section>

      {notable.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}><h2>Notable assignments</h2><p>Title fights, five-round bouts and main events in this referee&apos;s loaded archive, linked to the matchup pages.</p></div>
          <div className="ref-assign">
            {notable.map((b) => <Link href={fightHref(b)} key={b.bout_id}><em>{b.is_title ? "Title fight" : b.scheduled_rounds === 5 ? "Five rounds" : "Main event"} · {weightClassLabel(b.weight_class, b.is_womens)}</em><b>{b.fighter_a_name} vs {b.fighter_b_name}</b><span>{b.event_name}{b.event_date ? ` · ${fmtDate(b.event_date, { month: "short", day: "numeric", year: "numeric" })}` : ""}</span><span>{METHOD_LABEL[b.method] || b.method_raw}{b.round ? ` · R${b.round}` : ""}{b.time_sec != null ? ` · ${fmtTime(b.time_sec)}` : ""}{b.winner_name ? ` · ${b.winner_name} won` : ""}</span></Link>)}
          </div>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}><h2>Recent assignments</h2><p>The newest referee-tagged results currently present in the PropBetEdge UFC archive.</p></div>
        <div className="ref-assign">
          {recent.map((b) => <Link href={fightHref(b)} key={b.bout_id}><em>{b.event_date ? fmtDate(b.event_date, { month: "short", day: "numeric", year: "numeric" }) : "Date unavailable"}</em><b>{b.fighter_a_name} vs {b.fighter_b_name}</b><span>{b.event_name}</span><span>{METHOD_LABEL[b.method] || b.method_raw}{b.round ? ` · R${b.round}` : ""}{b.time_sec != null ? ` · ${fmtTime(b.time_sec)}` : ""}</span></Link>)}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}><h2>Profile details</h2><p>Structured facts from the loaded archive and, where attached, a verified source. Unavailable facts are omitted rather than guessed.</p></div>
        <dl className="ref-details">
          <div><dt>Full name</dt><dd>{r.display_name}</dd></div>
          {r.country && <div><dt>Country</dt><dd>{r.country}</dd></div>}
          {tenure && <div><dt>Archive tenure</dt><dd>{tenure}{r.first_event_date ? ` · first loaded bout ${fmtDate(r.first_event_date, { month: "short", day: "numeric", year: "numeric" })}` : ""}</dd></div>}
          {r.last_event_date && <div><dt>Most recent bout</dt><dd>{fmtDate(r.last_event_date, { month: "short", day: "numeric", year: "numeric" })}</dd></div>}
          <div><dt>UFC bouts officiated</dt><dd>{r.bouts} <span className="faint">(loaded archive)</span></dd></div>
          <div><dt>Title fights</dt><dd>{r.title_bouts}</dd></div>
          <div><dt>Outcomes</dt><dd>{r.ko_tko} KO/TKO · {r.submissions} submissions · {r.decisions} decisions ({r.split_decisions} split) · {r.nc_draws} NC/draws</dd></div>
          <div><dt>Average stoppage</dt><dd>{duration(r.avg_stoppage_seconds)}</dd></div>
          {r.bio_source_url && <div><dt>Background source</dt><dd><a href={r.bio_source_url} target="_blank" rel="noopener">{r.bio_source_name || r.bio_source_url} ↗</a>{r.bio_verified_at ? ` · verified ${fmtDate(r.bio_verified_at.slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}` : ""}</dd></div>}
          {r.image_url && <div><dt>Photo</dt><dd>{r.image_credit || "Rights-cleared image"}{r.image_license ? ` · ${r.image_license}` : ""}{r.image_source_url ? <> · <a href={r.image_source_url} target="_blank" rel="noopener">source ↗</a></> : null}</dd></div>}
        </dl>
      </section>

      {events.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}><h2>Related events</h2><p>Cards this referee worked in the loaded archive.</p></div>
          <div className="ref-assign">
            {events.map((b) => <Link href={`/events/${eventSlug({ name: b.event_name, event_date: b.event_date })}`} key={b.event_id}><em>{b.event_date ? fmtDate(b.event_date, { month: "short", year: "numeric" }) : "Date unavailable"}</em><b>{b.event_name}</b><span>{[b.venue, b.city, b.country].filter(Boolean).join(" · ") || "Venue unavailable"}</span></Link>)}
          </div>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}><h2>Assignment archive</h2><p>Up to 80 recent loaded UFC bouts. Result source links remain attached at row level.</p></div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Date</th><th>Event</th><th>Fight</th><th>Result</th><th>Round / time</th><th>Source</th></tr></thead>
            <tbody>
              {bouts.map((b) => (
                <tr key={b.bout_id}>
                  <td>{b.event_date ? fmtDate(b.event_date, { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                  <td><Link href={`/events/${eventSlug({ name: b.event_name, event_date: b.event_date })}`}>{b.event_name}</Link></td>
                  <td><Link href={fightHref(b)}>{b.fighter_a_name} <span className="faint">vs</span> {b.fighter_b_name}</Link>{b.is_title ? <span className="tag gold" style={{ marginLeft: 8 }}>Title</span> : null}</td>
                  <td><span className={styles.method}>{METHOD_LABEL[b.method] || b.method_raw}</span>{b.winner_name ? <><br /><span className="faint">{b.winner_name} won</span></> : null}</td>
                  <td>{b.round ? `R${b.round}` : "—"}{b.time_sec != null ? ` · ${fmtTime(b.time_sec)}` : ""}</td>
                  <td><a href={b.source_url} target="_blank" rel="noopener">{b.result_source === "espn" ? "ESPN" : "UFC Stats"} ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className={styles.note}>Important: &ldquo;fight impact&rdquo; here means historical context, not causation. A referee does not choose the matchup, fighter styles, skill gap or scheduled length, so finish and decision rates must be interpreted with sample size and those confounders in mind.</div>
    </div>
  );
}
