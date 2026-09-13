/* DWCS Alumni list logic — pure, no I/O, testable.
 *
 * Filters, sorts and headline metrics over the alumni graph. Rankings are
 * passed in as a lookup against the ONE global ranking index; nothing here
 * decides what a rank is. Metrics count only what the canonical rows hold.
 */
import type { DwcsAlum } from "./dwcsGraph";
import type { FighterRankingContext } from "./rankingContext";

export const ALUMNI_FILTERS = ["all", "ufc", "ranked", "champions", "contract"] as const;
export type AlumniFilter = (typeof ALUMNI_FILTERS)[number];
export const ALUMNI_SORTS = ["recent", "fights", "wins", "dwcs"] as const;
export type AlumniSort = (typeof ALUMNI_SORTS)[number];

export const FILTER_LABEL: Record<AlumniFilter, string> = {
  all: "All alumni", ufc: "Reached UFC", ranked: "Currently ranked", champions: "Current champions", contract: "Contract awarded",
};
export const SORT_LABEL: Record<AlumniSort, string> = {
  recent: "Recent UFC activity", fights: "Most UFC fights", wins: "Most UFC wins", dwcs: "Latest DWCS",
};

type RankLookup = (fighterId: string) => FighterRankingContext | null | undefined;
const ranked = (ctx: FighterRankingContext | null | undefined) => Boolean(ctx && (ctx.championships.length || ctx.divisionRanks.length || ctx.p4p.length));
const champion = (ctx: FighterRankingContext | null | undefined) => Boolean(ctx?.championships.length);

export function parseFilter(v: string | undefined): AlumniFilter {
  return (ALUMNI_FILTERS as readonly string[]).includes(String(v)) ? (v as AlumniFilter) : "all";
}
export function parseSort(v: string | undefined): AlumniSort {
  return (ALUMNI_SORTS as readonly string[]).includes(String(v)) ? (v as AlumniSort) : "recent";
}
/** "1".."99" -> season number, "brazil" -> Brazil, else null (all series). */
export function parseSeries(v: string | undefined): { season: number } | { brazil: true } | null {
  if (v === "brazil") return { brazil: true };
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 100 ? { season: n } : null;
}

export function filterAlumni(
  alumni: DwcsAlum[],
  opts: { filter: AlumniFilter; series: ReturnType<typeof parseSeries>; rank: RankLookup; hasContractClaim?: (fighterId: string) => boolean },
): DwcsAlum[] {
  return alumni.filter((a) => {
    if (opts.series) {
      const inSeries = a.appearances.some((x) => ("brazil" in opts.series! ? x.identity.series === "brazil" : x.identity.series === "dwcs" && x.identity.season === opts.series!.season));
      if (!inSeries) return false;
    }
    switch (opts.filter) {
      case "ufc": return a.reachedUfc;
      case "ranked": return ranked(opts.rank(a.fighter.id));
      case "champions": return champion(opts.rank(a.fighter.id));
      case "contract": return Boolean(opts.hasContractClaim?.(a.fighter.id));
      default: return true;
    }
  });
}

const date = (d: string | null | undefined) => String(d || "");

export function sortAlumni(alumni: DwcsAlum[], sort: AlumniSort): DwcsAlum[] {
  const byName = (a: DwcsAlum, b: DwcsAlum) => a.fighter.name.localeCompare(b.fighter.name);
  const latestDwcs = (a: DwcsAlum, b: DwcsAlum) => date(b.lastDwcs.event.eventDate).localeCompare(date(a.lastDwcs.event.eventDate)) || byName(a, b);
  const rows = [...alumni];
  switch (sort) {
    case "fights": return rows.sort((a, b) => b.ufc.fights - a.ufc.fights || b.ufc.w - a.ufc.w || latestDwcs(a, b));
    case "wins": return rows.sort((a, b) => b.ufc.w - a.ufc.w || a.ufc.l - b.ufc.l || latestDwcs(a, b));
    case "dwcs": return rows.sort(latestDwcs);
    default:
      /* Fighters with UFC activity first, most recent (or booked) first; then
       * everyone else by their latest Contender Series appearance. */
      return rows.sort((a, b) => {
        const la = date(a.ufc.next?.event.eventDate || a.ufc.last?.event.eventDate);
        const lb = date(b.ufc.next?.event.eventDate || b.ufc.last?.event.eventDate);
        if (la && lb) return lb.localeCompare(la) || byName(a, b);
        if (la || lb) return la ? -1 : 1;
        return latestDwcs(a, b);
      });
  }
}

export type AlumniMetrics = {
  fighters: number; reachedUfc: number; ranked: number; champions: number; ufcFights: number; ufcWins: number;
};

/* UFC fights and wins count bouts fought after the fighter's first Contender
 * Series appearance, so a veteran who returned through DWCS does not import a
 * pre-DWCS career into the alumni total. */
export function alumniMetrics(alumni: DwcsAlum[], rank: RankLookup): AlumniMetrics {
  let reachedUfc = 0, rankedN = 0, champions = 0, ufcFights = 0, ufcWins = 0;
  for (const a of alumni) {
    if (a.reachedUfc) reachedUfc += 1;
    const ctx = rank(a.fighter.id);
    if (ranked(ctx)) rankedN += 1;
    if (champion(ctx)) champions += 1;
    ufcFights += a.ufc.sinceDwcsFights;
    ufcWins += a.ufc.sinceDwcsWins;
  }
  return { fighters: alumni.length, reachedUfc, ranked: rankedN, champions, ufcFights, ufcWins };
}

export function paginate<T>(rows: T[], page: number, per: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * per, p * per), page: p, pages };
}
