/* Ranking identity, derived from the official dated UFC snapshot — pure logic,
 * no I/O, so the rules can be tested without a network or a database.
 *
 * The product rule this exists to serve: if a fighter is currently ranked,
 * every surface that renders that fighter should know it. The failure mode it
 * exists to prevent is subtler — a fighter has more than one simultaneous
 * ranking identity (a champion who is also ranked pound-for-pound, a
 * contender ranked in a division AND P4P), so collapsing "rank" into one
 * number loses information and, worse, invites a P4P number to be shown where
 * a reader will read it as a division rank.
 *
 * Hence: no scalar rank anywhere. A fighter resolves to every context the
 * snapshot holds for them, and the CALLER states which division it is asking
 * about so the right one can be chosen.
 *
 * Division identity is (key, is_womens), never key alone: the snapshot
 * contains FLYWEIGHT twice (mens and womens) and P4P twice, so keying a map
 * by `key` silently merges two divisions.
 */
import type { RankingsSnapshot } from "@/lib/db";

export type DivisionRef = { divisionKey: string; divisionLabel: string; isWomens: boolean };
export type DivisionRank = DivisionRef & { rank: number; change: number | null; isNew: boolean };
export type P4PRank = DivisionRank;

export type FighterRankingContext = {
  fighterId: string;
  snapshotDate: string;
  capturedAt: string;
  sourceUrl: string;
  divisionRanks: DivisionRank[];
  championships: DivisionRef[];
  p4p: P4PRank[];
};

export type UnresolvedRanking = { name: string; divisionLabel: string; rank: number | null; kind: "entry" | "champion" };

export type RankingIndex = {
  snapshotDate: string;
  capturedAt: string;
  sourceUrl: string;
  byFighter: Map<string, FighterRankingContext>;
  /** Entries the ingest could not resolve to a canonical fighter. Reported, never guessed. */
  unresolved: UnresolvedRanking[];
};

const divRef = (d: { key: string; label: string; is_womens: boolean }): DivisionRef => ({
  divisionKey: d.key, divisionLabel: d.label, isWomens: d.is_womens,
});

/**
 * One pass over the snapshot, producing every fighter's complete ranking
 * identity. Built once per request and shared: 26 fighters on an event page
 * cost one snapshot read and 26 map lookups, never 26 queries.
 *
 * A ranking is only ever attached by canonical fighter_id. An entry the
 * rankings ingest could not resolve is collected in `unresolved` rather than
 * matched on display name, because two fighters share a name far more often
 * than a product expects and a wrong rank is worse than no rank.
 */
export function buildRankingIndex(snap: RankingsSnapshot | null): RankingIndex | null {
  if (!snap || !Array.isArray(snap.divisions)) return null;
  const byFighter = new Map<string, FighterRankingContext>();
  const unresolved: UnresolvedRanking[] = [];

  const ctxFor = (fighterId: string): FighterRankingContext => {
    let c = byFighter.get(fighterId);
    if (!c) {
      c = {
        fighterId, snapshotDate: snap.snapshot_date, capturedAt: snap.captured_at, sourceUrl: snap.source_url,
        divisionRanks: [], championships: [], p4p: [],
      };
      byFighter.set(fighterId, c);
    }
    return c;
  };

  for (const d of snap.divisions) {
    const ref = divRef(d);
    /* A champion is a distinct state, not rank zero. The snapshot keeps the
     * titleholder outside `entries`, and so does this. */
    if (d.champion) {
      if (d.champion.fighter_id) ctxFor(d.champion.fighter_id).championships.push(ref);
      else unresolved.push({ name: d.champion.name, divisionLabel: d.label, rank: null, kind: "champion" });
    }
    for (const e of d.entries || []) {
      if (!e.fighter_id) { unresolved.push({ name: e.name, divisionLabel: d.label, rank: e.rank, kind: "entry" }); continue; }
      const row: DivisionRank = { ...ref, rank: e.rank, change: e.change ?? null, isNew: Boolean(e.is_new) };
      if (d.is_p4p) ctxFor(e.fighter_id).p4p.push(row);
      else ctxFor(e.fighter_id).divisionRanks.push(row);
    }
  }
  return { snapshotDate: snap.snapshot_date, capturedAt: snap.captured_at, sourceUrl: snap.source_url, byFighter, unresolved };
}

