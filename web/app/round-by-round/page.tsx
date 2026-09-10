import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { getRoundIndex, RoundIndexUnavailable, type RoundIndex, type RoundIndexBout } from "@/lib/roundIndex";
import { fmtDate, METHOD_SHORT, weightClassLabel } from "@/lib/format";
import { matchupSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";

/* /round-by-round — discovery for the round-level archive.
 *
 * Every fight listed here has stored round observations, so every card on the
 * page opens onto something real. Nothing is listed speculatively and no
 * category is shown empty, because the value of this surface is that it only
 * promises what the archive can actually deliver.
 *
 * The whole page is one database call (lib/roundIndex.ts). If that call fails
 * or returns less than its full contract, the page does not render a smaller
 * archive: at runtime the error propagates, so the last complete render keeps
 * being served (its own "archive state" line says when it was built); with no
 * complete render to fall back on, the visitor gets an explicit failure. */
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

function boutHref(b: RoundIndexBout) {
  return `/fights/${matchupSlug(b.fighterA, b.fighterB, { name: b.eventName, event_date: b.eventDate })}`;
}

function Card({ b }: { b: RoundIndexBout }) {
  const wc = weightClassLabel(b.weightClass, b.isWomens);
  const winner = b.winnerId === b.fighterA.id ? "a" : b.winnerId === b.fighterB.id ? "b" : null;
  return (
    <Link href={boutHref(b)} className="rbi-card">
      <span className="rbi-card-top">
        <span className="rbi-event">{b.eventName}</span>
        <span className="rbi-date">{b.eventDate ? fmtDate(b.eventDate) : "Date unrecorded"}</span>
      </span>
      <span className="rbi-names">
        <span className={`rbi-n${winner === "a" ? " w" : ""}`}>{b.fighterA.name}</span>
        <em>vs</em>
        <span className={`rbi-n${winner === "b" ? " w" : ""}`}>{b.fighterB.name}</span>
      </span>
      <span className="rbi-meta">
        {wc ? <span className="rbi-tag">{wc}</span> : null}
        {b.isTitle ? <span className="rbi-tag gold">Title</span> : null}
        {b.method ? <span className="rbi-tag">{METHOD_SHORT[b.method] || b.method}{b.finishRound ? ` R${b.finishRound}` : ""}</span> : null}
      </span>
      <span className="rbi-cover">
        {/* Coverage is stated, never implied. A three-round fight with two
            rounds stored says so rather than looking complete. */}
        <b>{b.roundsCovered}</b> round{b.roundsCovered === 1 ? "" : "s"} of data
        {b.bothCorners ? <i className="ok"> · both corners</i> : <i className="part"> · one corner only</i>}
      </span>
      <span className="rbi-cta">View round-by-round →</span>
    </Link>
  );
}

/* Build-time rendering must not fail the whole site's deploy over one page, so
 * during `next build` an unavailable index renders the explicit state below and
 * the first runtime revalidation replaces it. At runtime the error is thrown
 * instead (see the file comment). */
async function loadIndex(): Promise<RoundIndex | RoundIndexUnavailable> {
  try {
    return await getRoundIndex();
  } catch (e) {
    const err = e instanceof RoundIndexUnavailable ? e : new RoundIndexUnavailable(String((e as Error)?.message || e));
    console.error(`[round-by-round] ${err.message}`);
    if (process.env.NEXT_PHASE === "phase-production-build") return err;
    throw err;
  }
}

export default async function RoundByRoundIndex() {
  const loaded = await loadIndex();
  if (loaded instanceof RoundIndexUnavailable) {
    return (
      <div className="wrap page rbi">
        <PageHead crumbs={[{ name: "Round-by-Round" }]} eyebrow="Round-level fight intelligence" title="Round-by-Round Analysis" />
        <section className="segment">
          <div className="card rbi-empty" role="status">
            <div className="rbi-empty-k">Round index unavailable</div>
            <p>The round-level archive could not be read completely just now, so nothing is listed rather than a partial archive. Individual fight pages are unaffected.</p>
          </div>
        </section>
      </div>
    );
  }
  const index = loaded;
  const sections = index.sections;
  const t = index.totals;
  const rounds = [1, 2, 3, 4, 5].map((n) => ({ n, count: t.byRoundsObserved[n] || 0 }));

  return (
    <div className="wrap page rbi">
      <PageHead
        crumbs={[{ name: "Round-by-Round" }]}
        eyebrow="Round-level fight intelligence"
        title="Round-by-Round Analysis"
        lede="Fight progression reconstructed from verified round-level observations. Striking, grappling, control and target distribution for each completed round, compared against the previous round and against each fighter's historical Fight DNA."
      />

      {t.eligible === 0 ? (
        <section className="segment">
          <div className="card rbi-empty">
            <div className="rbi-empty-k">No round data loaded yet</div>
            <p>Round-level observations have not been loaded into the canonical database. Nothing is estimated in the meantime.</p>
          </div>
        </section>
      ) : (
        <>
          <section className="segment rbi-stats" aria-label="Coverage">
            <div className="rbi-stat"><b>{t.eligible.toLocaleString()}</b><span>fights with round data</span></div>
            <div className="rbi-stat"><b>{t.bothCorners.toLocaleString()}</b><span>with both corners in every round</span></div>
            {/* Rounds OBSERVED (how far the fight went, as recorded), not the
                scheduled distance. The five-round shelf below uses the
                scheduled distance, so the two are labelled apart. */}
            {rounds.filter((r) => r.count > 0).map((r) => (
              <div className="rbi-stat" key={r.n}><b>{r.count.toLocaleString()}</b><span>{`${r.n} round${r.n === 1 ? "" : "s"} observed`}</span></div>
            ))}
          </section>

          {sections.map((s) => (
            <section className="segment" key={s.key} id={s.key}>
              <div className="rbi-head">
                <h2>{s.title}</h2>
                <p>{s.blurb}</p>
              </div>
              <div className="rbi-grid">{s.bouts.map((b) => <Card b={b} key={`${s.key}-${b.boutId}`} />)}</div>
            </section>
          ))}
        </>
      )}

      <section className="segment">
        <div className="card rbi-note">
          <h2 className="rbi-note-h">What this is, and is not</h2>
          <p>Every number comes from stored round-level observations of a completed fight. A missing observation is shown as unavailable rather than as zero, and a round the source never recorded is left out rather than inferred.</p>
          <p>Round signals describe what the numbers show: more output, more control, a shift in targeting. They are not judge scores and they do not say who won a round. PropBetEdge has no scoring source and does not invent one.</p>
          <p>PropBetEdge is an independent sports intelligence product and is not affiliated with the UFC, Zuffa LLC, TKO Group or ESPN.</p>
          <p className="rbi-prov" data-round-rows={index.provenance.roundRows} data-generated-at={index.provenance.generatedAt}>
            Archive state: {index.provenance.roundRows.toLocaleString()} round observations
            {index.provenance.lastCapturedAt ? `, newest captured ${fmtDate(index.provenance.lastCapturedAt.slice(0, 10))}` : ""}.
            {" "}Index built {fmtDate(index.provenance.generatedAt.slice(0, 10))}.
          </p>
        </div>
      </section>

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
            numberOfItems: Math.min(24, index.bouts.length),
            itemListElement: index.bouts.slice(0, 24).map((b, i) => ({
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
