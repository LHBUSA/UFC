import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Brand";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import { JsonLd } from "@/components/ui";
import { HOF_FIGHTS, HOF_WINGS, LEGACY_LENSES, UFC_OFFICIAL } from "@/lib/heritage";
import { SITE } from "@/lib/site";

export const revalidate = 86400;
export const metadata: Metadata = {
  title: "UFC Hall of Fame — Fighters, Pioneers, Contributors & Legendary Fights",
  description: "PropBetEdge's independent tribute to the UFC Hall of Fame: Modern, Pioneer and Contributor wings, legendary Fight Wing matchups and a thoughtful framework for MMA legacy.",
  alternates: { canonical: "/hall-of-fame" },
  openGraph: { type: "website", title: "Honor the Fight Game — UFC Hall of Fame", description: "The pioneers, champions, contributors and fights that shaped UFC history.", url: `${SITE.url}/hall-of-fame`, images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }] },
};

export default function HallOfFamePage() {
  return (
    <div className="wrap page hof-page">
      <section className="hof-hero">
        <div>
          <div className="row"><Mark size={34} /><span className="eyebrow">Honor the fight game</span></div>
          <h1>Hall of Fame</h1>
          <p className="lede">The fighters who changed what was possible. The builders who changed what the sport could become. The fights that made whole eras unforgettable.</p>
          <div className="hof-actions">
            <a href={UFC_OFFICIAL.hallOfFame} className="btn gold" target="_blank" rel="noopener">Visit the official UFC Hall of Fame →</a>
            <Link href="/history" className="btn">History of the fight game</Link>
          </div>
          <p className="hof-disclaimer">Independent PropBetEdge tribute. Hall of Fame membership and wing assignments are credited to UFC's official Hall of Fame; PropBetEdge is not affiliated with or endorsed by UFC.</p>
        </div>
        <div className="hof-belt-stage"><ChampionshipBelt size="hero" label="Hall of Fame" /><span>LEGACY</span></div>
      </section>

      <section className="hof-wings">
        {HOF_WINGS.map((wing, index) => (
          <article className="hof-wing" key={wing.key}>
            <div className="hof-wing-number">0{index + 1}</div>
            <div className="eyebrow">Official UFC designation</div>
            <h2>{wing.label}</h2>
            <p>{wing.subtitle}</p>
            <div className="hof-names">
              {wing.names.map((name) => <span key={name}>{name}</span>)}
            </div>
          </article>
        ))}
      </section>

      <section className="hof-fights">
        <div className="hof-fights-head">
          <div><div className="eyebrow">Fight Wing</div><h2>Some nights become part of the language of MMA.</h2><p>These are among the matchups honored by UFC for significance, action and enduring place in the sport's history.</p></div>
          <a href={UFC_OFFICIAL.hallOfFame} target="_blank" rel="noopener">Official Hall of Fame →</a>
        </div>
        <div className="hof-fight-grid">
          {HOF_FIGHTS.map((fight, i) => <div className="hof-fight" key={fight}><span>{String(i + 1).padStart(2, "0")}</span><b>{fight}</b></div>)}
        </div>
      </section>

      <section className="legacy-section">
        <div className="legacy-intro"><div className="eyebrow">The greatest-of-all-time question</div><h2>There is no honest GOAT formula that erases eras.</h2><p>PropBetEdge should make the argument richer, not flatter. Instead of publishing a fake universal score, we separate the dimensions that make a historical case compelling.</p></div>
        <div className="legacy-grid">
          {LEGACY_LENSES.map((lens) => <article key={lens.label}><strong>{lens.label}</strong><p>{lens.body}</p></article>)}
        </div>
      </section>

      <section className="official-love">
        <div><div className="eyebrow">Go to the source</div><h2>Explore UFC's own history, athletes and archive.</h2></div>
        <div className="official-love-links">
          <a href={UFC_OFFICIAL.hallOfFame} target="_blank" rel="noopener"><b>UFC Hall of Fame</b><span>Official inductees and stories</span></a>
          <a href={UFC_OFFICIAL.athletes} target="_blank" rel="noopener"><b>UFC Athletes</b><span>Official fighter directory</span></a>
          <a href={UFC_OFFICIAL.fightPass} target="_blank" rel="noopener"><b>UFC Fight Pass</b><span>Watch the archive</span></a>
          <a href={UFC_OFFICIAL.store} target="_blank" rel="noopener"><b>UFC Store</b><span>Official UFC merchandise</span></a>
        </div>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "CollectionPage", "@id": `${SITE.url}/hall-of-fame#collection`, url: `${SITE.url}/hall-of-fame`, name: "UFC Hall of Fame — PropBetEdge tribute", isPartOf: { "@id": `${SITE.url}/#site` },
        mainEntity: { "@type": "ItemList", name: "UFC Hall of Fame honorees", itemListElement: HOF_WINGS.flatMap((wing) => wing.names).map((name, index) => ({ "@type": "ListItem", position: index + 1, name })) },
      }} />
    </div>
  );
}
