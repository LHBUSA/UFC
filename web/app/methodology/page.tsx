/* Editorial & Data Methodology.
 *
 * The article footer is deliberately short, so this is where the full account
 * lives. Two rules govern what goes on this page.
 *
 * It must be TRUE AT THE LEVEL OF DETAIL IT CLAIMS. Anywhere the honest answer
 * is a limitation, the limitation is stated -- that we read the original report
 * rather than independently confirming the event, that odds are a snapshot,
 * that Fight DNA carries a coverage level, that a held story simply does not
 * publish. A methodology page listing only strengths is marketing.
 *
 * It must contain NOTHING OPERATIONALLY SENSITIVE. No prompts, no credentials,
 * no admin endpoints, no worker or table names, no thresholds precise enough to
 * be gamed by someone writing copy aimed at our filters. Describing that
 * numbers are checked is useful to a reader; publishing the checker is not.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";

export const revalidate = 86400;

const DESCRIPTION =
  "How PropBetEdge UFC reports, sources and checks its analysis: first-party fight data, source attribution, AI-assisted editorial, and automated verification of every number before publication.";

export const metadata: Metadata = {
  title: "Editorial & Data Methodology",
  description: DESCRIPTION,
  alternates: { canonical: "/methodology" },
  openGraph: { title: "Editorial & Data Methodology — PropBetEdge UFC", description: DESCRIPTION, type: "article" },
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="meth-section" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function MethodologyPage() {
  const updated = "2026-09-10";
  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Editorial & Data Methodology" }]} />
      <div className="page-head">
        <div className="eyebrow">Editorial</div>
        <h1>Editorial &amp; Data Methodology</h1>
        <p className="lede">
          How PropBetEdge UFC decides what to cover, where its numbers come from, and what has to be true before a story
          publishes.
        </p>
      </div>

      <div className="prose meth">
        <Section id="what-we-are" title="What this publication is">
          <p>
            PropBetEdge UFC is an independent fight-intelligence desk. We are not affiliated with the UFC, Zuffa LLC, TKO
            Group or any sportsbook. We do not sell picks, and nothing here is betting advice.
          </p>
          <p>
            Our work is analysis built on our own database of fighters, bouts, round-by-round statistics, rankings and
            recorded market prices. When another outlet breaks a story, we credit them and link to them — then we do the
            part we are actually equipped to do, which is explain what the development means against the underlying data.
          </p>
        </Section>

        <Section id="sourcing" title="Sourcing and attribution">
          <p>
            Most stories begin with reporting by someone else. When they do, the outlet that broke it is named and linked
            at the top of our Sources &amp; Method block, and again in the article wherever we lean on their reporting.
          </p>
          <p>
            <strong>We are careful about one claim in particular.</strong> Unless we say explicitly that we confirmed
            something ourselves, we did not. What we do is read the original report and analyse the data surrounding it.
            That is a real contribution and a different thing from independently verifying that an event occurred, and we
            do not blur the two.
          </p>
          <p>
            We quote sparingly — a phrase where it matters, never a substantial reproduction of another outlet&rsquo;s
            work.
          </p>
        </Section>

        <Section id="data" title="Where the numbers come from">
          <p>Analysis draws on data families we maintain ourselves:</p>
          <ul>
            <li><strong>Fighter profiles</strong> — record, physical measurements, stance, and career striking and grappling rates.</li>
            <li><strong>Bout history</strong> — results, methods and rounds across our archive.</li>
            <li><strong>Round statistics</strong> — round-by-round strikes, knockdowns, takedowns, control time and target distribution, for the bouts we hold complete records on.</li>
            <li><strong>Rankings</strong> — divisional and pound-for-pound standing, with movement.</li>
            <li><strong>Fight DNA</strong> — derived per-fighter metrics, described below.</li>
            <li><strong>Market data</strong> — sportsbook prices we recorded, with the time we recorded them.</li>
            <li><strong>Official video</strong> — clips published by the UFC&rsquo;s own channels.</li>
          </ul>
          <p>
            Where our archive is incomplete, we say so in the article rather than presenting a partial sample as a career
            figure. A statistic drawn from six bouts is labelled as drawn from six bouts.
          </p>
        </Section>

        <Section id="ai" title="AI-assisted editorial">
          <p>
            PropBetEdge uses AI-assisted editorial analysis. A language model writes the prose, and it writes it from a
            fixed set of verified facts assembled before writing begins — it is not asked to recall anything about the
            sport, and it has no ability to look things up.
          </p>
          <p>
            <strong>The model does not produce any chart.</strong> Every chart on this site is built directly from
            verified figures by our own code. This matters more than it may sound: a fabricated number inside a chart is
            a fabricated number with a picture around it and no sentence for a checker to inspect, so we removed the
            possibility rather than trying to police it.
          </p>
          <p>Editorial judgement, corrections and publication remain ours.</p>
        </Section>

        <Section id="checking" title="How every number is checked">
          <p>Before an article can publish, each number in it must fall into one of two categories:</p>
          <ul>
            <li>it appears in our own first-party data; or</li>
            <li>it comes from the source report, in which case the sentence containing it must attribute it.</li>
          </ul>
          <p>
            A number in neither category fails the check and the article does not publish. The same pass enforces our
            other publication rules — that the story resolves to a fighter we actually hold records for, that we
            retrieved the original report, that the piece is not a duplicate of coverage we already ran, and that any
            photograph carries a complete credit.
          </p>
          <p>
            When a story fails, it is held rather than published. Holding is the normal outcome for a large share of what
            we look at, and we would rather run fewer stories than loosen this.
          </p>
        </Section>

        <Section id="dna" title="Fight DNA">
          <p>
            Fight DNA is a set of per-fighter metrics we compute from our round-by-round archive — accuracy, defensive
            rates, output, control share, knockdown rate and finishing profile among them.
          </p>
          <p>
            Each metric carries its own confidence and the number of bouts and rounds behind it, and a metric below our
            confidence threshold is left out rather than shown weakly. Every snapshot also carries a coverage level
            reflecting how much of that fighter&rsquo;s career we actually hold. Low coverage is published as low
            coverage.
          </p>
        </Section>

        <Section id="odds" title="Market data and odds">
          <p>
            Odds shown in an article are a <strong>snapshot</strong> recorded at a stated time, not a live feed. Prices
            move, sometimes sharply, and a price in a published article should be read as what the market said when the
            analysis was written.
          </p>
          <p>
            Where we show implied probability, it is converted arithmetically from the recorded price and still includes
            the bookmaker&rsquo;s margin — which is why the figures across both fighters add up to more than 100%. We
            show the underlying price alongside it. If we have no verified price for a bout, we show no odds at all
            rather than an estimate.
          </p>
        </Section>

        <Section id="charts" title="Chart provenance">
          <p>
            Every chart names the data it was drawn from, and where a sample is small the chart says how small. Charts
            plot one measure per axis: where two measures live on different scales we draw two charts rather than one
            misleading pair, and bars always start at zero.
          </p>
        </Section>

        <Section id="video" title="Official video">
          <p>
            Video is played from the UFC&rsquo;s own channels. We do not host, re-upload or re-encode it, and we attach a
            clip only when it genuinely involves the subject of the story — an exact story or bout match, or an official
            video featuring that fighter.
          </p>
          <p>
            We deliberately do not fill space with other clips from the same card. Most articles carry no video, because
            for most stories no genuinely relevant official video exists, and that is the correct outcome.
          </p>
        </Section>

        <Section id="corrections" title="Updates and corrections">
          <p>
            Articles are updated when the underlying facts change — a bout is rebooked, a result is overturned, a price
            moves materially. Where an update is substantive, the article shows an updated timestamp alongside its
            original publication time.
          </p>
          <p>
            If you believe something here is wrong, tell us and we will check it against our records and the source. If
            it is wrong, we fix it and say that we did.{" "}
            <a href={`mailto:${SITE.contact}`}>Contact the desk</a>.
          </p>
        </Section>

        <p className="faint label mt-6">
          Last updated {new Date(updated).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.
          {" "}Please gamble responsibly. 21+ where applicable.
        </p>
      </div>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          "@id": `${SITE.url}/methodology#page`,
          url: `${SITE.url}/methodology`,
          name: "Editorial & Data Methodology",
          description: DESCRIPTION,
          dateModified: updated,
          isPartOf: { "@id": `${SITE.url}/#site` },
          publisher: { "@type": "NewsMediaOrganization", "@id": `${SITE.url}/#desk`, name: SITE.desk, url: SITE.url },
        }}
      />
    </div>
  );
}
