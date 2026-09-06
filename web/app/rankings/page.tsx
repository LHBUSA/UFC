import type { Metadata } from "next";
import Link from "next/link";
import { getRankings, getFightersByIds, getImagesForFighters } from "@/lib/db";
import { Empty, PageHead, JsonLd, Portrait, Avatar, Change, Octagon } from "@/components/ui";
import { fighterSlug } from "@/lib/slug";
import { fmtDate, fmtRecord, WEIGHT_LABEL } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 1800;
export const metadata: Metadata = {
  title: "UFC Rankings — Every Division, Champions & Movers",
  description: "Official UFC rankings by division: champions, the top 15 in every men's and women's weight class, pound-for-pound, and weekly movers, linked to full fighter profiles.",
  alternates: { canonical: "/rankings" },
  openGraph: { title: "UFC Rankings by Division", description: "Champions, top 15 and movers in every division.", url: `${SITE.url}/rankings` },
};

const MEN = ["FLYWEIGHT", "BANTAMWEIGHT", "FEATHERWEIGHT", "LIGHTWEIGHT", "WELTERWEIGHT", "MIDDLEWEIGHT", "LIGHT_HEAVYWEIGHT", "HEAVYWEIGHT"];
const WOMEN = ["STRAWWEIGHT", "FLYWEIGHT", "BANTAMWEIGHT"];

