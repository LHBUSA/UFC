import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, Empty, JsonLd } from "@/components/ui";
import { AlumCard } from "@/components/Dwcs";
import { getImagesForFighters } from "@/lib/db";
import { getDwcsGraph, getOutcomeClaims } from "@/lib/dwcsGraph";
import { alumniMetrics, filterAlumni, FILTER_LABEL, paginate, parseFilter, parseSeries, parseSort, SORT_LABEL, sortAlumni, type AlumniFilter, type AlumniSort } from "@/lib/dwcsAlumni";
import { getRankingIndex } from "@/lib/rankings";
import { fighterSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 900;

const PER_PAGE = 48;

export const metadata: Metadata = {
  title: "DWCS Alumni — From Dana White's Contender Series to the UFC",
  description: "Every Dana White's Contender Series fighter tracked from their DWCS fight to the UFC: debut, UFC record, last fight, current ranking and champions, linked by canonical fighter identity.",
  keywords: ["DWCS alumni", "Contender Series alumni", "Dana White's Contender Series fighters", "DWCS to UFC", "Contender Series champions", "DWCS ranked fighters"],
  alternates: { canonical: "/contender-series/alumni" },
  openGraph: { type: "website", url: `${SITE.url}/contender-series/alumni`, title: "DWCS Alumni — From the Contender Series to the UFC", description: "Contender Series appearance to UFC debut, record, ranking and title — for every DWCS fighter." },
  twitter: { card: "summary_large_image", title: "DWCS Alumni", description: "From the Contender Series to the UFC." },
};

type SP = { filter?: string; sort?: string; series?: string; page?: string };

function href(cur: { filter: AlumniFilter; sort: AlumniSort; series?: string; page?: number }, patch: Partial<{ filter: AlumniFilter; sort: AlumniSort; series: string | undefined; page: number }>) {
  const next = { ...cur, page: 1, ...patch };
  const q = new URLSearchParams();
  if (next.filter !== "all") q.set("filter", next.filter);
  if (next.sort !== "recent") q.set("sort", next.sort);
  if (next.series) q.set("series", next.series);
  if (next.page && next.page > 1) q.set("page", String(next.page));
  const s = q.toString();
  return `/contender-series/alumni${s ? `?${s}` : ""}`;
}

export default async function DwcsAlumniPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const [graph, rankIndex, claims] = await Promise.all([getDwcsGraph(), getRankingIndex(), getOutcomeClaims()]);
  if (!graph) {
    return (
      <div className="wrap page">
        <Breadcrumbs items={[{ name: "Contender Series", href: "/contender-series" }, { name: "Alumni" }]} />
        <Empty title="Alumni graph unavailable" cta={{ href: "/contender-series", label: "Contender Series" }}>The canonical fight database could not be read just now. This page shows nothing rather than a partial list.</Empty>
      </div>
    );
  }
  const rank = (id: string) => rankIndex?.byFighter.get(id) ?? null;
  const hasContract = (id: string) => (claims.get(id) || []).some((c) => c.claim_type === "contract_awarded");
  const contractClaims = [...claims.values()].flat().filter((c) => c.claim_type === "contract_awarded").length;

  const filter = parseFilter(sp.filter);
  /* The contract filter exists only once sourced claims exist. */
  const activeFilter: AlumniFilter = filter === "contract" && !contractClaims ? "all" : filter;
  const sort = parseSort(sp.sort);
  const series = parseSeries(sp.series);
  const seriesKey = series ? ("brazil" in series ? "brazil" : String(series.season)) : undefined;
  const cur = { filter: activeFilter, sort, series: seriesKey };

  const m = alumniMetrics(graph.alumni, rank);
  const rows = sortAlumni(filterAlumni(graph.alumni, { filter: activeFilter, series, rank, hasContractClaim: hasContract }), sort);
  const page = paginate(rows, Number(sp.page) || 1, PER_PAGE);
  const imgs = await getImagesForFighters(page.rows.map((a) => a.fighter.id));

  const seasons = [...new Set(graph.events.filter((e) => e.identity.series === "dwcs" && e.identity.season).map((e) => e.identity.season as number))].sort((a, b) => a - b);
  const hasBrazil = graph.events.some((e) => e.identity.series === "brazil");
  const filters: AlumniFilter[] = contractClaims ? ["all", "ufc", "ranked", "champions", "contract"] : ["all", "ufc", "ranked", "champions"];
  const snapshot = rankIndex?.snapshotDate || null;

  return (
    <div className="wrap page dwa-page">
      <Breadcrumbs items={[{ name: "Contender Series", href: "/contender-series" }, { name: "Alumni" }]} />
      <section className="dwcs-hero dwa-hero">
        <div className="eyebrow">Dana White&apos;s Contender Series</div>
        <h1>DWCS Alumni</h1>
        <p className="lede">From the Contender Series to the UFC. Every fighter who has stepped into a DWCS cage, followed through their UFC debut, record, last fight and current ranking — joined on canonical fighter identity, never on a name.</p>
        <div className="dwcs-proof">
          <div><b>{m.fighters.toLocaleString()}</b><span>fighters tracked</span></div>
          <div><b>{m.reachedUfc.toLocaleString()}</b><span>reached a UFC card</span></div>
          <div><b>{m.ranked}</b><span>currently ranked</span></div>
          <div><b>{m.champions}</b><span>current {m.champions === 1 ? "champion" : "champions"}</span></div>
          <div><b>{m.ufcFights.toLocaleString()}</b><span>UFC fights since DWCS</span></div>
          <div><b>{m.ufcWins.toLocaleString()}</b><span>UFC wins since DWCS</span></div>
        </div>
        <div className="dwcs-fresh"><i />Canonical fight database{snapshot ? <> · rankings snapshot <time dateTime={snapshot}>{fmtDate(snapshot, { month: "short", day: "numeric", year: "numeric" })}</time></> : null}</div>
      </section>

      <nav className="dwcs-season-nav dwa-nav" aria-label="Alumni filter">
        {filters.map((f) => <Link key={f} href={href(cur, { filter: f })} aria-current={f === activeFilter ? "true" : undefined}>{FILTER_LABEL[f]}</Link>)}
      </nav>
      <div className="dwa-controls">
        <nav aria-label="Sort alumni">
          <span className="dwa-lab">Sort</span>
          {(Object.keys(SORT_LABEL) as AlumniSort[]).map((s) => <Link key={s} href={href(cur, { sort: s })} aria-current={s === sort ? "true" : undefined}>{SORT_LABEL[s]}</Link>)}
        </nav>
        <nav aria-label="DWCS season">
          <span className="dwa-lab">Season</span>
          <Link href={href(cur, { series: undefined })} aria-current={!seriesKey ? "true" : undefined}>All</Link>
          {seasons.map((s) => <Link key={s} href={href(cur, { series: String(s) })} aria-current={seriesKey === String(s) ? "true" : undefined}>S{s}</Link>)}
          {hasBrazil ? <Link href={href(cur, { series: "brazil" })} aria-current={seriesKey === "brazil" ? "true" : undefined}>Brazil</Link> : null}
        </nav>
      </div>

      <div className="between mb-4">
        <div className="dim sm">{rows.length.toLocaleString()} {rows.length === 1 ? "fighter" : "fighters"}{page.pages > 1 ? ` · page ${page.page} of ${page.pages}` : ""}</div>
        <Link href="/contender-series" className="btn sm">Seasons &amp; weeks →</Link>
      </div>

      {page.rows.length ? (
        <div className="dwa-grid">
          {page.rows.map((a) => <AlumCard key={a.fighter.id} alum={a} img={imgs.get(a.fighter.id)} ctx={rank(a.fighter.id)} opponents={graph.fighters} claims={claims.get(a.fighter.id)} />)}
        </div>
      ) : (
        <Empty title="No fighters match" cta={{ href: "/contender-series/alumni", label: "All alumni" }}>No Contender Series fighter in the canonical database matches this filter.</Empty>
      )}

      {page.pages > 1 && (
        <nav className="dwa-pages" aria-label="Pages">
          {page.page > 1 ? <Link href={href(cur, { page: page.page - 1 })} className="btn sm">← Previous</Link> : <span />}
          <span className="dim sm">Page {page.page} of {page.pages}</span>
          {page.page < page.pages ? <Link href={href(cur, { page: page.page + 1 })} className="btn sm">Next →</Link> : <span />}
        </nav>
      )}

      <section className="dwcs-source">
        <b>How this is built.</b> Contender Series appearances and results come from the canonical event, bout and result tables that power every PropBetEdge fight page. A fighter &quot;reached a UFC card&quot; when that same canonical fighter record holds a completed UFC-card bout dated after their first Contender Series appearance; UFC fights and wins in the headline count only those bouts. Rankings and champions are read from the one official UFC rankings snapshot the whole site uses. There are no active or retired labels: the last UFC fight date is shown instead.
        {contractClaims ? ` Contract badges appear only where an attributed source names the fighter (${contractClaims} sourced).` : " Contract outcomes are not shown: a win on the Contender Series is not a contract, and no fighter-named source claims are loaded yet."}
      </section>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": `${SITE.url}/contender-series/alumni#collection`,
        url: `${SITE.url}/contender-series/alumni`,
        name: "DWCS Alumni — From Dana White's Contender Series to the UFC",
        description: `${m.fighters} Contender Series fighters tracked; ${m.reachedUfc} have fought on a UFC card since.`,
        isPartOf: { "@id": `${SITE.url}/#site` },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: rows.length,
          itemListElement: page.rows.map((a, i) => ({
            "@type": "ListItem",
            position: (page.page - 1) * PER_PAGE + i + 1,
            item: { "@type": "Person", name: a.fighter.name, url: `${SITE.url}/fighters/${fighterSlug(a.fighter)}` },
          })),
        },
      }} />
    </div>
  );
}
