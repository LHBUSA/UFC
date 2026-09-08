import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { eventSlug, matchupSlug } from "@/lib/slug";
import { fmtDate, weightClassLabel } from "@/lib/format";
import { getJudgeArchive, getJudgeBySlug, judgeArchiveBio, provisionalPairFor, tenureLine, type JudgeCard } from "@/lib/judges";
import { DECISION_LABEL, DRAW_LABEL, MIN_RATE_SAMPLE, dissentRead, wilsonInterval } from "@/lib/judgeScoring";
import { SITE } from "@/lib/site";
import styles from "../judges.module.css";

/* /judges/[slug] — one official's scorecard history.
 *
 * The rule this page is built around: every number sits next to the sample it
 * came from, and no number is turned into a characterisation of the judge.
 * A dissent count is "this card differed from the official result", never
 * "this judge favours pressure fighters" — the archive holds scores and
 * outcomes, and nothing in it can support the second claim. */
export const revalidate = 900;

const fightHref = (c: JudgeCard) =>
  `/fights/${matchupSlug({ name: c.fighterAName }, { name: c.fighterBName }, { name: c.eventName, event_date: c.eventDate })}`;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const hit = await getJudgeBySlug((await params).slug);
  if (!hit) return { title: "Judge not found", robots: { index: false } };
  const { judge } = hit;
  const title = `${judge.displayName} — UFC Judge Profile, Scorecards & Dissents`;
  const description = `${judge.displayName} judging profile: ${judge.cards.toLocaleString()} archived UFC scorecards across ${judge.bouts.toLocaleString()} bouts${judge.titleCards ? `, ${judge.titleCards} title cards` : ""}, ${judge.dissentCards} dissenting cards, ${judge.evenCards} level cards, average score margin ${judge.avgScoreMargin ?? "—"}.`;
  return { title, description, alternates: { canonical: `/judges/${judge.slug}` }, openGraph: { title, description, url: `${SITE.url}/judges/${judge.slug}` }, twitter: { card: "summary_large_image", title, description } };
}

