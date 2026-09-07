import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { getFighters, getImagesForFighters, type Fighter, type PortraitSet } from "@/lib/db";
import { fighterSlug, slugify } from "@/lib/slug";
import { fmtDate, fmtRecord } from "@/lib/format";
import { HOF_FIGHTS, UFC_OFFICIAL } from "@/lib/heritage";
import { HOF_BY_SLUG, HOF_INDUCTEES, HOF_WING_META, inducteesIn } from "@/lib/hof";
import { HofFace, hofFact } from "@/components/HofBits";
import { hofPacket, portrait } from "@/lib/enrichment";
import { SITE } from "@/lib/site";

/* /hall-of-fame/[slug] — archival profile for one inductee. Facts come from
 * the curated dataset (lib/hof.ts); the pro record and portrait are pulled
 * from the fighter archive only when the inductee exists there under the
 * same name. Nothing unavailable is invented. */
export const revalidate = 3600;

export function generateStaticParams() { return HOF_INDUCTEES.map((h) => ({ slug: h.slug })); }

async function archiveMatch(name: string): Promise<{ f: Fighter; img: PortraitSet | null } | null> {
  const clean = name.replace(/[“”"]/g, "");
  const { rows } = await getFighters(clean, 5).catch(() => ({ rows: [] as Fighter[], count: null }));
  const f = rows.find((r) => r.name.toLowerCase() === clean.toLowerCase()) || null;
  if (!f) return null;
  const imgs = await getImagesForFighters([f.id]).catch(() => new Map<string, PortraitSet>());
  return { f, img: imgs.get(f.id) || null };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const h = HOF_BY_SLUG.get((await params).slug);
  if (!h) return { title: "Inductee not found", robots: { index: false } };
  const title = `${h.name} — UFC Hall of Fame ${HOF_WING_META[h.wing].label}`;
  const description = `${h.name}, UFC Hall of Fame ${HOF_WING_META[h.wing].label}${h.inducted ? ` (inducted ${h.inducted})` : ""}: ${h.legacy}`;
  return { title, description, alternates: { canonical: `/hall-of-fame/${h.slug}` }, openGraph: { title, description, url: `${SITE.url}/hall-of-fame/${h.slug}` }, twitter: { card: "summary_large_image", title, description } };
}

export default async function HofProfile({ params }: { params: Promise<{ slug: string }> }) {
  const h = HOF_BY_SLUG.get((await params).slug);
  if (!h) notFound();
  const wing = HOF_WING_META[h.wing];
  const match = h.wing === "contributor" ? null : await archiveMatch(h.name);
  const peers = inducteesIn(h.wing);
  const i = peers.findIndex((p) => p.slug === h.slug);
  const prev = peers[(i - 1 + peers.length) % peers.length], next = peers[(i + 1) % peers.length];
  const fights = HOF_FIGHTS.filter((f) => f.fight.toLowerCase().includes(h.name.split(" ").slice(-1)[0].toLowerCase()));
  /* Enrichment packet: sourced biography, verified identity facts, the
   * explicit archive link produced by scripts/hof/resolve-fighters.mjs and the
   * portrait provenance. Anything absent stays absent rather than guessed. */
  const pk = hofPacket(h.slug);
  const photo = portrait(pk, "profile");
  const linked = pk?.archive?.archive_status === "linked" ? pk.archive : null;
  /* Build the archive link from the CANONICAL fighter name plus its source id,
   * not the Hall of Fame slug, so the URL matches the fighter page's own slug. */
  const linkedId = linked?.espn_athlete_id || linked?.ufcstats_id || null;
  const archiveHref = linked && linkedId ? `/fighters/${slugify(linked.fighter_name || h.name)}-${linkedId}` : match ? `/fighters/${fighterSlug(match.f)}` : null;
  const dob = hofFact(h.slug, "date_of_birth") as string | null;
  const nationality = (hofFact(h.slug, "nationality") as string | null) || h.nationality;
  const fullName = (hofFact(h.slug, "full_name") as string | null) || h.name;
  const rec = linked?.record;
  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Hall of Fame", href: "/hall-of-fame" }, { name: h.name }]} />
      <header className="hof-profile">
        <HofFace slug={h.slug} name={h.name} slot="profile" archive={match} large />
        <div>
          <div className="eyebrow">UFC Hall of Fame · {wing.label}{h.inducted ? ` · Class of ${h.inducted}` : ""}</div>
          <h1>{h.name}</h1>
          <p className="hof-lede">{h.legacy}</p>
          <div className="hof-links">
            {archiveHref && <Link href={archiveHref} className="btn gold">Archive profile →</Link>}
            <a href={UFC_OFFICIAL.hallOfFame} className="btn" target="_blank" rel="noopener">Official UFC Hall of Fame ↗</a>
            <Link href="/history" className="btn">History of the fight game</Link>
          </div>
        </div>
        <aside className="hof-plate" aria-label="Induction plate">
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}><ChampionshipBelt size="mini" label="Hall of Fame" /></div>
          <dl>
            <div><dt>Wing</dt><dd>{wing.label}</dd></div>
            <div><dt>Inducted</dt><dd>{h.inducted ?? <small>Year on file at UFC.com</small>}</dd></div>
            {fullName !== h.name && <div><dt>Full name</dt><dd>{fullName}</dd></div>}
            {nationality && <div><dt>Nationality</dt><dd>{nationality}</dd></div>}
            {dob && <div><dt>Born</dt><dd>{fmtDate(dob, { month: "long", day: "numeric", year: "numeric" })}</dd></div>}
            {h.role && <div><dt>Role</dt><dd>{h.role}</dd></div>}
            {h.weightClasses.length > 0 && <div><dt>Divisions</dt><dd>{h.weightClasses.join(" · ")}</dd></div>}
            {rec && <div><dt>Pro record</dt><dd>{fmtRecord({ record_w: rec.w, record_l: rec.l, record_d: rec.d, record_nc: rec.nc })} <small>· archive</small></dd></div>}
            {!rec && match && <div><dt>Pro record</dt><dd>{fmtRecord(match.f)} <small>· archive</small></dd></div>}
            {!rec && !match && h.wing !== "contributor" && <div><dt>Pro record</dt><dd><small>Not in the PropBetEdge archive yet</small></dd></div>}
          </dl>
        </aside>
      </header>

      {h.titles.length > 0 && <section className="hof-sec"><div className="eyebrow">Title history</div><h2>Championships</h2><ul className="hof-list">{h.titles.map((t) => <li key={t}><b>{t}</b></li>)}</ul></section>}
      {h.achievements.length > 0 && <section className="hof-sec"><div className="eyebrow">Notable achievements</div><h2>What set the standard</h2><ul className="hof-list">{h.achievements.map((t) => <li key={t}>{t}</li>)}</ul></section>}
      {(h.signatureFights.length > 0 || fights.length > 0) && (
        <section className="hof-sec">
          <div className="eyebrow">Signature fights</div><h2>Nights that defined the name</h2>
          <ul className="hof-list">
            {h.signatureFights.map((t) => <li key={t}>{t}</li>)}
            {fights.map((f) => <li key={f.fight}><b>{f.fight}</b> · {f.event}, {f.year} · Fight Wing — {f.note}</li>)}
          </ul>
        </section>
      )}
      {pk?.bio?.text && (
        <section className="hof-sec">
          <div className="eyebrow">Background</div><h2>Career summary</h2>
          <p>{pk.bio.text}</p>
          <p className="faint sm"><a href={pk.bio.source_url || undefined} target="_blank" rel="noopener">Source · {pk.bio.source_name}{pk.bio.license ? ` · ${pk.bio.license}` : ""} ↗</a></p>
        </section>
      )}
      <section className="hof-sec">
        <div className="eyebrow">Legacy</div><h2>{wing.label}</h2>
        <p>{wing.blurb}</p>
        <p>{h.legacy}</p>
        {photo && <p className="faint sm">Portrait: {photo.attribution}{photo.sourcePage ? <> · <a href={photo.sourcePage} target="_blank" rel="noopener">file page ↗</a></> : null}</p>}
        {!photo && pk?.media_search && <p className="faint sm">No freely licensed portrait was found in approved sources for this inductee ({pk.media_search.rejected.length} candidate{pk.media_search.rejected.length === 1 ? "" : "s"} rejected on license or identity), so the monogram plate is shown.</p>}
        {pk?.archive?.archive_status === "missing" && <p className="faint sm">This inductee does not yet have a canonical row in the PropBetEdge fighter archive, so no archive profile is linked. Recorded as a backfill candidate; no fighter record was created.</p>}
        <p className="faint sm">Independent PropBetEdge tribute. Hall of Fame membership, wing assignment and induction class are credited to the UFC Hall of Fame; fields without a confident source are left blank rather than guessed. PropBetEdge is not affiliated with or endorsed by UFC.</p>
      </section>

      <nav className="hof-prevnext" aria-label="More inductees">
        <Link href={`/hall-of-fame/${prev.slug}`}><small>Previous · {wing.short}</small>← {prev.name}</Link>
        <Link href={`/hall-of-fame/${next.slug}`} style={{ textAlign: "right" }}><small>Next · {wing.short}</small>{next.name} →</Link>
      </nav>

      <div className="mt-6"><OfficialDestinations compact keys={["home", "fightpass", "store"]} /></div>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "ProfilePage", "@id": `${SITE.url}/hall-of-fame/${h.slug}#page`, url: `${SITE.url}/hall-of-fame/${h.slug}`, name: `${h.name} — UFC Hall of Fame`, isPartOf: { "@id": `${SITE.url}/#site` }, mainEntity: { "@type": "Person", name: h.name.replace(/[“”"]/g, ""), nationality: h.nationality || undefined, description: h.legacy, award: `UFC Hall of Fame · ${wing.label}${h.inducted ? ` (${h.inducted})` : ""}`, url: `${SITE.url}/hall-of-fame/${h.slug}` } }} />
      <JsonLd data={{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: SITE.url }, { "@type": "ListItem", position: 2, name: "Hall of Fame", item: `${SITE.url}/hall-of-fame` }, { "@type": "ListItem", position: 3, name: h.name, item: `${SITE.url}/hall-of-fame/${h.slug}` }] }} />
    </div>
  );
}
