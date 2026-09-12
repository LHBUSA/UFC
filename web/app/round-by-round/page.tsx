import type { Metadata } from "next";
import Link from "next/link";
import { Avatar, Breadcrumbs, JsonLd } from "@/components/ui";
import type { PortraitSet } from "@/lib/db";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import { buildSections, getRoundIndex, type RoundIndexBout } from "@/lib/roundIndex";
import { fmtDate, METHOD_SHORT, weightClassLabel } from "@/lib/format";
import { matchupSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";
import { getRoundLiveState } from "@/lib/roundLive";
import { RoundLiveDeck } from "@/components/RoundLiveDeck";
import styles from "./round-by-round.module.css";
import cardStyles from "./round-cards.module.css";

/* /round-by-round is the discovery surface for the verified round archive.
 * Nothing on this page is inferred. Every fight shown here has stored round
 * observations behind it, and every coverage number comes from the same read
 * model that powers the fight links. Fighter imagery uses the shared verified
 * display resolver: stored assets first, ESPN for coverage, bad mappings out. */
export const revalidate = 300;

const TITLE = "UFC Round-by-Round Analysis | PropBetEdge";
const DESCRIPTION =
  "Round-level UFC fight intelligence reconstructed from verified fight data, with striking, grappling, control and Fight DNA context.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/round-by-round" },
  keywords: ["UFC round by round", "UFC round stats", "significant strikes by round", "UFC control time", "round-by-round analysis", "Fight DNA"],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: `${SITE.url}/round-by-round`,
    images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630, alt: "PropBetEdge UFC Round-by-Round Analysis" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

function boutHref(b: RoundIndexBout) {
  return `/fights/${matchupSlug(b.fighterA, b.fighterB, { name: b.eventName, event_date: b.eventDate })}`;
}

function pct(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
}

function FightCard({ b, images, highlight = false }: { b: RoundIndexBout; images: Map<string, PortraitSet>; highlight?: boolean }) {
  const wc = weightClassLabel(b.weightClass, b.isWomens);
  const winner = b.winnerId === b.fighterA.id ? "a" : b.winnerId === b.fighterB.id ? "b" : null;
  const finish = b.method ? `${METHOD_SHORT[b.method] || b.method}${b.finishRound ? ` · R${b.finishRound}` : ""}` : null;
  const imageA = images.get(b.fighterA.id);
  const imageB = images.get(b.fighterB.id);

  return (
    <Link href={boutHref(b)} className={`${styles.fightCard} ${cardStyles.visualCard}${highlight ? ` ${cardStyles.recentCard}` : ""}`}>
      <span className={styles.cardTop}>
        <span className={styles.event}>{b.eventName}</span>
        <span className={styles.date}>{b.eventDate ? fmtDate(b.eventDate, DAY) : "Date unrecorded"}</span>
      </span>

      <span className={`${styles.matchup} ${cardStyles.matchupVisual}`}>
        <span className={`${styles.fighter} ${cardStyles.fighterVisual}${winner === "a" ? ` ${styles.winner} ${cardStyles.winnerVisual}` : ""}`}>
          <span className={cardStyles.fighterFace}>
            <Avatar f={b.fighterA} img={imageA} size={68} className={cardStyles.roundAvatar} />
            {winner === "a" ? <i className={cardStyles.winBadge}>WIN</i> : null}
          </span>
          <span className={styles.corner}>A corner</span>
          <b>{b.fighterA.name}</b>
        </span>
        <span className={`${styles.versus} ${cardStyles.vsVisual}`}>VS</span>
        <span className={`${styles.fighter} ${cardStyles.fighterVisual}${winner === "b" ? ` ${styles.winner} ${cardStyles.winnerVisual}` : ""}`}>
          <span className={cardStyles.fighterFace}>
            <Avatar f={b.fighterB} img={imageB} size={68} className={cardStyles.roundAvatar} />
            {winner === "b" ? <i className={cardStyles.winBadge}>WIN</i> : null}
          </span>
          <span className={styles.corner}>B corner</span>
          <b>{b.fighterB.name}</b>
        </span>
      </span>

      <span className={styles.cardMeta}>
        {wc ? <span>{wc}</span> : null}
        {b.isTitle ? <span className={styles.goldTag}>Championship</span> : null}
        {finish ? <span>{finish}</span> : null}
        {b.scheduledRounds ? <span>{b.scheduledRounds}R scheduled</span> : null}
      </span>

      <span className={styles.coverageRow}>
        <span className={styles.roundSignal} aria-label={`${b.roundsCovered} rounds of recorded data`}>
          {Array.from({ length: Math.max(1, b.roundsCovered) }, (_, i) => <i key={i} />)}
        </span>
        <span className={styles.coverageCopy}>
          <b>{b.roundsCovered} round{b.roundsCovered === 1 ? "" : "s"}</b> recorded
          <em className={b.bothCorners ? styles.verified : styles.partial}>
            {b.bothCorners ? "Both corners verified" : "One-corner coverage"}
          </em>
        </span>
      </span>

      <span className={styles.cardCta}>Open round intelligence <b>→</b></span>
    </Link>
  );
}

