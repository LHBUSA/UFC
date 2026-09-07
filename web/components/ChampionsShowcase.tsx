import Link from "next/link";
import { Avatar, Portrait } from "@/components/ui";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import type { Fighter, PortraitSet, RankingsSnapshot } from "@/lib/db";
import { fighterSlug } from "@/lib/slug";
import { fmtDate, fmtRecord, relTime } from "@/lib/format";
import { UFC_OFFICIAL } from "@/lib/heritage";

/* Championship stage: every division's titleholder as a premium card with
 * portrait, original PropBetEdge belt mark, record and the top contenders
 * from the same dated snapshot. Links into the division on /rankings. */
export function ChampionsShowcase({ rankings, fighters, imgs, contenderFighters }: {
  rankings: RankingsSnapshot;
  fighters: Map<string, Fighter>;
  imgs: Map<string, PortraitSet>;
  contenderFighters?: Map<string, Fighter>;
}) {
  const divisions = rankings.divisions.filter((d) => !d.is_p4p && d.champion);
  if (!divisions.length) return null;
  return (
    <section className="championship-stage" aria-labelledby="champions-title">
      <div className="championship-head">
        <div>
          <div className="eyebrow">Championship lineage · official rankings snapshot {fmtDate(rankings.snapshot_date)} · captured {relTime(rankings.captured_at)}</div>
          <h2 id="champions-title">The champions</h2>
          <p>Every division starts with the belt. Each titleholder is linked to PropBetEdge fighter intelligence, with the top contenders from the same dated snapshot beside them and UFC's official rankings one click away.</p>
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
          const top = d.entries.slice(0, 3);
          const anchor = `/rankings#${d.is_womens ? "w-" : ""}${d.key.toLowerCase()}`;
          return (
            <article key={`${d.key}-${d.is_womens}`} className="champion-premium">
              <div className="champion-portrait">
                <Portrait f={{ name: champ.name }} img={f ? imgs.get(f.id) : null} sizes="(max-width: 700px) 50vw, 260px" />
                <span className="champion-plate"><ChampionshipBelt size="mini" label={`${d.label} champion`} /></span>
              </div>
              <div className="champion-copy">
                <div className="division-name">{d.label}{d.is_womens ? " · women's" : ""}</div>
                {f ? <Link href={`/fighters/${fighterSlug(f)}`} className="champ-name">{champ.name}</Link> : <div className="champ-name">{champ.name}</div>}
                <div className="champ-record">{f ? fmtRecord(f) : "Official ranking · profile linking"}{f?.nickname ? ` · “${f.nickname}”` : ""}</div>
                {top.length > 0 && (
                  <ol className="champ-contenders" aria-label={`${d.label} top contenders`}>
                    {top.map((e) => {
                      const cf = e.fighter_id ? (contenderFighters?.get(e.fighter_id) || fighters.get(e.fighter_id)) : null;
                      const inner = <><b>#{e.rank}</b><Avatar f={{ name: e.name }} img={e.fighter_id ? imgs.get(e.fighter_id) : null} size={22} /><span className="truncate">{e.name}</span></>;
                      return <li key={`${e.rank}-${e.name}`}>{cf ? <Link href={`/fighters/${fighterSlug(cf)}`}>{inner}</Link> : <span>{inner}</span>}</li>;
                    })}
                  </ol>
                )}
                <Link href={anchor} className="champ-division-link">Full {d.label} top 15 →</Link>
              </div>
            </article>
          );
        })}
      </div>
      <p className="championship-source">Champion status and contender order come from the dated UFC rankings snapshot. The belt emblem is original PropBetEdge visual identity, not UFC championship-belt artwork. <a href={rankings.source_url} target="_blank" rel="noopener">Open the captured official source →</a></p>
    </section>
  );
}
