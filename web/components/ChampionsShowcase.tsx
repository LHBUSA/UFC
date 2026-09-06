import Link from "next/link";
import { Avatar } from "@/components/ui";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import type { Fighter, PortraitSet, RankingsSnapshot } from "@/lib/db";
import { fighterSlug } from "@/lib/slug";
import { fmtDate, fmtRecord } from "@/lib/format";
import { UFC_OFFICIAL } from "@/lib/heritage";

export function ChampionsShowcase({ rankings, fighters, imgs }: {
  rankings: RankingsSnapshot;
  fighters: Map<string, Fighter>;
  imgs: Map<string, PortraitSet>;
}) {
  const divisions = rankings.divisions.filter((d) => !d.is_p4p && d.champion);
  if (!divisions.length) return null;
  return (
    <section className="championship-stage" aria-labelledby="champions-title">
      <div className="between" style={{ alignItems: "end", gap: 20, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">Championship lineage · official rankings snapshot {fmtDate(rankings.snapshot_date)}</div>
          <h2 id="champions-title" className="serif" style={{ fontSize: "clamp(34px,4vw,52px)", lineHeight: 1, marginTop: 6 }}>The champions</h2>
          <p className="dim sm" style={{ maxWidth: 720, marginTop: 10 }}>Every division starts with the belt. PropBetEdge links the current titleholder to the fighter intelligence layer while keeping UFC's official rankings and merchandise one click away.</p>
        </div>
        <div className="championship-links">
          <a href={UFC_OFFICIAL.rankings} className="btn" target="_blank" rel="noopener">Official UFC rankings ↗</a>
          <a href={UFC_OFFICIAL.store} className="btn gold" target="_blank" rel="noopener">Official UFC Store ↗</a>
        </div>
      </div>
      <div className="championship-grid">
        {divisions.map((d) => {
          const champ = d.champion!;
          const f = champ.fighter_id ? fighters.get(champ.fighter_id) : null;
          const body = (
            <>
              <div className="champ-avatar"><Avatar f={{ name: champ.name }} img={f ? imgs.get(f.id) : null} size={76} /></div>
              <ChampionshipBelt size="card" label={`${d.label} champion`} />
              <div className="division-name">{d.label} champion</div>
              <div className="champ-name">{champ.name}</div>
              <div className="champ-record">{f ? fmtRecord(f) : "Official ranking · profile linking"}</div>
            </>
          );
          return f ? <Link key={`${d.key}-${d.is_womens}`} href={`/fighters/${fighterSlug(f)}`} className="champion-premium">{body}</Link> : <div key={`${d.key}-${d.is_womens}`} className="champion-premium">{body}</div>;
        })}
      </div>
      <p className="championship-source">Champion status is taken from the dated UFC rankings snapshot. Belt artwork above is original PropBetEdge visual identity, not UFC championship-belt artwork. <a href={rankings.source_url} target="_blank" rel="noopener">Open the captured official source →</a></p>
    </section>
  );
}