export default async function RoundByRoundIndex() {
  /* Fight-night state and the archive are independent reads. If the broadcast
   * layer is unavailable the deck simply does not render and the archive page
   * below is untouched — the two must never be able to break each other. */
  const [index, liveState] = await Promise.all([
    getRoundIndex(),
    getRoundLiveState().catch(() => null),
  ]);
  const ok = index.status === "ok" ? index : null;
  const t = ok?.totals;
  const sections = buildSections(index);
  const recent = ok?.shelves.recent || [];
  const visibleFighterIds = [...new Set(sections.flatMap((section) => section.bouts.flatMap((b) => [b.fighterA.id, b.fighterB.id])))];
  const images = await getVerifiedDisplayImagesForFighters(visibleFighterIds);
  const rounds = [1, 2, 3, 4, 5].map((n) => ({ n, count: t?.byObservedRounds[n] || 0 }));
  const maxRoundBucket = Math.max(1, ...rounds.map((r) => r.count));
  const completeCoverage = t ? pct(t.bothCorners, t.eligible) : 0;

  return (
    <div className={`wrap page ${styles.page}`}>
      <Breadcrumbs items={[{ name: "Round-by-Round" }]} />

      {/* Band 1 + 2: the live event, then tonight's completed-fight round
          intelligence. Renders only when there is a card to talk about; the
          archive below is the page's permanent state. */}
      {liveState?.broadcast ? <RoundLiveDeck state={liveState} /> : null}

      <header className={styles.hero}>
        <div className={styles.heroGrid} aria-hidden="true" />
        <div className={styles.heroCopy}>
          <div className={styles.kicker}>
            <span className={styles.pulse} />
            PropBetEdge fight intelligence
          </div>
          <h1>Every round tells a different fight.</h1>
          <p>
            Verified round-level observations across the UFC archive. Read the shifts in striking,
            grappling, control and target selection that final results flatten into a single line.
          </p>
          {ok?.freshness.lastRoundCaptureAt ? (
            <div className={styles.freshness}>
              <span>Archive refreshed</span>
              <b>{fmtDate(ok.freshness.lastRoundCaptureAt.slice(0, 10), DAY)}</b>
              <i />
              <span>Source rows</span>
              <b>{ok.freshness.roundRows.toLocaleString()}</b>
            </div>
          ) : null}
        </div>

        {t ? (
          <div className={styles.heroProof}>
            <span className={styles.proofLabel}>Verified archive</span>
            <strong>{t.eligible.toLocaleString()}</strong>
            <span>fights with round data</span>
            <div className={styles.proofMeter}><i style={{ width: `${completeCoverage}%` }} /></div>
            <div className={styles.proofFoot}>
              <b>{completeCoverage}%</b>
              <span>both-corner coverage</span>
            </div>
          </div>
        ) : null}
      </header>

      {!ok || !t ? (
        <section className={styles.stateCard} role="status">
          <div className={styles.stateMark}>!</div>
          <div>
            <div className={styles.stateKicker}>Round index temporarily unavailable</div>
            <h2>We will not fake an archive state.</h2>
            <p>The round-level read could not be completed, so counts and fight lists are withheld rather than shown as partial data. Individual fight pages are unaffected.</p>
          </div>
        </section>
      ) : t.eligible === 0 ? (
        <section className={styles.stateCard}>
          <div className={styles.stateMark}>0</div>
          <div>
            <div className={styles.stateKicker}>Archive empty</div>
            <h2>No round observations loaded yet.</h2>
            <p>Nothing is estimated in the meantime.</p>
          </div>
        </section>
      ) : (
        <>
          <section className={styles.commandDeck} aria-label="Round archive coverage">
            <div className={styles.deckIntro}>
              <span>Archive coverage</span>
              <h2>Round data at a glance</h2>
              <p>
                Coverage spans {t.firstEventDate ? fmtDate(t.firstEventDate, DAY) : "the earliest loaded event"} through {t.lastEventDate ? fmtDate(t.lastEventDate, DAY) : "the latest loaded event"}.
              </p>
            </div>

            <div className={styles.kpis}>
              <div className={styles.kpi}><span>Fights</span><b>{t.eligible.toLocaleString()}</b><small>with round observations</small></div>
              <div className={styles.kpi}><span>Both corners</span><b>{t.bothCorners.toLocaleString()}</b><small>{completeCoverage}% complete coverage</small></div>
              <div className={styles.kpi}><span>Five-round fights</span><b>{t.scheduledFiveRound.toLocaleString()}</b><small>scheduled distance</small></div>
              <div className={styles.kpi}><span>Five rounds recorded</span><b>{t.fiveRoundsRecorded.toLocaleString()}</b><small>observed through round 5</small></div>
            </div>

            <div className={styles.distribution}>
              <div className={styles.distributionHead}>
                <span>Observed fight length</span>
                <small>distinct rounds with stored data</small>
              </div>
              <div className={styles.bars}>
                {rounds.map((r) => (
                  <div className={styles.barRow} key={r.n}>
                    <span>R{r.n}</span>
                    <i><b style={{ width: `${(r.count / maxRoundBucket) * 100}%` }} /></i>
                    <strong>{r.count.toLocaleString()}</strong>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <nav className={styles.shelfNav} aria-label="Round archive collections">
            <span>Jump to</span>
            {sections.map((s) => <a href={`#${s.key}`} key={s.key}>{s.title}</a>)}
          </nav>

          {sections.map((s, sectionIndex) => (
            <section className={styles.shelf} key={s.key} id={s.key}>
              <div className={styles.shelfHead}>
                <div>
                  <span className={styles.shelfNumber}>{String(sectionIndex + 1).padStart(2, "0")}</span>
                  <div>
                    <h2>{s.title}</h2>
                    <p>{s.blurb}</p>
                  </div>
                </div>
                <span className={styles.shelfCount}>{s.bouts.length} fights loaded</span>
              </div>
              <div className={styles.fightGrid}>
                {s.bouts.map((b) => <FightCard b={b} images={images} highlight={s.key === "recent"} key={`${s.key}-${b.boutId}`} />)}
              </div>
            </section>
          ))}
        </>
      )}

      <section className={styles.methodology}>
        <div>
          <span className={styles.methodKicker}>Data discipline</span>
          <h2>Observed. Attributed. Never invented.</h2>
        </div>
        <div className={styles.methodCopy}>
          <p>Every number comes from stored round-level observations of a completed fight. Missing observations stay unavailable rather than becoming zero, and unrecorded rounds are never inferred.</p>
          <p>Round signals describe measurable changes in output, control and targeting. They are not judge scores and do not claim who won a round.</p>
          {ok ? (
            <div className={styles.archiveStamp}>
              <span>Archive build</span>
              <b>{fmtDate(ok.generatedAt.slice(0, 10), DAY)}</b>
              <span>·</span>
              <b>{ok.freshness.roundRows.toLocaleString()} round observations</b>
            </div>
          ) : null}
        </div>
      </section>

      <p className={styles.disclaimer}>PropBetEdge is an independent sports intelligence product and is not affiliated with the UFC, Zuffa LLC, TKO Group or ESPN.</p>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          "@id": `${SITE.url}/round-by-round#collection`,
          url: `${SITE.url}/round-by-round`,
          name: "UFC Round-by-Round Analysis",
          description: DESCRIPTION,
          isPartOf: { "@id": `${SITE.url}/#site` },
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: recent.length,
            itemListElement: recent.map((b, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: `${b.fighterA.name} vs ${b.fighterB.name}`,
              url: `${SITE.url}${boutHref(b)}`,
            })),
          },
        }}
      />
    </div>
  );
}