export default async function RankingsPage() {
  const snap = await getRankings();
  const divisions = snap?.divisions || [];
  const ids = divisions.flatMap((d) => [d.champion?.fighter_id, ...d.entries.map((e) => e.fighter_id)]).filter(Boolean) as string[];
  const [fighters, imgs] = await Promise.all([getFightersByIds([...new Set(ids)]), getImagesForFighters([...new Set(ids)])]);
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const movers = divisions.flatMap((d) => d.entries.filter((e) => e.is_new || (e.change && e.change !== 0)).map((e) => ({ ...e, division: d.label })));
  const weight = divisions.filter((d) => !d.is_p4p);
  const p4p = divisions.filter((d) => d.is_p4p);

  return (
    <div className="wrap page">
      <PageHead crumbs={[{ name: "Rankings" }]} eyebrow={snap ? `Official UFC rankings · snapshot ${fmtDate(snap.snapshot_date)}` : "Official UFC rankings"} title="Rankings by division"
        lede="The official UFC rankings, captured as a dated snapshot so every move is traceable. Names link to full profiles wherever the fighter is in our archive; the rest link once the archive catches up." />

      {!snap ? (
        <Empty title="Rankings snapshot not loaded yet" cta={{ href: "/fighters", label: "Browse fighters" }}>No ranking is displayed until it comes from the tracked source with a date attached. Nothing here is estimated.</Empty>
      ) : (
        <>
          {movers.length > 0 && (
            <div className="card mb-6">
              <div className="eyebrow mb-3">This week's movers</div>
              <div className="tags">
                {movers.map((m) => {
                  const f = m.fighter_id ? byId.get(m.fighter_id) : null;
                  const inner = <><span>#{m.rank} {m.name}</span><span className="faint">· {m.division}</span><Change change={m.change} isNew={m.is_new} /></>;
                  return f ? <Link key={`${m.division}-${m.rank}-${m.name}`} href={`/fighters/${fighterSlug(f)}`} className="tag">{inner}</Link> : <span key={`${m.division}-${m.rank}-${m.name}`} className="tag">{inner}</span>;
                })}
              </div>
            </div>
          )}

          <div className="rank-grid">
            {weight.map((d) => {
              const champ = d.champion?.fighter_id ? byId.get(d.champion.fighter_id) : null;
              const top = d.entries.slice(0, 5), rest = d.entries.slice(5);
              return (
                <section className="division" key={`${d.key}-${d.is_womens}`} id={`${d.is_womens ? "w-" : ""}${d.key.toLowerCase()}`}>
                  <div className="champ">
                    {d.champion ? <Portrait f={{ name: d.champion.name }} img={champ ? imgs.get(champ.id) : null} sizes="96px" /> : <div className="portrait"><div className="fallback"><Octagon /><small>Vacant</small></div></div>}
                    <div className="who">
                      <div className="belt">◆ {d.label} champion</div>
                      {d.champion ? (champ ? <Link href={`/fighters/${fighterSlug(champ)}`} className="n">{d.champion.name}</Link> : <div className="n">{d.champion.name}</div>) : <div className="n">Vacant</div>}
                      <div className="m">{champ ? `${fmtRecord(champ)}${champ.nickname ? ` · “${champ.nickname}”` : ""}` : d.champion ? "Profile pending" : "Title vacant"}</div>
                    </div>
                  </div>
                  <ol>
                    {top.map((e) => <Rank key={`${e.rank}-${e.name}`} e={e} f={e.fighter_id ? byId.get(e.fighter_id) : null} img={e.fighter_id ? imgs.get(e.fighter_id) : null} />)}
                  </ol>
                  {rest.length > 0 && (
                    <details>
                      <summary>Ranked 6–{rest[rest.length - 1].rank}</summary>
                      <ol>{rest.map((e) => <Rank key={`${e.rank}-${e.name}`} e={e} f={e.fighter_id ? byId.get(e.fighter_id) : null} img={e.fighter_id ? imgs.get(e.fighter_id) : null} />)}</ol>
                    </details>
                  )}
                </section>
              );
            })}
          </div>

          {p4p.length > 0 && (
            <div className="mt-7">
              <div className="sec-head"><div><div className="eyebrow">Pound for pound</div><h2>Best in the world</h2></div></div>
              <div className="grid-2">
                {p4p.map((d) => (
                  <section className="division" key={`${d.key}-${d.is_womens}`}>
                    <div className="champ" style={{ gridTemplateColumns: "1fr" }}><div className="who"><div className="belt">◆ {d.label}</div><div className="m">Top 15 across all divisions</div></div></div>
                    <ol>{d.entries.map((e) => <Rank key={`${e.rank}-${e.name}`} e={e} f={e.fighter_id ? byId.get(e.fighter_id) : null} img={e.fighter_id ? imgs.get(e.fighter_id) : null} />)}</ol>
                  </section>
                ))}
              </div>
            </div>
          )}

          <p className="faint label mt-6">Source: <a href={snap.source_url} rel="noopener nofollow" className="dim">UFC.com official rankings</a>, captured {fmtDate(snap.captured_at.slice(0, 10))}. Rankings are voted on by a media panel and published by the UFC; PropBetEdge records each snapshot with a date and links every name it can resolve to a fighter in its archive.</p>

          <JsonLd data={{
            "@context": "https://schema.org", "@type": "ItemList", name: "UFC rankings by division", url: `${SITE.url}/rankings`, dateModified: snap.captured_at,
            itemListElement: weight.map((d, i) => ({
              "@type": "ListItem", position: i + 1, name: `${d.label} rankings`,
              item: { "@type": "ItemList", name: d.label, itemListElement: [...(d.champion ? [{ "@type": "ListItem", position: 0, name: `${d.champion.name} (champion)` }] : []), ...d.entries.map((e) => ({ "@type": "ListItem", position: e.rank, name: e.name }))] },
            })),
          }} />
        </>
      )}

      <div className="mt-7 well">
        <div className="eyebrow dim mb-2">Divisions</div>
        <div className="tags">
          {MEN.map((d) => <a key={d} href={`#${d.toLowerCase()}`} className="tag">{WEIGHT_LABEL[d]}</a>)}
          {WOMEN.map((d) => <a key={`w${d}`} href={`#w-${d.toLowerCase()}`} className="tag">Women's {WEIGHT_LABEL[d]}</a>)}
        </div>
      </div>
    </div>
  );
}

function Rank({ e, f, img }: { e: { rank: number; name: string; change: number | null; is_new: boolean }; f?: { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null; record_w: number | null; record_l: number | null; record_d: number | null; record_nc: number | null } | null; img?: { thumb: string } | null }) {
  return (
    <li>
      <span className="rk">{e.rank}</span>
      <span className="row" style={{ gap: 8, minWidth: 0 }}>
        <Avatar f={{ name: e.name }} img={img as never} size={28} />
        {f ? <Link href={`/fighters/${fighterSlug(f)}`} className="n truncate">{e.name}</Link> : <span className="n unl truncate">{e.name}</span>}
        {f && f.record_w != null && <span className="faint mono label hide-m">{fmtRecord(f)}</span>}
      </span>
      <Change change={e.change} isNew={e.is_new} />
    </li>
  );
}
