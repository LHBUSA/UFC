import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Brand";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import { JsonLd } from "@/components/ui";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { getFighters, getFightersByIds, getImagesForFighters, getLatestVideos, type Fighter, type PortraitSet } from "@/lib/db";
import { FightWingCard, HofFace } from "@/components/HofBits";
import { fightWing } from "@/lib/enrichment";
import { HOF_FIGHTS, LEGACY_LENSES, UFC_OFFICIAL } from "@/lib/heritage";
import { HOF_INDUCTEES, HOF_WING_META, HOF_WING_ORDER, initialsOf, inducteesIn, type HofInductee } from "@/lib/hof";
import { fighterSlug } from "@/lib/slug";
import { fmtRecord } from "@/lib/format";
import { SITE } from "@/lib/site";

/* /hall-of-fame — archive directory grouped by wing (Modern · Pioneer ·
 * Contributor · Fight) with per-inductee profile pages. Portraits and pro
 * records come from the fighter archive when an inductee exists there;
 * otherwise a monogram plate keeps the grid consistent. No unrelated
 * imagery, no invented facts. */
export const revalidate = 3600;
export const metadata: Metadata = {
  title: "UFC Hall of Fame — Wings, Inductees, Iconic Fights & Legacy",
  description: "PropBetEdge's independent archive tribute to the UFC Hall of Fame: Modern, Pioneer and Contributor wing inductees with induction class, nationality, divisions, title history and signature fights, plus the Fight Wing's honored bouts.",
  alternates: { canonical: "/hall-of-fame" },
  openGraph: { type: "website", title: "Honor the Fight Game — UFC Hall of Fame", description: "The pioneers, champions, contributors and fights that shaped UFC history.", url: `${SITE.url}/hall-of-fame`, images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: "Honor the Fight Game — UFC Hall of Fame", images: [`${SITE.url}/opengraph-image`] },
};

