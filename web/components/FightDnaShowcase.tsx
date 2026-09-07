import Link from "next/link";
import { DnaPipeline } from "@/components/DnaPipeline";
import { Origin } from "@/components/dna";

/* Homepage Fight DNA product module. Sells the system, not a table: what
 * Fight DNA is, the six families it actually ships today, the pipeline that
 * makes it proprietary, and two CTAs. Claim boundary: derived by
 * PropBetEdge from normalized records; never "no one else has this". */

const FAMILIES: Array<[string, string]> = [
  ["Stance DNA", "Historical performance across opponent stance matchups."],
  ["Striking DNA", "Pace, accuracy, defense, targeting and exchange location."],
  ["Grappling DNA", "Takedown pressure, success, control yield and submission activity."],
  ["Round DNA", "How pace and defensive performance change as fights progress."],
  ["Finish DNA", "How recorded wins end and when finishes occur."],
  ["Matchup DNA", "How two fighter profiles interact when their historical patterns collide."],
];

export function FightDnaShowcase({ exploreHref = "/fighters", exploreLabel = "Explore Fight DNA →" }: { exploreHref?: string; exploreLabel?: string }) {
  return (
    <section className="dna-showcase" aria-labelledby="dna-showcase-title">
      <div className="dna-showcase-head">
        <div>
          <div className="eyebrow">Proprietary intelligence · PropBetEdge Fight DNA</div>
          <h2 id="dna-showcase-title">Fight <span>DNA</span></h2>
          <div className="dna-contrast"><span>Raw data tells you what happened.</span><span>Fight DNA shows you the patterns inside the record.</span></div>
        </div>
        <div>
          <p>Fight DNA transforms normalized event, bout and round-level fight records into proprietary metrics covering pace, opponent stance, striking geography, grappling efficiency, finishing patterns, round progression and matchup context. Every metric carries its supporting sample, provenance, confidence and definition version.</p>
          <div className="dna-derived-line"><Origin explain /> <span>Not simply republished source statistics. Derived by PropBetEdge from the normalized fight record. Not an official UFC statistic.</span></div>
        </div>
      </div>
      <div className="dna-showcase-grid">
        {FAMILIES.map(([t, d]) => <div className="dna-fam-card" key={t}><div className="m"><i aria-hidden="true" />{t}</div><p>{d}</p></div>)}
      </div>
      <div className="dna-showcase-pipe"><DnaPipeline compact /></div>
      <div className="dna-showcase-foot">
        <div className="btns"><Link href={exploreHref} className="btn gold">{exploreLabel}</Link><Link href="/learn/fight-dna" className="btn">See how it works →</Link></div>
        <small>Evidence with receipts, not predictions. Fight DNA describes what the record shows about a fighter; it does not claim certainty about the next fight.</small>
      </div>
    </section>
  );
}
