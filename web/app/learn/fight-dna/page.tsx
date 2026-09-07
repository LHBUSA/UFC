import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { DnaPipeline } from "@/components/DnaPipeline";
import { Origin, ConfKey } from "@/components/dna";
import { CONFIDENCE_EXPLAINER, FAMILY, GLOSSARY, PBE_DERIVED_EXPLAINER, SOURCE_VS_DERIVED, type DnaFamily } from "@/lib/dnaGlossary";
import { SITE } from "@/lib/site";
import { ApiCta } from "@/components/ApiCta";

/* /learn/fight-dna — how to read Fight DNA, and why it is proprietary.
 * Two jobs: teach a casual fan to read every metric in under a minute, and
 * make the system (normalized record → as-of reconstruction → versioned
 * feature system → confidence + provenance → matchup intelligence) obvious.
 * No gambling promises, no predictive certainty, no UFC affiliation. */
export const revalidate = 3600;

const TITLE = "How to Read Fight DNA — PropBetEdge Fight DNA";
const DESCRIPTION = "PropBetEdge Fight DNA: proprietary UFC fighter intelligence derived from normalized event, bout and round-level fight records. Learn what significant strikes per minute, takedowns per 15, finish rate, stance splits, round profiles, confidence tiers and PBE Derived mean, and why as-of reconstruction, sample size and versioned definitions matter.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/learn/fight-dna" },
  keywords: ["Fight DNA", "UFC advanced stats", "MMA analytics", "significant strikes per minute", "takedowns per 15 minutes", "finish rate", "stance splits", "PropBetEdge"],
  openGraph: { title: "PropBetEdge Fight DNA — Proprietary UFC Fighter Intelligence", description: DESCRIPTION, type: "article", url: `${SITE.url}/learn/fight-dna`, images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630, alt: "PropBetEdge Fight DNA" }] },
  twitter: { card: "summary_large_image", title: "Fight DNA: Advanced MMA Analytics, Fighter Profiles & Matchup Intelligence", description: DESCRIPTION },
};

const TOC: Array<[string, string]> = [
  ["what", "What Fight DNA is"], ["what-not", "What it is not"], ["pipeline", "The data pipeline"], ["as-of", "Why as-of matters"], ["normalization", "Why normalization matters"], ["sample-size", "Sample size"], ["confidence", "Confidence"],
  ["striking", "Striking DNA"], ["takedowns", "Grappling DNA"], ["finish-rate", "Finish DNA"], ["round-profiles", "Round DNA"], ["stance-splits", "Stance DNA"], ["context-splits", "Context DNA"], ["matchup", "Matchup DNA"],
  ["pbe-derived", "PBE Derived"], ["source-vs-derived", "Source vs derived"], ["versioning", "Versioning"], ["limits", "What it cannot tell you"], ["glossary", "Glossary"],
];

const ORDER: Array<Exclude<DnaFamily, "quick" | "coverage" | "matchup">> = ["striking", "grappling", "finish", "round", "stance", "context"];