async function archiveMatches(): Promise<Map<string, { f: Fighter; img: PortraitSet | null }>> {
  const out = new Map<string, { f: Fighter; img: PortraitSet | null }>();
  const people = HOF_INDUCTEES.filter((h) => h.wing !== "contributor");
  const found: Array<[string, Fighter]> = [];
  await Promise.all(people.map(async (h) => {
    const clean = h.name.replace(/[“”"]/g, "");
    const { rows } = await getFighters(clean, 5).catch(() => ({ rows: [] as Fighter[], count: null }));
    const f = rows.find((r) => r.name.toLowerCase() === clean.toLowerCase());
    if (f) found.push([h.slug, f]);
  }));
  const imgs = found.length ? await getImagesForFighters(found.map(([, f]) => f.id)).catch(() => new Map<string, PortraitSet>()) : new Map<string, PortraitSet>();
  for (const [slug, f] of found) out.set(slug, { f, img: imgs.get(f.id) || null });
  return out;
}

function Card({ h, m }: { h: HofInductee; m?: { f: Fighter; img: PortraitSet | null } }) {
  return (
    <Link href={`/hall-of-fame/${h.slug}`} className="hof-card">
      <HofFace slug={h.slug} name={h.name} slot="avatar" archive={m} />
      <span>
        <span className="hof-kicker">{h.inducted ? `Class of ${h.inducted}` : HOF_WING_META[h.wing].short}{h.role ? ` · ${h.role}` : ""}</span>
        <h3>{h.name}</h3>
        <span className="hof-meta">{[h.nationality, h.weightClasses.slice(0, 2).join(" · "), m ? fmtRecord(m.f) : null].filter(Boolean).join(" · ")}</span>
        <p>{h.titles[0] || h.legacy}</p>
      </span>
    </Link>
  );
}

export default async function HallOfFamePage() {
  const [videos, matches] = await Promise.all([getLatestVideos(3).catch(() => []), archiveMatches()]);
  /* Fight Wing: bout-shaped records with both fighters linked where the
   * archive holds them. Falls back to the curated list when not yet generated. */
  const fights = fightWing();
  const fwFighterIds = [...new Set(fights.flatMap((f) => f.fighters.map((x) => x.fighter_id).filter(Boolean)))] as string[];
  const fwFighters = new Map((fwFighterIds.length ? await getFightersByIds(fwFighterIds).catch(() => []) : []).map((f) => [f.id, f]));
  const counts = { modern: inducteesIn("modern").length, pioneer: inducteesIn("pioneer").length, contributor: inducteesIn("contributor").length, fight: HOF_FIGHTS.length };
  return (
    <div className="wrap page hof-page">
      <section className="hof-hero">
        <div>
          <div className="row"><Mark size={34} /><span className="eyebrow">Honor the fight game</span></div>
          <h1>Hall of Fame</h1>
          <p className="lede">The fighters who changed what was possible. The builders who changed what the sport could become. The fights that made whole eras unforgettable. This is an independent archive tribute; the honors themselves belong to the UFC Hall of Fame.</p>
          <div className="hof-actions">
            <a href={UFC_OFFICIAL.hallOfFame} className="btn gold" target="_blank" rel="noopener">Visit the official UFC Hall of Fame ↗</a>
            <Link href="/history" className="btn">History of the fight game</Link>
          </div>
          <nav className="hof-filters" aria-label="Wings">
            {HOF_WING_ORDER.map((w) => <a key={w} href={`#wing-${w}`}>{HOF_WING_META[w].label} · {counts[w]}</a>)}
          </nav>
          <p className="hof-disclaimer">Independent PropBetEdge tribute. Hall of Fame membership, wing assignments and induction classes are credited to UFC&apos;s official Hall of Fame; induction years and records are shown only where confidently sourced. PropBetEdge is not affiliated with or endorsed by UFC.</p>
        </div>
        <div className="hof-belt-stage"><ChampionshipBelt size="hero" label="Hall of Fame" /><span>LEGACY</span></div>
      </section>

      {(["modern", "pioneer", "contributor"] as const).map((w) => {
        const list = inducteesIn(w);
        return (
          <section className="hof-dir" id={`wing-${w}`} key={w} aria-labelledby={`wing-${w}-title`}>
            <div className="hof-dir-head">
              <div><div className="eyebrow">Official UFC designation</div><h2 id={`wing-${w}-title`}>{HOF_WING_META[w].label}</h2><p>{HOF_WING_META[w].blurb}</p></div>
              <small>{list.length} inductees · open a name for the archive profile</small>
            </div>
            {/* The Pioneer wing has a written account behind it. */}
            {w === "pioneer" && (
              <p className="hof-wing-read">
                The era that produced this wing is told in full in{" "}
                <Link href="/history/gracie-influence">The Gracie Influence</Link> — Royce Gracie, Ken Shamrock and Dan
                Severn, built on the bouts this archive holds.
              </p>
            )}
            <div className="hof-cards">{list.map((h) => <Card key={h.slug} h={h} m={matches.get(h.slug)} />)}</div>
          </section>
        );
      })}

      <section className="hof-fights hof-dir" id="wing-fight">
        <div className="hof-fights-head">
          <div><div className="eyebrow">Fight Wing</div><h2>Some nights become part of the language of MMA.</h2><p>{HOF_WING_META.fight.blurb} Listed with the event and year so you can find them in the archive.</p></div>
          <a href={UFC_OFFICIAL.hallOfFame} target="_blank" rel="noopener">Official Hall of Fame ↗</a>
        </div>
        {fights.length ? (
          <div className="hof-fw-grid">{fights.map((f) => <FightWingCard key={f.slug} f={f} fighters={fwFighters} />)}</div>
        ) : (
          <div className="hof-fight-grid">
            {HOF_FIGHTS.map((f, i) => (
              <div className="hof-fight" key={f.fight}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <div><b>{f.fight}</b><span className="hof-fight-meta">{f.event} · {f.year}</span><span className="hof-fight-note">{f.note}</span></div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="legacy-section">
        <div className="legacy-intro"><div className="eyebrow">How to think about greatness</div><h2>There is no honest GOAT formula that erases eras.</h2><p>PropBetEdge should make the argument richer, not flatter. Instead of publishing a fake universal score, we separate the dimensions that make a legacy case and let readers weigh them.</p></div>
        <div className="legacy-grid">
          {LEGACY_LENSES.map((lens) => <article key={lens.label}><strong>{lens.label}</strong><p>{lens.body}</p></article>)}
        </div>
      </section>

      <VideoRail videos={videos} title="From UFC's official channel" eyebrow="Official video" feature={false} note="Free, publisher-hosted video embedded from UFC's official YouTube channel · not hosted by PropBetEdge" />

      <OfficialDestinations title="Explore UFC's own history, athletes and archive" />

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "CollectionPage", "@id": `${SITE.url}/hall-of-fame#collection`, url: `${SITE.url}/hall-of-fame`, name: "UFC Hall of Fame — PropBetEdge tribute", isPartOf: { "@id": `${SITE.url}/#site` },
        about: { "@type": "SportsOrganization", name: "Ultimate Fighting Championship", url: UFC_OFFICIAL.hallOfFame },
        mainEntity: { "@type": "ItemList", name: "UFC Hall of Fame honorees", itemListElement: HOF_INDUCTEES.map((h, index) => ({ "@type": "ListItem", position: index + 1, name: h.name, description: HOF_WING_META[h.wing].label, url: `${SITE.url}/hall-of-fame/${h.slug}` })) },
        video: videos.length ? videoJsonLd(videos) : undefined,
      }} />
    </div>
  );
}
