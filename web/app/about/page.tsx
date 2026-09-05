import type { Metadata } from "next";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "About & Editorial Policy", description: "How PropBetEdge UFC sources data, writes stories, labels model output and handles corrections.", alternates: { canonical: "/about" } };

export default function AboutPage() {
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow">About</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 24px" }}>Editorial policy</h1>
      <div className="prose">
        <h2>Who we are</h2>
        <p>PropBetEdge UFC is published by {SITE.publisher}, the independent sports intelligence company behind PropBetEdge MLB and PropBetEdge NFL. We are not affiliated with the UFC, Zuffa LLC, ESPN, or any sportsbook.</p>
        <h2>Where the data comes from</h2>
        <p>Schedules, results and fighter identity come from ESPN's public MMA data. Round-by-round striking and grappling statistics come from UFC Stats. Every stored row carries its source URL and capture time. Where the two sources disagree, we show the disagreement rather than pick a side silently.</p>
        <h2>How stories are written</h2>
        <p>Stories are generated from our own tables and a fact block that is stored alongside each article. A story may not state a fact that is not in its fact block or its cited source. External reporting is summarised in a phrase at most, attributed, and linked. Stories that name a fighter in connection with an injury or withdrawal are held for human review before publication.</p>
        <h2>Labels</h2>
        <p><strong>LIVE</strong> is genuine current provider data. <strong>MODEL</strong> is PropBetEdge model output. <strong>UNAVAILABLE</strong> means a required input is missing. We never relabel one as another, and we never display a pick, edge or probability the model did not produce.</p>
        <h2>Images</h2>
        <p>We do not use UFC, Zuffa, Getty, ESPN or Sherdog imagery. Hero images are either stat cards we render ourselves or Creative Commons portraits from Wikimedia Commons with the author, licence and source shown. We never generate a real fighter's likeness with AI.</p>
        <h2>Corrections</h2>
        <p>Corrections are appended, dated and never silently overwrite the original. Report an error to <a href="mailto:sales@localhomebuyersusa.com">the desk</a>.</p>
        <h2>Responsible play</h2>
        <p>Nothing on this site is betting advice. Please gamble responsibly and only where it is legal for you to do so.</p>
      </div>
    </div>
  );
}