/* ---- display selection -------------------------------------------------- */

export type RankKind = "champion" | "division" | "p4p";
export type RankDisplay = {
  kind: RankKind;
  /** "C" | "#4" | "#7 P4P" — safe anywhere, never ambiguous. */
  compact: string;
  /** "Lightweight Champion" | "#4 Lightweight" | "#7 Mens Pound-for-Pound". */
  full: string;
  divisionLabel: string;
  rank: number | null;
  change: number | null;
  isNew: boolean;
};

function championDisplay(ref: DivisionRef): RankDisplay {
  return { kind: "champion", compact: "C", full: `${ref.divisionLabel} Champion`, divisionLabel: ref.divisionLabel, rank: null, change: null, isNew: false };
}
function divisionDisplay(r: DivisionRank): RankDisplay {
  return { kind: "division", compact: `#${r.rank}`, full: `#${r.rank} ${r.divisionLabel}`, divisionLabel: r.divisionLabel, rank: r.rank, change: r.change, isNew: r.isNew };
}
/* P4P NEVER renders as a bare "#7". On a surface that implies a division
 * rank, an unlabelled P4P number is simply a wrong number. */
function p4pDisplay(r: P4PRank): RankDisplay {
  return { kind: "p4p", compact: `#${r.rank} P4P`, full: `#${r.rank} ${r.divisionLabel}`, divisionLabel: r.divisionLabel, rank: r.rank, change: r.change, isNew: r.isNew };
}

const sameDivision = (ref: DivisionRef, key: string | null, isWomens: boolean) =>
  Boolean(key) && ref.divisionKey === key && ref.isWomens === isWomens;

/**
 * What to show for a fighter on a bout-specific surface, in priority order:
 * champion of THIS bout's division, then their rank in THIS bout's division,
 * then P4P as clearly-labelled secondary context.
 *
 * The division argument matters. A welterweight champion fighting at
 * lightweight is not "C" in that bout, and showing it would misdescribe the
 * fight; asking the snapshot about the bout's own division is what keeps the
 * badge true to the thing the reader is looking at.
 */
export function rankForDivision(
  ctx: FighterRankingContext | undefined | null,
  division: { key: string | null; isWomens: boolean },
): { primary: RankDisplay | null; secondary: RankDisplay | null } {
  if (!ctx) return { primary: null, secondary: null };
  const champ = ctx.championships.find((c) => sameDivision(c, division.key, division.isWomens));
  const div = ctx.divisionRanks.find((r) => sameDivision(r, division.key, division.isWomens));
  const p4p = ctx.p4p[0] ? p4pDisplay(ctx.p4p[0]) : null;
  if (champ) return { primary: championDisplay(champ), secondary: p4p };
  if (div) return { primary: divisionDisplay(div), secondary: p4p };
  /* Not ranked in THIS division. A P4P standing is still true and still worth
   * showing — but only ever as "#7 P4P", never as a bare number that would
   * read as a division rank. */
  return { primary: null, secondary: p4p };
}

/**
 * The fighter's whole ranking identity, for surfaces with room for it
 * (profile, rankings page). Champion lines first, then division ranks, then
 * pound-for-pound.
 */
export function rankStack(ctx: FighterRankingContext | undefined | null): RankDisplay[] {
  if (!ctx) return [];
  return [
    ...ctx.championships.map(championDisplay),
    ...ctx.divisionRanks.map(divisionDisplay),
    ...ctx.p4p.map(p4pDisplay),
  ];
}

/**
 * The best single badge when no division context is available (a fighter
 * directory card, a search result). Champion, then best division rank, then
 * P4P — and still never a bare P4P number.
 */
export function bestRank(ctx: FighterRankingContext | undefined | null): RankDisplay | null {
  if (!ctx) return null;
  if (ctx.championships[0]) return championDisplay(ctx.championships[0]);
  const best = [...ctx.divisionRanks].sort((a, b) => a.rank - b.rank)[0];
  if (best) return divisionDisplay(best);
  return ctx.p4p[0] ? p4pDisplay(ctx.p4p[0]) : null;
}

export const isRanked = (ctx: FighterRankingContext | undefined | null): boolean =>
  Boolean(ctx && (ctx.championships.length || ctx.divisionRanks.length || ctx.p4p.length));
