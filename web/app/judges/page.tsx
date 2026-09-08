import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { getJudgeArchive, getScorecardCoverage, tenureLine } from "@/lib/judges";
import { PROVISIONAL_IDENTITY_CANDIDATES, SPELLING_VARIANT_EVIDENCE } from "@/lib/judgeScoring";
import { GAP_LABEL, GAP_REASON_LABEL, MIN_RATE_SAMPLE, dissentRead } from "@/lib/judgeScoring";
import { fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";
import styles from "./judges.module.css";

/* /judges — the directory, plus the coverage register.
 *
 * The register is on the index rather than hidden on a QA page on purpose:
 * the product's claim is that a scorecard is shown where one exists and an
 * absence is shown where one does not, and that claim is only credible if the
 * size and shape of what is missing is published next to it. */
export const revalidate = 900;

export const metadata: Metadata = {
  title: "UFC Judges — Scorecard Directory, Dissents & Judging History",
  description:
    "Judge intelligence directory: every judge named on a scorecard in the loaded UFC result archive, with cards scored, decision types, dissenting cards, draw cards, average score margin and title-fight experience — each with its sample size.",
  alternates: { canonical: "/judges" },
  openGraph: { title: "UFC Judge Intelligence — PropBetEdge", description: "Attributed official scorecards and descriptive judging history from the PropBetEdge UFC archive.", url: `${SITE.url}/judges` },
  twitter: { card: "summary_large_image", title: "UFC Judge Intelligence — PropBetEdge" },
};

const GAP_TINT: Record<string, string> = {
  recoverable: "var(--pbe-pos)",
  identity_mismatch: "var(--pbe-gold)",
  source_unavailable: "var(--pbe-subtle)",
  non_standard: "var(--pbe-crimson)",
};

export default async function JudgesPage() {
  const [archive, coverage] = await Promise.all([getJudgeArchive(), getScorecardCoverage()]);
  const judges = archive.judges;
  const { totals } = archive;
  const top = judges[0];
  const titleJudges = judges.filter((j) => j.titleCards > 0).length;
  const rated = judges.filter((j) => j.attributedCards >= MIN_RATE_SAMPLE).length;
  const featured = judges.slice(0, 12);

  const buckets = coverage.byClassification.reduce<Record<string, { total: number; reasons: Array<{ reason: string; count: number }> }>>((acc, row) => {
    const hit = acc[row.classification] || { total: 0, reasons: [] };
    hit.total += row.count;
    hit.reasons.push({ reason: row.reason, count: row.count });
    acc[row.classification] = hit;
    return acc;
  }, {});
  const bucketOrder = ["recoverable", "identity_mismatch", "source_unavailable", "non_standard"].filter((k) => buckets[k]);

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Judges" }]} />

      <section className={styles.hero}>
        <div>
          <div className="eyebrow">Officials · the three cards that decide a fight</div>
          <h1>Judge Intelligence</h1>
          <p>
            Every judge named on a scorecard in the loaded UFC result archive, with the cards they turned in. PropBetEdge stores a
            bare score pair for each card — the source never says which number belongs to which fighter — so each bout&rsquo;s
            orientation is <strong>derived from the recorded result</strong> and the cards it produced, and any card the evidence
            cannot orient is shown as an unattributed pair rather than guessed. Counts describe the loaded archive, not a career, and
            every rate on these pages carries its sample size.
          </p>
          <nav className="ref-filters" aria-label="Jump to">
            <a href="#by-cards">By cards scored</a>
            <a href="#title-judges">Title-fight judges · {titleJudges}</a>
            <a href="#coverage">Scorecard coverage</a>
            <a href="#all-judges">Full index · {judges.length}</a>
            <a href="#methodology">Methodology</a>
          </nav>
        </div>
        <aside className={styles.heroAside}>
          <b>{judges.length.toLocaleString()}</b><span>judges indexed</span>
          <b style={{ marginTop: 18 }}>{totals.cards.toLocaleString()}</b><span>scorecards attributed</span>
          <b style={{ marginTop: 18 }}>{totals.bouts.toLocaleString()}</b><span>bouts with an official card</span>
          {top && <><b style={{ marginTop: 18 }}>{top.displayName}</b><span>largest sample · {top.cards.toLocaleString()} cards</span></>}
        </aside>
      </section>

      {judges.length === 0 ? (
        <div className={styles.empty}>Judge scorecards will appear here as completed UFC results are loaded.</div>
      ) : (
        <>
          <section id="by-cards" className={styles.section}>
            <div className={styles.sectionHead}>
              <h2>Most cards in the archive</h2>
              <p>Ranked by scorecards held, not by career volume — historical coverage is still being backfilled.</p>
            </div>
            <div className="jg-grid">
              {featured.map((j, i) => {
                const read = dissentRead({
                  displayName: j.displayName, dissents: j.dissentCards, attributed: j.attributedCards,
                  archiveDissents: totals.dissentCards, archiveAttributed: totals.attributedCards,
                });
                const tenure = tenureLine(j);
                return (
                  <Link href={`/judges/${j.slug}`} className="jg-card" key={j.slug}>
                    <h2>{j.displayName}</h2>
                    <span className="jg-role"><em>#{i + 1}</em> by cards scored{tenure ? ` · ${tenure}` : ""}</span>
                    <span className="jg-stats">
                      <span><b>{j.cards.toLocaleString()}</b><span>Cards</span></span>
                      <span><b>{j.bouts.toLocaleString()}</b><span>Bouts</span></span>
                      <span><b>{j.dissentCards}</b><span>Dissents</span></span>
                      <span><b>{j.titleCards || "—"}</b><span>Title</span></span>
                    </span>
                    <span className="jg-read"><strong>{read.headline}.</strong> {read.body}</span>
                    <span className="jg-more">Open judge profile →</span>
                  </Link>
                );
              })}
            </div>
          </section>

          <section id="title-judges" className={styles.section}>
            <div className={styles.sectionHead}>
              <h2>Title-fight judges</h2>
              <p>Judges with at least one championship card in the loaded archive. Championship status is populated on only part of the archive, so this undercounts real title assignments.</p>
            </div>
            <div className="ref-assign">
              {judges.filter((j) => j.titleCards > 0).sort((a, b) => b.titleCards - a.titleCards).slice(0, 9).map((j) => (
                <Link href={`/judges/${j.slug}`} key={j.slug}>
                  <em>{j.titleCards} title card{j.titleCards === 1 ? "" : "s"}</em>
                  <b>{j.displayName}</b>
                  <span>{j.fiveRoundCards} five-round · {j.cards.toLocaleString()} cards total</span>
                </Link>
              ))}
            </div>
          </section>

        </>
      )}

      <section id="coverage" className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>Scorecard coverage</h2>
          <p>What the archive holds, and what it does not. Published because a product that shows absences honestly has to show the size of the absence too.</p>
        </div>
        <div className="jg-cov">
          <div>
            <b>{coverage.judgedResults.toLocaleString()}</b><span>Went to the judges</span>
            <p>Decision and draw results in the archive. These are the only bouts for which an official scorecard can exist.</p>
          </div>
          <div>
            <b>{coverage.withScorecards.toLocaleString()}</b><span>With a scorecard</span>
            <p>{((coverage.withScorecards / Math.max(coverage.judgedResults, 1)) * 100).toFixed(1)}% of judged results, holding {totals.cards.toLocaleString()} individual cards.</p>
          </div>
          <div>
            <b>{coverage.missingScorecards.toLocaleString()}</b><span>Missing a scorecard</span>
            <p>Classified below by what closing each one would take. Nothing here is estimated to fill the gap.</p>
          </div>
          <div>
            <b>{coverage.finishesNoScorecardExpected.toLocaleString()}</b><span>Finishes · no card expected</span>
            <p>KO/TKO, submission, DQ and no-contest results. {coverage.finishesWithUnexpectedScorecard === 0 ? "None carries a scorecard, which is correct — these fights never reached the judges." : `${coverage.finishesWithUnexpectedScorecard} carries a scorecard and is under investigation.`}</p>
          </div>
        </div>

        <div className="jg-bar" aria-hidden="true">
          {bucketOrder.map((k) => (
            <i key={k} style={{ width: `${(buckets[k].total / Math.max(coverage.missingScorecards, 1)) * 100}%`, background: GAP_TINT[k] }} />
          ))}
        </div>
        <div className="jg-bar-key">
          {bucketOrder.map((k) => (
            <span key={k}><i style={{ background: GAP_TINT[k] }} />{GAP_LABEL[k as keyof typeof GAP_LABEL]} · {buckets[k].total}</span>
          ))}
        </div>

        <div className="jg-cov" style={{ marginTop: 18 }}>
          {bucketOrder.map((k) => (
            <div key={k}>
              <b>{buckets[k].total}</b><span>{GAP_LABEL[k as keyof typeof GAP_LABEL]}</span>
              <ul>
                {buckets[k].reasons.sort((a, b) => b.count - a.count).map((r) => (
                  <li key={r.reason}>{r.count} · {GAP_REASON_LABEL[r.reason as keyof typeof GAP_REASON_LABEL] || r.reason}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {coverage.gaps.filter((g) => g.classification !== "source_unavailable").length > 0 && (
          <div className={styles.tableWrap} style={{ marginTop: 18 }}>
            <table className={styles.table}>
              <thead><tr><th>Date</th><th>Event</th><th>Bout</th><th>Method</th><th>Classification</th><th>What it would take</th></tr></thead>
              <tbody>
                {coverage.gaps.filter((g) => g.classification !== "source_unavailable").map((g) => (
                  <tr key={g.boutId}>
                    <td>{g.eventDate ? fmtDate(g.eventDate, { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                    <td>{g.eventName}</td>
                    <td>{g.fighterAName} <span className="faint">vs</span> {g.fighterBName}</td>
                    <td><span className={styles.method}>{g.methodRaw}</span></td>
                    <td>{GAP_LABEL[g.classification]}</td>
                    <td className="faint">{GAP_REASON_LABEL[g.reason]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint sm mt-3">
          The {buckets.source_unavailable?.total ?? 0} source-unavailable bouts are not listed row by row: they are dominated by a
          series the scorecard source does not cover at all, plus pre-2003 cards the source never recorded. Both are properties of
          the source, not of a specific fight.
        </p>
      </section>

      {judges.length > 0 && (
      <section id="all-judges" className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>Full judge index</h2>
          <p>All {judges.length} judges in the archive. A dissent is a card that went to the fighter who did not win the bout; the rate is withheld below {MIN_RATE_SAMPLE} resolved cards, which is why {judges.length - rated} of these rows show counts only.</p>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Judge</th><th>Active</th><th className={styles.num}>Cards</th><th className={styles.num}>Bouts</th>
                <th className={styles.num}>Unanimous</th><th className={styles.num}>Split</th><th className={styles.num}>Majority</th>
                <th className={styles.num}>Draw cards</th><th className={styles.num}>Dissents</th><th className={styles.num}>Dissent rate</th>
                <th className={styles.num}>Avg margin</th><th className={styles.num}>Title</th>
              </tr>
            </thead>
            <tbody>
              {judges.map((j) => {
                const rate = j.attributedCards >= MIN_RATE_SAMPLE ? `${((j.dissentCards / j.attributedCards) * 100).toFixed(1)}%` : null;
                return (
                  <tr key={j.slug}>
                    <td><Link href={`/judges/${j.slug}`}>{j.displayName}</Link></td>
                    <td>{tenureLine(j) || "—"}</td>
                    <td className={styles.num}>{j.cards.toLocaleString()}</td>
                    <td className={styles.num}>{j.bouts.toLocaleString()}</td>
                    <td className={styles.num}>{j.unanimousCards}</td>
                    <td className={styles.num}>{j.splitCards}</td>
                    <td className={styles.num}>{j.majorityCards}</td>
                    <td className={styles.num}>{j.evenCards || "—"}</td>
                    <td className={styles.num}>{j.dissentCards}</td>
                    <td className={styles.num}>{rate ?? <span className="faint" title={`${j.attributedCards} resolved cards — below the ${MIN_RATE_SAMPLE}-card floor`}>n={j.attributedCards}</span>}</td>
                    <td className={styles.num}>{j.avgScoreMargin ?? "—"}</td>
                    <td className={styles.num}>{j.titleCards || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      )}

      <div id="methodology" className={styles.note}>
        <b>Methodology</b>
        <p>
          <strong>Where the scores come from.</strong> Each stored card is a judge name and a bare score pair such as
          &ldquo;27-30&rdquo;. The source attaches no fighter to either number. For every bout, PropBetEdge counts which position
          carried the winning cards and takes that position as the winner&rsquo;s — the winner necessarily won more cards than they
          lost. That resolves {totals.attributedCards.toLocaleString()} of {totals.cards.toLocaleString()} cards. The remaining{" "}
          {totals.unattributedCards.toLocaleString()} are shown as bare pairs and marked unattributed:{" "}
          {totals.unattributedNoWinner.toLocaleString()} on draws, where there is no winner to anchor on, and{" "}
          {totals.unattributedConflicting.toLocaleString()} whose tally contradicts the recorded result.
        </p>
        <p>
          <strong>Identity.</strong> Judge names are canonicalised the same way referee names are. The upstream Details line
          sometimes prefixes a point deduction onto the judge&rsquo;s name (&ldquo;Low Blow by Watson Richard Bertrand&rdquo;); those
          are mapped to the official and the deduction is kept as bout provenance. Merging two <em>names</em> is different: it
          combines two people&rsquo;s records, so it is only done when an external judging registry holds a single official whose
          scored bouts account for the assignments filed under both spellings. Resemblance is not evidence, and the database refuses
          a merge with no source attached.
        </p>
        {SPELLING_VARIANT_EVIDENCE.length > 0 && (
          <p>
            <strong>Merges applied ({SPELLING_VARIANT_EVIDENCE.length}).</strong>{" "}
            {SPELLING_VARIANT_EVIDENCE.map((e) => (
              <span key={e.rawName}>
                &ldquo;{e.rawName}&rdquo; → &ldquo;{e.canonical}&rdquo;, confirmed against{" "}
                <a href={e.sourceUrl} target="_blank" rel="noopener">{e.sourceName} ↗</a> (verified {e.verifiedAt}) by cross-matching{" "}
                {e.crossMatchedEvents.length} assignments. {e.limits}{" "}
              </span>
            ))}
          </p>
        )}
        {PROVISIONAL_IDENTITY_CANDIDATES.length > 0 && (
          <p>
            <strong>Under review, not merged ({PROVISIONAL_IDENTITY_CANDIDATES.length}).</strong>{" "}
            {PROVISIONAL_IDENTITY_CANDIDATES.map((c) => (
              <span key={c.names.join("|")}>
                &ldquo;{c.names[0]}&rdquo; and &ldquo;{c.names[1]}&rdquo; keep separate profiles and separate samples.{" "}
                {c.externalSourceUrl ? (
                  <>Evidence now exists (<a href={c.externalSourceUrl} target="_blank" rel="noopener">{c.externalSourceName} ↗</a>) and the merge is queued for review rather than applied silently. </>
                ) : (
                  <>No external judging record confirms the merge. </>
                )}
              </span>
            ))}
          </p>
        )}
        <p>
          <strong>What these numbers are not.</strong> A dissent count says a judge&rsquo;s card differed from the official result. It
          does not say the card was wrong, and it is not evidence that an official favours a style, a nationality or any type of
          fighter — the archive cannot support that claim, so this product does not make it. Rates are withheld below{" "}
          {MIN_RATE_SAMPLE} resolved cards and are only described as differing from the archive when the difference survives a
          95% significance test against the archive baseline of{" "}
          {((totals.dissentCards / Math.max(totals.attributedCards, 1)) * 100).toFixed(1)}%.
        </p>
        <p>
          {archive.totals.shapeMismatchBouts} bout{archive.totals.shapeMismatchBouts === 1 ? "" : "s"} in the archive have cards whose
          shape disagrees with the recorded method. Those are flagged on the fight page rather than corrected.
        </p>
      </div>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "CollectionPage", "@id": `${SITE.url}/judges#collection`,
        url: `${SITE.url}/judges`, name: "UFC judge intelligence directory", isPartOf: { "@id": `${SITE.url}/#site` },
        mainEntity: { "@type": "ItemList", itemListElement: judges.slice(0, 50).map((j, i) => ({ "@type": "ListItem", position: i + 1, name: j.displayName, url: `${SITE.url}/judges/${j.slug}` })) },
      }} />
    </div>
  );
}
