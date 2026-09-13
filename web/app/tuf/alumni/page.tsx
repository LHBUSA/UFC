import type { Metadata } from "next";
import Link from "next/link";
import { Avatar, Empty, JsonLd, PageHead } from "@/components/ui";
import { getTufGraph, STATUS_LABEL, type TufAlum } from "@/lib/tufGraph";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import { getRankingIndex } from "@/lib/rankings";
import { bestRank, rankStack } from "@/lib/rankingContext";
import { fighterSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";

/* /tuf/alumni — every TUF contestant we can name as a canonical fighter, from
 * the house to the UFC.
 *
 * What it will not do: call anyone active or retired (the last UFC fight is
 * shown instead), count a TUF tournament final as a title-fight win, or add a
 * contestant who never resolved to a fighter record. The house record is the
 * exhibitions and unverified bouts; the UFC record is sanctioned bouts only. */
export const revalidate = 900;

const PER_PAGE = 60;
const TITLE = "TUF Alumni — From The Ultimate Fighter to the UFC | PropBetEdge UFC";
const DESCRIPTION = "Every Ultimate Fighter contestant linked to their UFC career: season, house record, winner or finalist, UFC debut, UFC record, last fight and current ranking, joined on canonical fighter identity.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/tuf/alumni" },
  keywords: ["TUF alumni", "The Ultimate Fighter alumni", "TUF winners UFC careers", "TUF contestants UFC record"],
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: `${SITE.url}/tuf/alumni` },
  twitter: { card: "summary_large_image", title: "TUF Alumni", description: DESCRIPTION },
};

type Filter = "all" | "winners" | "finalists" | "ufc" | "ranked" | "title";
type Sort = "recent" | "wins" | "season";
const FILTERS: Record<Filter, string> = { all: "All", winners: "Winners", finalists: "Finalists", ufc: "Fought in the UFC", ranked: "Ranked now", title: "Won a UFC title fight" };
const SORTS: Record<Sort, string> = { recent: "Last UFC fight", wins: "UFC wins", season: "Season" };
type SP = { filter?: string; sort?: string; page?: string };

function hrefFor(cur: { filter: Filter; sort: Sort }, patch: Partial<{ filter: Filter; sort: Sort; page: number }>) {
  const next = { ...cur, page: 1, ...patch };
  const q = new URLSearchParams();
  if (next.filter !== "all") q.set("filter", next.filter);
  if (next.sort !== "recent") q.set("sort", next.sort);
  if (next.page > 1) q.set("page", String(next.page));
  const s = q.toString();
  return `/tuf/alumni${s ? `?${s}` : ""}`;
}

const record = (a: TufAlum) => `${a.ufc.w}-${a.ufc.l}${a.ufc.d ? `-${a.ufc.d}` : ""}${a.ufc.nc ? ` (${a.ufc.nc} NC)` : ""}`;

