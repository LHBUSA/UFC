import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "About & Editorial Policy", description: "How PropBetEdge UFC sources its data, licenses its images, writes its stories, labels model output and handles corrections.", alternates: { canonical: "/about" } };

export default function AboutPage() {
  return (
    <div className="wrap page narrow">
      <PageHead crumbs={[{ name: "About" }]} eyebrow="About" title="Editorial policy" lede="Who publishes this site, where every number comes from, and the rules the newsroom writes under." />
      <div className="prose">
        <h2 id="who">Who we are</h2>
        <p>PropBetEdge UFC is published by {SITE.publisher}, the independent sports intelligence company behind PropBetEdge MLB and PropBetEdge NFL. We are not affiliated with the UFC, Zuffa LLC, TKO Group, ESPN, or any sportsbook.</p>
        <h2 id="data">Where the data comes from</h2>
        <p>Schedules, results and fighter identity come from ESPN's public MMA data. Round-by-round striking and grappling statistics come from UFC Stats. Official rankings are captured from UFC.com as dated snapshots. Every stored row carries its source URL and capture time. Where two sources disagree, we show the disagreement rather than pick a side silently.</p>
        <h2 id="stories">How stories are written</h2>
        <p>Stories are generated from our own tables and a fact block that is stored alongside each article. A story may not state a fact that is not in its fact block or its cited source. External reporting is summarised in a phrase at most, attributed, and linked. Stories that name a fighter in connection with an injury or withdrawal are held for human review before publication. We do not pad volume: empty days are fine.</p>
        <h2 id="fight-dna">Fight DNA</h2>
        <p><strong>PropBetEdge Fight DNA</strong> is our proprietary fighter intelligence layer: metrics calculated by PropBetEdge from normalized event, bout and round-level records using versioned definitions, each shown with its sample, confidence, as-of date and definition version. It is not an official UFC statistic and it is not a prediction. <Link href="/learn/fight-dna">How to read Fight DNA</Link>.</p>
        <h2 id="labels">Labels</h2>
        <p><strong>LIVE</strong> is genuine current provider data. <strong>MODEL</strong> is PropBetEdge model output. <strong>UNAVAILABLE</strong> means a required input is missing. We never relabel one as another, and we never display a pick, edge or probability the model did not produce. Until the UFC model has a graded, out-of-time track record, every model slot on this site renders locked.</p>
        <h2 id="images">Images</h2>
        <p>We do not use UFC, Zuffa, Getty, ESPN or Sherdog imagery. Fighter portraits are Creative Commons or public-domain photographs from Wikimedia Commons, matched to the fighter through Wikidata, stored with the author, licence and source, and credited wherever they appear. Where no licensed portrait exists we show a branded placeholder rather than an unlicensed photo. We never generate a real fighter's likeness with AI.</p>
        <h2 id="corrections">Corrections</h2>
        <p>Corrections are appended, dated and never silently overwrite the original. Report an error to <a href={`mailto:${SITE.contact}`}>the desk</a>.</p>
        <h2 id="play">Responsible play</h2>
        <p>Nothing on this site is betting advice. Please gamble responsibly and only where it is legal for you to do so.</p>
      </div>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "AboutPage", name: "About PropBetEdge UFC", url: `${SITE.url}/about`, isPartOf: { "@id": `${SITE.url}/#site` }, about: { "@id": `${SITE.parent}/#org` } }} />
    </div>
  );
}
