import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Brand";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import { JsonLd } from "@/components/ui";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { getLatestVideos } from "@/lib/db";
import { HOF_FEATURED, HOF_FIGHTS, HOF_WINGS, LEGACY_LENSES, UFC_OFFICIAL } from "@/lib/heritage";
import { SITE } from "@/lib/site";

export const revalidate = 3600;
export const metadata: Metadata = {
  title: "UFC Hall of Fame — Wings, Legends, Iconic Fights & Legacy",
  description: "PropBetEdge's independent tribute to the UFC Hall of Fame: the Pioneer, Modern and Contributor wings, signature inductees, the Fight Wing's iconic matchups and an honest framework for thinking about greatness.",
  alternates: { canonical: "/hall-of-fame" },
  openGraph: { type: "website", title: "Honor the Fight Game — UFC Hall of Fame", description: "The pioneers, champions, contributors and fights that shaped UFC history.", url: `${SITE.url}/hall-of-fame`, images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: "Honor the Fight Game — UFC Hall of Fame", images: [`${SITE.url}/opengraph-image`] },
};

export default async function HallOfFamePage() {
  const videos = await getLatestVideos(3).catch(() => []);
  return (
    <div className="wrap page hof-page">
      <section className="hof-hero">
        <div>
          <div className="row"><Mark size={34} /><span className="eyebrow">Honor the fight game</span></div>
          <h1>Hall of Fame</h1>
          <p className="lede">The fighters who changed what was possible. The builders who changed what the sport could become. The fights that made whole eras unforgettable. This is an independent tribute; the honors themselves belong to the UFC Hall of Fame.</p>
          <div className="hof-actions">
            <a href={UFC_OFFICIAL.hallOfFame} className="btn gold" target="_blank" rel="noopener">Visit the official UFC Hall of Fame ↗</a>
            <Link href="/history" className="btn">History of the fight game</Link>
          </div>
          <p className="hof-disclaimer">Independent PropBetEdge tribute. Hall of Fame membership, wing assignments and induction classes are credited to UFC's official Hall of Fame; PropBetEdge is not affiliated with or endorsed by UFC.</p>
        </div>
        <div className="hof-belt-stage"><ChampionshipBelt size="hero" label="Hall of Fame" /><span>LEGACY</span></div>
      </section>

      <section aria-labelledby="hof-featured-title">
        <div className="sec-head" style={{ marginTop: 44 }}><div><div className="eyebrow">Signature inductees</div><h2 id="hof-featured-title">Names that define the wings</h2></div><a href={UFC_OFFICIAL.hallOfFame} className="more" target="_blank" rel="noopener">All inductees at UFC.com ↗</a></div>
        <div className="hof-featured" style={{ marginTop: 0 }}>
          {HOF_FEATURED.map((h) => (
            <article className="hof-legend" key={h.name}>
              <div className="hof-legend-wing">{h.wing}</div>
              <h3>{h.name}</h3>
              <div className="hof-legend-year">Inducted {h.inducted}</div>
              <p>{h.blurb}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="hof-wings">
        {HOF_WINGS.map((wing, index) => (
          <article className="hof-wing" key={wing.key}>
            <div className="hof-wing-number">0{index + 1}</div>
            <div className="eyebrow">Official UFC designation</div>
            <h2>{wing.label}</h2>
            <p>{wing.subtitle}</p>
            <p className="hof-wing-desc">{wing.description}</p>
            <div className="hof-names">
              {wing.names.map((name) => <span key={name}>{name}</span>)}
            </div>
          </article>
        ))}
      </section>

      <section className="hof-fights">
        <div className="hof-fights-head">
          <div><div className="eyebrow">Fight Wing</div><h2>Some nights become part of the language of MMA.</h2><p>Matchups honored by UFC for significance, action and their enduring place in the sport's history — with the event and year so you can find them in the archive.</p></div>
          <a href={UFC_OFFICIAL.hallOfFame} target="_blank" rel="noopener">Official Hall of Fame ↗</a>
        </div>
        <div className="hof-fight-grid">
          {HOF_FIGHTS.map((f, i) => (
            <div className="hof-fight" key={f.fight}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <div><b>{f.fight}</b><span className="hof-fight-meta">{f.event} · {f.year}</span><span className="hof-fight-note">{f.note}</span></div>
            </div>
          ))}
        </div>
      </section>

      <section className="legacy-section">
        <div className="legacy-intro"><div className="eyebrow">How to think about greatness</div><h2>There is no honest GOAT formula that erases eras.</h2><p>PropBetEdge should make the argument richer, not flatter. Instead of publishing a fake universal score, we separate the dimensions that make a historical case compelling — and let the archive, not a ranking, carry the evidence.</p></div>
        <div className="legacy-grid">
          {LEGACY_LENSES.map((lens) => <article key={lens.label}><strong>{lens.label}</strong><p>{lens.body}</p></article>)}
        </div>
      </section>

      <VideoRail videos={videos} title="From UFC's official channel" eyebrow="Official video" feature={false} note="Free, publisher-hosted video embedded from UFC's official YouTube channel · not hosted by PropBetEdge" />

      <OfficialDestinations title="Explore UFC's own history, athletes and archive" />

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "CollectionPage", "@id": `${SITE.url}/hall-of-fame#collection`, url: `${SITE.url}/hall-of-fame`, name: "UFC Hall of Fame — PropBetEdge tribute", isPartOf: { "@id": `${SITE.url}/#site` },
        about: { "@type": "SportsOrganization", name: "Ultimate Fighting Championship", url: UFC_OFFICIAL.hallOfFame },
        mainEntity: { "@type": "ItemList", name: "UFC Hall of Fame honorees", itemListElement: HOF_WINGS.flatMap((wing) => wing.names.map((name) => ({ wing: wing.label, name }))).map((x, index) => ({ "@type": "ListItem", position: index + 1, name: x.name, description: x.wing })) },
        video: videos.length ? videoJsonLd(videos) : undefined,
      }} />
    </div>
  );
}