export default async function JudgeProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const [hit, archive] = await Promise.all([getJudgeBySlug(slug), getJudgeArchive()]);
  if (!hit) notFound();
  const { judge, cards } = hit;
  const { totals } = archive;

  const read = dissentRead({
    displayName: judge.displayName, dissents: judge.dissentCards, attributed: judge.attributedCards,
    archiveDissents: totals.dissentCards, archiveAttributed: totals.attributedCards,
  });
  const tenure = tenureLine(judge);
  /* A near-name pair we have deliberately not merged. Saying nothing would let
   * a split record read as a complete one. */
  const provisional = provisionalPairFor(judge.name);
  const interval = wilsonInterval(judge.dissentCards, judge.attributedCards);
  const archiveRate = totals.attributedCards ? totals.dissentCards / totals.attributedCards : 0;
  const judgeRate = judge.attributedCards ? judge.dissentCards / judge.attributedCards : 0;

  const recent = cards.slice(0, 8);
  const dissents = cards.filter((c) => c.isDissent === true).slice(0, 8);
  const titleCards = cards.filter((c) => c.isTitle).slice(0, 6);
  const events = [...new Map(cards.filter((c) => c.eventDate).map((c) => [c.eventId, c])).values()].slice(0, 8);
  const table = cards.slice(0, 80);

  /* Only facts, each with its own denominator on the line. */
  const facts: string[] = [];
  facts.push(`${judge.cards.toLocaleString()} card${judge.cards === 1 ? "" : "s"} across ${judge.bouts.toLocaleString()} bout${judge.bouts === 1 ? "" : "s"}: ${judge.unanimousCards} on unanimous decisions, ${judge.splitCards} on split, ${judge.majorityCards} on majority, ${judge.drawBoutCards} on draws.`);
  if (judge.attributedCards > 0) facts.push(`${judge.dissentCards} of ${judge.attributedCards} orientation-resolved card${judge.attributedCards === 1 ? "" : "s"} went to the fighter who did not win the bout.`);
  if (judge.evenCards > 0) facts.push(`${judge.evenCards} card${judge.evenCards === 1 ? "" : "s"} were scored level — a draw card at the bout level, or a level card inside a majority decision.`);
  if (judge.avgScoreMargin != null) facts.push(`Average margin across ${judge.cards.toLocaleString()} card${judge.cards === 1 ? "" : "s"}: ${judge.avgScoreMargin} points (archive average ${totals.avgScoreMargin}). ${judge.wideCards} card${judge.wideCards === 1 ? "" : "s"} were three points or wider.`);
  if (judge.titleCards > 0) facts.push(`${judge.titleCards} championship card${judge.titleCards === 1 ? "" : "s"} and ${judge.fiveRoundCards} card${judge.fiveRoundCards === 1 ? "" : "s"} on five-round bouts in the loaded archive.`);
  else if (judge.fiveRoundCards > 0) facts.push(`${judge.fiveRoundCards} card${judge.fiveRoundCards === 1 ? "" : "s"} on five-round bouts. Championship status is unpopulated for much of the archive, so a zero title count reflects coverage rather than this official's record.`);

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Judges", href: "/judges" }, { name: judge.displayName }]} />

      <header className="jg-hero">
        <div>
          <div className="eyebrow">Judge intelligence · archive profile</div>
          <h1>{judge.displayName}</h1>
          <p>
            MMA judge{tenure ? ` · scored in the loaded archive ${tenure}` : ""}. <em>{judge.cards.toLocaleString()} archived scorecards</em>
            {judge.titleCards ? <>, <em>{judge.titleCards} title card{judge.titleCards === 1 ? "" : "s"}</em></> : null}.
            {judge.mergedSpellings.length > 0 && <> Also stored in the archive as {judge.mergedSpellings.map((s) => `“${s}”`).join(" and ")}; those cards are counted here.</>}
          </p>
        </div>
        <div className="jg-keystats" aria-label="Key counts">
          <div><b>{judge.cards.toLocaleString()}</b><span>Cards scored</span></div>
          <div><b>{judge.bouts.toLocaleString()}</b><span>Bouts judged</span></div>
          <div><b>{judge.titleCards || "—"}</b><span>Title cards</span></div>
          <div><b>{judge.dissentCards}</b><span>Dissenting cards</span></div>
          <div><b>{judge.evenCards || "—"}</b><span>Level cards</span></div>
          <div><b>{judge.avgScoreMargin ?? "—"}</b><span>Avg margin</span></div>
        </div>
      </header>

      <section className="jg-know">
        <div className="hi">
          <div className="eyebrow">What the sample shows</div>
          <h2>{read.headline}</h2>
          <p>{read.body}</p>
          <div className="jg-sample" aria-label="Sample sizes">
            <span>Cards <b>{judge.cards.toLocaleString()}</b></span>
            <span>Bouts <b>{judge.bouts.toLocaleString()}</b></span>
            <span>Orientation resolved <b>{judge.attributedCards.toLocaleString()}</b></span>
            <span>Dissents <b>{judge.dissentCards}</b></span>
            <span>Archive baseline <b>{(archiveRate * 100).toFixed(1)}%</b> of {totals.attributedCards.toLocaleString()}</span>
          </div>
          {interval && judge.attributedCards >= MIN_RATE_SAMPLE && (
            <div className="jg-interval">
              <div className="jg-interval-bar" role="img" aria-label={`Dissent rate ${(judgeRate * 100).toFixed(1)}% with a 95% interval from ${(interval.low * 100).toFixed(1)}% to ${(interval.high * 100).toFixed(1)}%, against an archive baseline of ${(archiveRate * 100).toFixed(1)}%`}>
                <i style={{ left: `${Math.min(interval.low * 400, 100)}%`, width: `${Math.min((interval.high - interval.low) * 400, 100)}%` }} />
                <u style={{ left: `${Math.min(judgeRate * 400, 100)}%` }} />
                <s style={{ left: `${Math.min(archiveRate * 400, 100)}%` }} />
              </div>
              <div className="jg-interval-key">
                <span>▌ This judge · {(judgeRate * 100).toFixed(1)}%</span>
                <span style={{ color: "var(--pbe-crimson-bright)" }}>▌ Archive · {(archiveRate * 100).toFixed(1)}%</span>
                <span>95% interval {(interval.low * 100).toFixed(1)}%–{(interval.high * 100).toFixed(1)}%</span>
              </div>
            </div>
          )}
          <p className="faint sm">A dissenting card means this judge&apos;s card went to the fighter who did not win the bout. It does not say the card was wrong, and it is not evidence of a preference for any style, nationality or type of fighter.</p>
        </div>
        <div>
          <div className="eyebrow">Archive profile</div>
          <h2>{judge.displayName}</h2>
          <p>{judgeArchiveBio(judge, tenure)}</p>
          <p className="faint sm">No externally sourced biography is attached to this official. PropBetEdge does not generate one, and no personal detail appears here that is not derived from the loaded bout archive.</p>
          {provisional && (
            <p className="jg-provisional">
              <b>This record may be incomplete.</b> The archive also holds cards under{" "}
              <Link href={`/judges/${provisional.otherSlug}`}>{provisional.other}</Link>, a spelling close enough that the two may be
              the same official. They are kept as separate identities here, with separate samples, because PropBetEdge does not merge
              two names on resemblance.{" "}
              {provisional.candidate.status === "externally_confirmed_pending_review" && provisional.candidate.externalSourceUrl ? (
                <>
                  An external registry does now appear to confirm the merge —{" "}
                  <a href={provisional.candidate.externalSourceUrl} target="_blank" rel="noopener">{provisional.candidate.externalSourceName} ↗</a>{" "}
                  — and it is queued for review rather than applied silently.
                </>
              ) : (
                <>No external judging record has confirmed the merge, so it is not applied.</>
              )}
            </p>
          )}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>Scoring record <span className="origin">PBE derived</span></h2>
          <p>Counts from the loaded archive, each stated with the sample it is drawn from.</p>
        </div>
        <ul className="jg-know" style={{ display: "block", padding: "18px 22px", border: "1px solid var(--pbe-line)", borderRadius: 14, background: "rgba(29,25,20,.75)" }}>
          {facts.map((f) => <li key={f} style={{ color: "var(--pbe-paper-2)", font: "400 14px/1.6 var(--pbe-font-ui)", marginLeft: 18, paddingLeft: 4 }}>{f}</li>)}
        </ul>
      </section>

      {dissents.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Cards that differed from the result</h2>
            <p>Bouts where this judge&apos;s card went to the fighter who did not win. Shown as history, not as a verdict on the card.</p>
          </div>
          <div className="jg-cards">
            {dissents.map((c) => (
              <Link href={fightHref(c)} key={`${c.boutId}-${c.cardIndex}`} className="dissent">
                <em>{c.decisionType ? DECISION_LABEL[c.decisionType] : c.methodRaw} · scored {c.rawScore}</em>
                <b>{c.fighterAName} vs {c.fighterBName}</b>
                <span>{c.eventName}{c.eventDate ? ` · ${fmtDate(c.eventDate, { month: "short", day: "numeric", year: "numeric" })}` : ""}</span>
                <span>Card to {c.favoredFighterName} · bout won by {c.winnerName}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {titleCards.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}><h2>Championship cards</h2><p>Title bouts this official scored in the loaded archive.</p></div>
          <div className="jg-cards">
            {titleCards.map((c) => (
              <Link href={fightHref(c)} key={`${c.boutId}-${c.cardIndex}`}>
                <em>Title fight · {weightClassLabel(c.weightClass, c.isWomens)}</em>
                <b>{c.fighterAName} vs {c.fighterBName}</b>
                <span>{c.eventName}{c.eventDate ? ` · ${fmtDate(c.eventDate, { month: "short", day: "numeric", year: "numeric" })}` : ""}</span>
                <span>{c.decisionType ? DECISION_LABEL[c.decisionType] : c.methodRaw} · scored {c.rawScore}{c.favoredFighterName ? ` for ${c.favoredFighterName}` : ""}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}><h2>Most recent cards</h2><p>The newest scorecards carrying this official&apos;s name in the archive.</p></div>
        <div className="jg-cards">
          {recent.map((c) => (
            <Link href={fightHref(c)} key={`${c.boutId}-${c.cardIndex}`} className={c.isDissent ? "dissent" : undefined}>
              <em>{c.eventDate ? fmtDate(c.eventDate, { month: "short", day: "numeric", year: "numeric" }) : "Date unavailable"}</em>
              <b>{c.fighterAName} vs {c.fighterBName}</b>
              <span>{c.eventName}</span>
              <span>
                {c.drawType ? DRAW_LABEL[c.drawType as keyof typeof DRAW_LABEL] : c.decisionType ? DECISION_LABEL[c.decisionType] : c.methodRaw} · scored {c.rawScore}
                {c.favoredFighterName ? ` for ${c.favoredFighterName}` : c.isEvenCard ? " · level card" : c.orientationBasis !== "derived_from_result" ? " · unattributed" : ""}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {events.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}><h2>Related events</h2><p>Cards this official worked in the loaded archive.</p></div>
          <div className="ref-assign">
            {events.map((c) => (
              <Link href={`/events/${eventSlug({ name: c.eventName, event_date: c.eventDate })}`} key={c.eventId}>
                <em>{c.eventDate ? fmtDate(c.eventDate, { month: "short", year: "numeric" }) : "Date unavailable"}</em>
                <b>{c.eventName}</b>
                <span>{[c.venue, c.city, c.country].filter(Boolean).join(" · ") || "Venue unavailable"}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>Scorecard archive</h2>
          <p>Up to 80 of this official&apos;s most recent cards. A dash under a fighter means the archive cannot say which number on that card was theirs.</p>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Date</th><th>Event</th><th>Bout</th><th>Decision</th><th className={styles.num}>Card</th><th>Went to</th><th>Panel</th><th>Source</th></tr></thead>
            <tbody>
              {table.map((c) => (
                <tr key={`${c.boutId}-${c.cardIndex}`}>
                  <td>{c.eventDate ? fmtDate(c.eventDate, { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                  <td><Link href={`/events/${eventSlug({ name: c.eventName, event_date: c.eventDate })}`}>{c.eventName}</Link></td>
                  <td>
                    <Link href={fightHref(c)}>{c.fighterAName} <span className="faint">vs</span> {c.fighterBName}</Link>
                    {c.isTitle ? <span className="tag gold" style={{ marginLeft: 8 }}>Title</span> : null}
                    {c.cardNote ? <><br /><span className="faint">{c.cardNote}</span></> : null}
                  </td>
                  <td><span className={styles.method}>{c.drawType ? DRAW_LABEL[c.drawType as keyof typeof DRAW_LABEL] : c.decisionType ? DECISION_LABEL[c.decisionType] : c.methodRaw}</span>{c.winnerName ? <><br /><span className="faint">{c.winnerName} won</span></> : null}</td>
                  <td className={styles.num}>{c.fighterAScore != null ? `${c.fighterAScore}–${c.fighterBScore}` : `${c.scoreFirst}–${c.scoreSecond}`}</td>
                  <td>{c.favoredFighterName || (c.isEvenCard ? <span className="faint">Level</span> : <span className="faint">Unattributed</span>)}{c.isDissent ? <><br /><span style={{ color: "var(--pbe-crimson-bright)" }}>Dissent</span></> : null}</td>
                  <td className="faint">{c.panel.filter((p) => p !== c.judge).join(", ") || "—"}</td>
                  <td><a href={c.sourceUrl} target="_blank" rel="noopener">{c.resultSource === "espn" ? "ESPN" : "UFC Stats"} ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className={styles.note}>
        <b>How to read this page</b>
        <p>
          Everything above is a description of {judge.cards.toLocaleString()} scorecard{judge.cards === 1 ? "" : "s"} currently loaded
          into the PropBetEdge archive. It is not a career record, not an assessment of judging quality, and not a claim that this
          official favours any style, nationality or type of fighter. Rates are withheld below {MIN_RATE_SAMPLE} orientation-resolved
          cards and are only described as differing from the archive when a 95% test says the difference survives the sample size.
        </p>
        <p>
          Fighter attribution is derived from each bout&apos;s recorded result rather than assumed from the order of the two numbers.
          Where a card cannot be oriented — every draw, and any bout whose cards contradict the result — the pair is shown as
          recorded and marked unattributed. See the <Link href="/judges#methodology">methodology</Link>.
        </p>
      </div>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "ProfilePage",
        name: `${judge.displayName} UFC judge profile`, url: `${SITE.url}/judges/${judge.slug}`,
        dateModified: judge.lastEventDate || undefined,
        mainEntity: { "@type": "Person", name: judge.displayName, jobTitle: "Mixed martial arts judge", description: judgeArchiveBio(judge, tenure) },
        isPartOf: { "@id": `${SITE.url}/#site` },
      }} />
    </div>
  );
}