export default function LearnFightDna() {
  const terms = Object.values(GLOSSARY);
  return (
    <div className="wrap page learn">
      <Breadcrumbs items={[{ name: "Fight DNA", href: "/fighters" }, { name: "How to read Fight DNA" }]} />

      <header className="learn-hero">
        <div className="eyebrow">PropBetEdge Fight DNA · proprietary fighter intelligence</div>
        <h1>Fight DNA. <em>From fight records to fight intelligence.</em></h1>
        <p className="lede">Fight DNA transforms normalized event, bout and round-level fight records into proprietary metrics covering pace, opponent stance, striking geography, grappling efficiency, finishing patterns, round progression and matchup context. Every metric carries its supporting sample, provenance, confidence and definition version.</p>
        <div className="dna-contrast"><span>Raw data tells you what happened.</span><span>Fight DNA describes the fighter the data reveals.</span></div>
        <div className="actions"><Link href="/fighters" className="btn gold">Explore a fighter →</Link><Link href="/fight-week" className="btn">See Fight Week →</Link><Link href="/pro" className="btn">Go Pro →</Link></div>
        <ul className="learn-toc" aria-label="On this page">{TOC.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul>
      </header>

      <section className="learn-sec" id="what">
        <div className="eyebrow">01</div>
        <h2>What Fight DNA is</h2>
        <p><strong>Fight DNA is PropBetEdge&apos;s proprietary analytics layer above the normalized UFC record.</strong> The inputs are ordinary source facts: an event date, a bout result, strikes landed and attempted, takedowns, control time, per-round rows from UFC Stats. The product is what PropBetEdge builds from them: a versioned, reproducible, as-of feature system that turns a fighter&apos;s event-dated history into fighter-specific and matchup-specific intelligence.</p>
        <p>Every Fight DNA metric keeps its definition, sample size, provenance, as-of date, confidence tier, coverage state and definition version. That packet of context is part of the product, not a footnote.</p>
        <div className="learn-ex"><b>In one line</b><p>Not simply republished source statistics. Derived by PropBetEdge from the normalized fight record, and shown with receipts.</p></div>
      </section>

      <section className="learn-sec" id="what-not">
        <div className="eyebrow">02</div>
        <h2>What it is not</h2>
        <ul>
          <li>Not an official UFC statistic, and not affiliated with the UFC, Zuffa LLC, TKO Group, ESPN or any sportsbook.</li>
          <li>Not a prediction. Fight DNA describes what the record shows; it does not claim a fighter will reproduce a number in the next fight.</li>
          <li>Not a grade. There are no letter scores, gauges, percentiles or &ldquo;elite&rdquo; labels, because no benchmark in the system would justify them.</li>
          <li>Not a career snapshot copied from a source profile. Career-to-date figures on a fighter row are display fields; Fight DNA is rebuilt from event-dated bout and round rows.</li>
          <li>Not betting advice. PropBetEdge Pro sells intelligence, not guaranteed outcomes.</li>
        </ul>
      </section>

      <section className="learn-sec" id="pipeline">
        <div className="eyebrow">03</div>
        <h2>The data pipeline</h2>
        <p>The moat is the system, not any single stat. Six stages, each reproducible from the one before it.</p>
        <div className="mt-4"><DnaPipeline /></div>
      </section>

      <section className="learn-sec" id="as-of">
        <div className="eyebrow">04</div>
        <h2>Why as-of matters</h2>
        <p>Fight DNA can reconstruct a fighter using only the information that existed at a particular point in time. A snapshot dated the morning of a card includes every bout before that date and nothing after it, so a historical matchup read is never contaminated by fights that had not happened yet.</p>
        <div className="learn-ex"><b>Example</b><p>A fighter has ten archived bouts. The snapshot for a fight in year three is built from the bouts before that date only. When you open an archived matchup page, the Fight DNA you see is the version that could have been known then, and the as-of date is printed beside it.</p></div>
      </section>

      <section className="learn-sec" id="normalization">
        <div className="eyebrow">05</div>
        <h2>Why normalization matters</h2>
        <p>Round stats arrive as raw counts: 32 significant strikes landed in a round, 90 attempted, 1:45 of control. Counts are hard to compare across fights of different lengths, so Fight DNA normalizes them to observed time. Per-minute rates divide by the minutes actually covered by round stats; per-15 rates scale to the length of a standard three-round fight. A 90-second finish and a 25-minute decision become comparable, and the observed minutes are always shown.</p>
        <div className="learn-ex"><b>Example</b><p><code>td_landed_per_15 = takedowns landed × 900 / observed seconds</code>. Three takedowns across 20 observed minutes (1,200 seconds) is 2.25 per 15.</p></div>
      </section>

      <section className="learn-sec" id="sample-size">
        <div className="eyebrow">06</div>
        <h2>Why sample size matters</h2>
        <p>A fighter with one observed round should not be interpreted the same way as a fighter with many fully captured fights. A 100% finish rate from two wins is a fact about two fights, not a tendency. That is why every Fight DNA number is displayed with the bouts, rounds and minutes behind it, and why the DATA COVERAGE bar sits at the top of every profile.</p>
        <div className="learn-receipts" aria-label="Example receipts">
          <div><b>10</b><span>Completed bouts</span></div>
          <div><b>11</b><span>Rounds with stats</span></div>
          <div><b>23 min</b><span>Observed</span></div>
          <div><b>Sep 7, 2026</b><span>As of</span></div>
          <div><b>v1</b><span>Definition</span></div>
          <div><b>Medium</b><span>Confidence</span></div>
          <div><b>Normalized records</b><span>Sources</span></div>
        </div>
        <p>Missing round coverage is never rendered as a zero. If a fighter&apos;s bouts have results but no round stats yet, the striking and grappling families are withheld until observations exist.</p>
      </section>

      <section className="learn-sec" id="confidence">
        <div className="eyebrow">07</div>
        <h2>What confidence means</h2>
        <p>{CONFIDENCE_EXPLAINER.summary}</p>
        <div className="learn-tiers">
          {CONFIDENCE_EXPLAINER.tiers.map((t) => <div key={t.key}><b className={`conf ${t.key}`}>{t.label}</b><strong>{t.short}</strong><small>{t.detail}</small></div>)}
        </div>
        <p className="mt-3"><small className="faint">{CONFIDENCE_EXPLAINER.source} Result metrics count bouts; rate metrics count observed seconds.</small></p>
        <div className="mt-3"><ConfKey /></div>
      </section>

      <section className="learn-sec" id="striking">
        <div className="eyebrow">08</div>
        <h2>Striking DNA</h2>
        <p>{FAMILY.striking.subtitle}</p>
        <h3 id="significant-strikes">Significant strikes</h3>
        <p>UFC Stats separates <strong>significant strikes</strong> (strikes at distance, plus power strikes in the clinch and on the ground) from total strikes, which include short ground-and-pound and clinch taps. Fight DNA&apos;s striking family is built on significant strikes because that is the category the source records consistently per round.</p>
        <h3 id="pace-vs-accuracy">Pace vs accuracy</h3>
        <p><strong>Sig. landed / min</strong> is pace: how many significant strikes landed for every observed minute. <strong>Sig. accuracy</strong> is efficiency: the share of attempts that landed. They move in different directions. A fighter who throws constantly can land a lot at a modest accuracy; a counter-striker can post high accuracy at low volume. Read them together.</p>
        <div className="learn-ex"><b>Example</b><p>7.63 significant strikes landed per minute across 23 observed minutes, at 68% accuracy. That is a description of output and efficiency in the observed sample, with no claim about how it compares to other fighters.</p></div>
        <h3 id="striking-defense">Striking defense</h3>
        <p><strong>Sig. absorbed / min</strong> is exposure: strikes taken per observed minute. <strong>Sig. defense</strong> is the share of opponents&apos; attempts that missed. Absorbed and landed are different numbers about different people: landed is what this fighter did, absorbed is what opponents did to them.</p>
        <h3 id="targeting">Strike targeting</h3>
        <p>Head, body and leg shares split this fighter&apos;s own significant-strike attempts by target. They sum to roughly 100% and describe where the offense went, not how much landed.</p>
        <h3 id="position">Distance, clinch and ground</h3>
        <p>Distance, clinch and ground shares split the same attempts by where they were thrown from. A fighter with a high ground share spends offensive time on top; a high distance share means the exchanges happened on the feet at range.</p>
      </section>

      <section className="learn-sec" id="takedowns">
        <div className="eyebrow">09</div>
        <h2>Grappling DNA</h2>
        <p>{FAMILY.grappling.subtitle}</p>
        <h3>Takedown metrics</h3>
        <p><strong>TD attempts / 15</strong> is how often a fighter shoots; <strong>TD landed / 15</strong> is how often it works, both scaled to 15 observed minutes. <strong>TD accuracy</strong> is landed divided by attempted. Read the three together: a fighter with one attempt and one completion shows 100% accuracy from a single shot.</p>
        <h3 id="control">Control</h3>
        <p><strong>Control / TD</strong> is the recorded control time that followed each successful takedown, in seconds. <strong>Control share</strong> is the share of all observed time spent in control. The source records control per round for each fighter; Fight DNA does not split it by position.</p>
        <h3 id="submissions">Submission activity</h3>
        <p><strong>Sub attempts / 15</strong> counts submission attempts per 15 observed minutes. It measures pressure, not success; submission wins live in Finish DNA.</p>
      </section>

      <section className="learn-sec" id="finish-rate">
        <div className="eyebrow">10</div>
        <h2>Finish DNA</h2>
        <p>{FAMILY.finish.subtitle}</p>
        <p><strong>Finish rate</strong> is the share of recorded wins that ended by KO/TKO or submission rather than decision. <strong>KO/TKO share</strong> and <strong>Submission share</strong> split those finishes by method. <strong>Median finish time</strong> is the elapsed fight time of the typical finish, counted from the opening bell across rounds, so a 2:30 finish in round two reads as 7:30.</p>
        <div className="learn-ex"><b>Example</b><p>Stored <code>finish_rate = 100%</code> displays as &ldquo;All archived wins in this sample ended before a decision.&rdquo; The sentence states the fact and its scope; it does not call the fighter dangerous.</p></div>
      </section>

      <section className="learn-sec" id="round-profiles">
        <div className="eyebrow">11</div>
        <h2>Round DNA</h2>
        <p>{FAMILY.round.subtitle} Each round shows attempts, landed and absorbed per minute for that round number, pooled across the sample, with the rounds and minutes observed.</p>
        <p><strong>Pace retention</strong> divides round-two (or round-three) attempt pace by round-one pace over bouts where both rounds are covered; 100% means the later round matched the first. <strong>Championship-round delta</strong> is rounds 4–5 pace minus rounds 1–3 pace over bouts that reached round four. <strong>Defensive drift</strong> is strikes absorbed per minute in round three minus round one.</p>
        <p>Because these use only bouts where both rounds carry stats, early finishes are excluded by construction. A fighter who ends fights in round one will have a small late-round sample, and the confidence tier will say so.</p>
      </section>

      <section className="learn-sec" id="stance-splits">
        <div className="eyebrow">12</div>
        <h2>Stance DNA</h2>
        <p>{FAMILY.stance.subtitle}</p>
        <p className="dna-callout"><b>Historical split, not causation.</b><span>A record against southpaws describes what happened in those fights. It does not prove that stance caused the result, and a split built on two appearances describes two fights.</span></p>
        <p>Each row groups completed bouts by the opponent&apos;s <strong>listed</strong> stance at the source (orthodox, southpaw, switch, open stance, sideways or unlisted). Open-stance rows pool bouts where one fighter was listed orthodox and the other southpaw; same-stance rows pool matching stances. Where round stats exist for the split, the strike differential per minute and takedowns per 15 inside that split are shown with the number of bouts that carry stats.</p>
      </section>

      <section className="learn-sec" id="context-splits">
        <div className="eyebrow">13</div>
        <h2>Context DNA</h2>
        <p>{FAMILY.context.subtitle} Records are grouped by three-round and five-round scheduling, title bouts, main events and verified short-notice bouts. A missing split means the record holds no bouts of that kind, not that the fighter has never been in that situation.</p>
      </section>

      <section className="learn-sec" id="matchup">
        <div className="eyebrow">14</div>
        <h2>Matchup DNA</h2>
        <p><strong>Two fighter histories. One matchup-specific intelligence layer.</strong> Fight DNA compares relevant historical characteristics from each fighter rather than treating career averages as isolated numbers: stance interaction (each fighter&apos;s record against the other&apos;s listed stance), pace differential, distance tendencies, takedown pressure against takedown defense, finish patterns, round progression and contextual experience, where the record supports each.</p>
        <p>A supported observation is emitted only when the underlying metric clears its sample threshold. Anything that does not clear it goes to the counter-case column as a warning, so a thin sample is stated instead of hidden. Every visible matchup conclusion traces to stored evidence.</p>
      </section>

      <section className="learn-sec" id="pbe-derived">
        <div className="eyebrow">15</div>
        <h2>PBE Derived explained</h2>
        <p><Origin explain /> {PBE_DERIVED_EXPLAINER.body}</p>
        <p>Wherever the badge appears, the definition, sample, confidence and as-of date sit behind the explainer. <strong>SOURCE</strong> marks a raw fact republished from ESPN or UFC Stats. LICENSED and MODEL labels are reserved for data that does not yet ship publicly.</p>
      </section>

      <section className="learn-sec" id="source-vs-derived">
        <div className="eyebrow">16</div>
        <h2>Source data vs derived features</h2>
        <p>The source records are building blocks. The derived feature system is the product.</p>
        <div className="learn-two">
          <div><h4><Origin kind="source" /> Source facts</h4><ul>{SOURCE_VS_DERIVED.source.map((s) => <li key={s}>{s}</li>)}</ul><p className="fine">Republished with their source URL and capture time. Where two sources disagree, the disagreement is shown.</p></div>
          <div className="derived"><h4><Origin /> PropBetEdge derived</h4><ul>{SOURCE_VS_DERIVED.derived.map((s) => <li key={s}>{s}</li>)}</ul><p className="fine">Only metrics that are implemented today are listed. Position profiles from licensed data are reserved until validated.</p></div>
        </div>
      </section>

      <section className="learn-sec" id="versioning">
        <div className="eyebrow">17</div>
        <h2>Methodology and versioning</h2>
        <p><strong>Definition v1.</strong> Fight DNA metrics are versioned so the same historical record can be rebuilt consistently as the feature system evolves. When a definition changes, its version changes, and a snapshot always states which version produced it. That is a strength: an as-of snapshot from last year and one from today can be compared on equal terms.</p>
        <p>Every derived number can expose its metric key, value, unit, numerator and denominator, sample bouts, rounds and seconds, as-of date, definition version, confidence, coverage status and source families. Internal infrastructure details stay internal; the receipts are public.</p>
      </section>

      <section className="learn-sec" id="limits">
        <div className="eyebrow">18</div>
        <h2>What the numbers cannot tell you</h2>
        <ul>
          <li>They cannot say who wins. A profile is a description of the observed record, not a probability.</li>
          <li>They cannot see camp, injuries, weight cuts, referee assignment, judging or motivation. Fight Week and the newsroom carry those only when a verified source exists.</li>
          <li>They cannot separate a fighter from their opponents. A high absorbed rate can mean a porous defense or a run of high-output opponents; the counter-case column exists for exactly that reason.</li>
          <li>They cannot fix a small sample. Two fights are two fights, and the confidence tier will keep saying so.</li>
          <li>They cannot substitute for watching the fights. Fight DNA tells you where to look; the tape tells you why.</li>
        </ul>
      </section>

      <section className="learn-sec" id="glossary">
        <div className="eyebrow">19</div>
        <h2>Glossary</h2>
        <p>Every technical label used in Fight DNA, with the definition it maps to. Popovers on fighter and matchup pages link here.</p>
        {ORDER.map((fam) => {
          const list = terms.filter((t) => t.family === fam);
          if (!list.length) return null;
          return (
            <div key={fam}>
              <h3 id={`glossary-${fam}`}>{FAMILY[fam].title}</h3>
              <dl className="learn-glossary">
                {list.map((t) => (
                  <div className="learn-term" id={`metric-${t.key}`} key={t.key}>
                    <dt>{t.fullName}<small>{t.shortLabel} · {t.kind === "rate" ? "rate metric" : t.kind === "result" ? "result metric" : t.kind}</small></dt>
                    <dd>{t.plainEnglish}{t.unitExplanation && <em>{t.unitExplanation}</em>}{t.caution && <em>Caution: {t.caution}</em>}{t.formula && <code>{t.formula}</code>}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </section>

      <div className="learn-cta">
        <div><div className="eyebrow">Put it to work</div><h2>Read a real profile with the explainers on.</h2></div>
        <div className="btns"><Link href="/fighters" className="btn gold">Explore a fighter →</Link><Link href="/fight-week" className="btn">See Fight Week →</Link><Link href="/pro" className="btn">Go Pro →</Link></div>
      </div>
      <ApiCta
        eyebrow="Build with Fight DNA"
        heading="Access the same UFC intelligence layer through the PropTechUSA UFC Intelligence API."
      />
      <p className="learn-disclaimer">PropBetEdge is an independent sports intelligence product and is not affiliated with the UFC, Zuffa LLC, TKO Group, ESPN or any sportsbook. Fight DNA is not an official UFC statistic. Nothing on this page is betting advice or a prediction of fight outcomes.</p>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "TechArticle", "@id": `${SITE.url}/learn/fight-dna#article`, headline: "How to Read Fight DNA", name: TITLE, description: DESCRIPTION, url: `${SITE.url}/learn/fight-dna`, author: { "@type": "Organization", name: "PropBetEdge", url: SITE.parent }, publisher: { "@type": "Organization", name: SITE.publisher, url: SITE.parent }, about: { "@type": "Thing", name: "PropBetEdge Fight DNA", description: "Proprietary UFC fighter intelligence derived from normalized fight records." }, isPartOf: { "@id": `${SITE.url}/#site` } }} />
      <JsonLd data={{ "@context": "https://schema.org", "@type": "DefinedTermSet", "@id": `${SITE.url}/learn/fight-dna#glossary`, name: "PropBetEdge Fight DNA glossary", hasDefinedTerm: terms.map((t) => ({ "@type": "DefinedTerm", "@id": `${SITE.url}/learn/fight-dna#metric-${t.key}`, name: t.fullName, termCode: t.key, description: t.plainEnglish })) }} />
      <JsonLd data={{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: SITE.url }, { "@type": "ListItem", position: 2, name: "Fight DNA", item: `${SITE.url}/fighters` }, { "@type": "ListItem", position: 3, name: "How to read Fight DNA", item: `${SITE.url}/learn/fight-dna` }] }} />
    </div>
  );
}