export default async function TufAlumniPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const [graph, rankIndex] = await Promise.all([getTufGraph(), getRankingIndex()]);
  if (!graph) {
    return (
      <div className="wrap page">
        <PageHead eyebrow="The Ultimate Fighter" title="TUF Alumni" crumbs={[{ name: "The Ultimate Fighter", href: "/tuf" }, { name: "Alumni" }]} />
        <Empty title="Alumni unavailable" cta={{ href: "/tuf", label: "TUF archive" }}>The canonical fight database could not be read just now. This page shows nothing rather than a partial list.</Empty>
      </div>
    );
  }
  const ctx = (id: string) => rankIndex?.byFighter.get(id) ?? null;
  const filter = (Object.keys(FILTERS) as Filter[]).includes(sp.filter as Filter) ? (sp.filter as Filter) : "all";
  const sort = (Object.keys(SORTS) as Sort[]).includes(sp.sort as Sort) ? (sp.sort as Sort) : "recent";
  const cur = { filter, sort };

  const all = graph.alumni;
  const pass: Record<Filter, (a: TufAlum) => boolean> = {
    all: () => true,
    winners: (a) => a.best === "winner",
    finalists: (a) => a.best === "winner" || a.best === "finalist",
    ufc: (a) => a.ufc.fights > 0,
    ranked: (a) => Boolean(bestRank(ctx(a.fighterId))),
    title: (a) => a.ufc.titleFightWins > 0,
  };
  const rows = all.filter(pass[filter]).sort((x, y) => {
    if (sort === "wins") return y.ufc.w - x.ufc.w || x.name.localeCompare(y.name);
    if (sort === "season") return (x.stints[0].season.year - y.stints[0].season.year) || x.stints[0].season.number - y.stints[0].season.number || x.name.localeCompare(y.name);
    return String(y.ufc.last?.eventDate || "").localeCompare(String(x.ufc.last?.eventDate || "")) || x.name.localeCompare(y.name);
  });
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const page = Math.min(Math.max(1, Number(sp.page) || 1), pages);
  const shown = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const imgs = await getVerifiedDisplayImagesForFighters(shown.map((a) => a.fighterId));

  const m = {
    alumni: all.length,
    ufc: all.filter((a) => a.ufc.fights > 0).length,
    winners: all.filter((a) => a.best === "winner").length,
    ranked: all.filter((a) => bestRank(ctx(a.fighterId))).length,
    champions: all.filter((a) => (ctx(a.fighterId)?.championships.length ?? 0) > 0).length,
    ufcWins: all.reduce((n, a) => n + a.ufc.w, 0),
  };

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="The Ultimate Fighter"
            title="TUF Alumni"
            lede="From the house to the UFC. Every contestant the archive can name as a canonical fighter, followed from their season to their UFC debut, record, last fight and current ranking."
            crumbs={[{ name: "The Ultimate Fighter", href: "/tuf" }, { name: "Alumni" }]}
          />
        </div>
      </div>

      <section className="wrap tuf-cov">
        <div className="tuf-cov-grid">
          <div className="tuf-cov-cell"><b>{m.alumni}</b><span>alumni linked</span></div>
          <div className="tuf-cov-cell"><b>{m.ufc}</b><span>fought in the UFC</span></div>
          <div className="tuf-cov-cell"><b>{m.winners}</b><span>tournament winners</span></div>
          <div className="tuf-cov-cell"><b>{m.ranked}</b><span>ranked now</span></div>
          <div className="tuf-cov-cell"><b>{m.champions}</b><span>current champions</span></div>
          <div className="tuf-cov-cell is-total"><b>{m.ufcWins.toLocaleString()}</b><span>UFC wins</span></div>
        </div>
      </section>

      <section className="wrap tuf-section">
        <nav className="tuf-filter" aria-label="Filter alumni">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <Link key={f} href={hrefFor(cur, { filter: f })} aria-current={f === filter ? "true" : undefined}>{FILTERS[f]}</Link>
          ))}
        </nav>
        <nav className="tuf-filter tuf-filter-sort" aria-label="Sort alumni">
          <span>Sort</span>
          {(Object.keys(SORTS) as Sort[]).map((s) => (
            <Link key={s} href={hrefFor(cur, { sort: s })} aria-current={s === sort ? "true" : undefined}>{SORTS[s]}</Link>
          ))}
        </nav>
        <p className="tuf-fine">{rows.length} fighter{rows.length === 1 ? "" : "s"}{pages > 1 ? ` · page ${page} of ${pages}` : ""}</p>

        {shown.length ? (
          <ul className="tuf-alumni">
            {shown.map((a) => {
              const stack = rankStack(ctx(a.fighterId));
              const house = a.stints.reduce((n, s) => ({ w: n.w + s.houseW, l: n.l + s.houseL }), { w: 0, l: 0 });
              return (
                <li key={a.fighterId} className="tuf-alum">
                  <Avatar f={{ name: a.name }} img={imgs.get(a.fighterId)} size={56} className="tuf-face" />
                  <div className="tuf-alum-main">
                    <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(a.fighter)}`}>{a.name}</Link>
                    <span className="tuf-alum-seasons">
                      {a.stints.map((s) => (
                        <Link key={s.season.slug} href={`/tuf/${s.season.slug}`} className={`tuf-pill ${s.status === "winner" ? "tuf-pill-ok" : "tuf-pill-thin"}`}>
                          {s.season.edition === "us" ? `TUF ${s.season.number}` : s.season.name.replace(/^The Ultimate Fighter:?\s*/i, "")} · {STATUS_LABEL[s.status]}
                        </Link>
                      ))}
                    </span>
                    <span className="tuf-alum-meta">
                      {house.w + house.l ? <span>House {house.w}-{house.l}</span> : null}
                      {a.ufc.fights ? <span>UFC {record(a)} · {a.ufc.fights} fight{a.ufc.fights === 1 ? "" : "s"}</span> : <span className="tuf-none">No UFC bout on record</span>}
                      {a.ufc.debut ? <span>Debut {fmtDate(a.ufc.debut.eventDate, { month: "short", year: "numeric" })}</span> : null}
                      {a.ufc.last ? <span>Last UFC fight {fmtDate(a.ufc.last.eventDate, { month: "short", year: "numeric" })}</span> : null}
                      {a.ufc.next ? <span className="tuf-alum-next">Next: {fmtDate(a.ufc.next.eventDate, { month: "short", day: "numeric", year: "numeric" })}</span> : null}
                      {a.ufc.titleFightWins ? <span className="tuf-alum-title">{a.ufc.titleFightWins} title-fight win{a.ufc.titleFightWins === 1 ? "" : "s"}</span> : null}
                    </span>
                  </div>
                  {stack.length ? (
                    <span className="tuf-alum-rank">
                      {stack.slice(0, 2).map((r) => <span key={r.full}>{r.full}</span>)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title="No alumni match" cta={{ href: "/tuf/alumni", label: "All alumni" }}>No linked TUF contestant matches this filter.</Empty>
        )}

        {pages > 1 && (
          <nav className="tuf-pages" aria-label="Pages">
            {page > 1 ? <Link className="btn sm" href={hrefFor(cur, { page: page - 1 })}>← Previous</Link> : <span />}
            <span className="tuf-fine">Page {page} of {pages}</span>
            {page < pages ? <Link className="btn sm" href={hrefFor(cur, { page: page + 1 })}>Next →</Link> : <span />}
          </nav>
        )}

        <p className="tuf-note">
          <b>How this is built.</b> A contestant appears here only once the archive has resolved their printed name to a canonical
          fighter record, with the evidence kept in the repository; a contestant who never resolved is not given a borrowed
          career. &ldquo;House&rdquo; is the in-house record: exhibitions and unverified bouts, never part of a professional record. UFC
          records, debuts and last fights come from the canonical fight tables, and a Contender Series bout is not a UFC fight.
          A TUF tournament final is a UFC fight but is not a title fight, whatever the feed&rsquo;s title flag says. Rankings and
          champions are read from the single official snapshot the whole site uses
          {rankIndex?.snapshotDate ? ` (${fmtDate(rankIndex.snapshotDate, { month: "short", day: "numeric", year: "numeric" })})` : ""}. There are no active or
          retired labels.
        </p>
      </section>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: TITLE,
          description: DESCRIPTION,
          url: `${SITE.url}/tuf/alumni`,
          isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: rows.length,
            itemListElement: shown.map((a, i) => ({ "@type": "ListItem", position: (page - 1) * PER_PAGE + i + 1, item: { "@type": "Person", name: a.name, url: `${SITE.url}/fighters/${fighterSlug(a.fighter)}` } })),
          },
        }}
      />
    </>
  );
}
