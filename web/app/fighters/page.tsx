import type { Metadata } from "next";
import Link from "next/link";
import { getFighters, getBookedFighterIds, getFightersByIds, getRankings } from "@/lib/db";
import { resolveFighterPortraits } from "@/lib/fighterMedia";
import { Empty, FighterCard, PageHead, SectionHead, JsonLd } from "@/components/ui";
import { fighterSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "UFC Fighters — Records, Stats & Fight History",
  description: "Fighter profiles for the UFC roster and archive: record, physicals, fight history, round-by-round striking and grappling stats, and next fight.",
  alternates: { canonical: "/fighters" },
  openGraph: { title: "UFC Fighters", description: "Records, physicals, fight history and round stats.", url: `${SITE.url}/fighters` },
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const PAGE = 48;

export default async function FightersPage({ searchParams }: { searchParams: Promise<{ q?: string; letter?: string; page?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q || "").slice(0, 60).trim();
  const letter = LETTERS.includes((sp.letter || "").toUpperCase()) ? (sp.letter || "").toUpperCase() : "";
  const page = Math.max(1, Number(sp.page) || 1);
  const browsing = Boolean(q || letter || page > 1);

  if (!browsing) {
    /* Default view: fighters booked on upcoming cards, then champions. */
    const [bookedIds, rankings] = await Promise.all([getBookedFighterIds(), getRankings()]);
    const champIds = (rankings?.divisions || []).filter((x) => !x.is_p4p && x.champion?.fighter_id).map((x) => x.champion!.fighter_id!);
    const [booked, champs] = await Promise.all([getFightersByIds(bookedIds), getFightersByIds(champIds)]);
    const imgs = await resolveFighterPortraits([...booked, ...champs].map((f) => f.id), { surface: "high_visibility" });
    const withPhoto = booked.filter((f) => imgs.has(f.id));
    const withoutPhoto = booked.filter((f) => !imgs.has(f.id));
    const roster = [...withPhoto, ...withoutPhoto].sort((a, b) => Number(imgs.has(b.id)) - Number(imgs.has(a.id)) || a.name.localeCompare(b.name));
    return (
      <div className="wrap page">
        <PageHead crumbs={[{ name: "Fighters" }]} eyebrow="Roster & archive" title="Fighters" lede="Every fighter on the upcoming cards, the champions, and an archive keyed by source id so records never get mixed up. Search by name or browse A–Z.">
          <Search q={q} />
          <Alpha current={letter} />
        </PageHead>
        {champs.length > 0 && (
          <>
            <SectionHead eyebrow="Official rankings" title="Champions" href="/rankings" cta="Full rankings" />
            <div className="fgrid mb-6">{champs.map((f) => <FighterCard key={f.id} f={f} img={imgs.get(f.id)} meta={(rankings?.divisions || []).find((x) => x.champion?.fighter_id === f.id)?.label + " champion"} />)}</div>
          </>
        )}
        <SectionHead eyebrow={`${roster.length} booked`} title="On the next cards" href="/events" cta="Schedule" />
        {roster.length ? <div className="fgrid">{roster.map((f) => <FighterCard key={f.id} f={f} img={imgs.get(f.id)} />)}</div>
          : <Empty title="No fighters booked yet">Fighters appear here as soon as bouts are announced for the next cards. Use search or the A–Z index for the archive.</Empty>}
        <JsonLd data={{ "@context": "https://schema.org", "@type": "CollectionPage", name: "UFC fighters", url: `${SITE.url}/fighters`, isPartOf: { "@id": `${SITE.url}/#site` } }} />
      </div>
    );
  }

  const { rows, count } = await getFighters(q, PAGE, (page - 1) * PAGE, { letter: letter || undefined });
  const imgs = await resolveFighterPortraits(rows.map((f) => f.id), { surface: "standard" });
  const pages = count ? Math.ceil(count / PAGE) : 1;
  const base = `/fighters?${q ? `q=${encodeURIComponent(q)}&` : ""}${letter ? `letter=${letter}&` : ""}`;
  return (
    <div className="wrap page">
      <PageHead crumbs={[{ name: "Fighters", href: "/fighters" }, { name: q ? `“${q}”` : letter ? `${letter}` : `Page ${page}` }]} eyebrow="Roster & archive" title={q ? `Fighters matching “${q}”` : letter ? `Fighters · ${letter}` : "All fighters"} lede={count != null ? `${count.toLocaleString()} fighters in the archive match.` : undefined}>
        <Search q={q} />
        <Alpha current={letter} />
      </PageHead>
      {rows.length ? (
        <>
          <div className="fgrid">{rows.map((f) => <FighterCard key={f.id} f={f} img={imgs.get(f.id)} />)}</div>
          {pages > 1 && (
            <nav className="pager" aria-label="Pagination">
              {page > 1 && <Link href={`${base}page=${page - 1}`} className="btn">← Previous</Link>}
              <span className="btn ghost mono">{page} / {pages}</span>
              {page < pages && <Link href={`${base}page=${page + 1}`} className="btn">Next →</Link>}
            </nav>
          )}
        </>
      ) : q ? (
        <Empty title={`No fighter matches “${q}”`} cta={{ href: "/fighters", label: "Back to the roster" }}>Try a shorter name or a surname. The archive keys fighters by source id, so spelling variants resolve as the alias table grows.</Empty>
      ) : (
        <Empty title="Nothing here yet">Fighters populate from card data and the UFC Stats backfill.</Empty>
      )}
    </div>
  );
}

function Search({ q }: { q: string }) {
  return (
    <form className="search mt-5" action="/fighters" method="get" role="search">
      <input type="search" name="q" defaultValue={q} placeholder="Search fighters by name" aria-label="Search fighters" autoComplete="off" />
      <button type="submit" className="btn gold">Search</button>
    </form>
  );
}
function Alpha({ current }: { current: string }) {
  return (
    <nav className="alpha" aria-label="Browse A to Z">
      {LETTERS.map((l) => <Link key={l} href={`/fighters?letter=${l}`} aria-current={current === l ? "true" : undefined}>{l}</Link>)}
    </nav>
  );
}
