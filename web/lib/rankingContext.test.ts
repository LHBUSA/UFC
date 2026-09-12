/* Ranking identity rules. Run: npm run test:rankings
 *
 * The claims worth pinning are the ones that would be wrong in a way nobody
 * notices: a pound-for-pound number shown where a reader expects a division
 * rank, a champion rendered as a number, a rank attached to the wrong
 * division because two divisions share a key, and an unranked fighter given
 * an empty badge that looks like missing data.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRankingIndex, rankForDivision, rankStack, bestRank, isRanked,
} from "./rankingContext.ts";

const CHAMP = "champ-id";
const CONTENDER = "contender-id";
const P4P_ONLY = "p4p-only-id";
const WOMENS = "womens-id";
const UNRANKED = "nobody-id";

/* Shaped exactly like the live snapshot, including the two traps it contains:
 * FLYWEIGHT exists twice (mens and womens) and P4P exists twice. */
const SNAP = {
  snapshot_date: "2026-09-10",
  captured_at: "2026-09-10T12:15:02.152Z",
  source_url: "https://www.ufc.com/rankings",
  divisions: [
    {
      key: "P4P", label: "Men's Pound-for-Pound", is_womens: false, is_p4p: true, champion: null,
      entries: [
        { rank: 1, name: "Champ Name", ufc_slug: null, fighter_id: CHAMP, change: 0, is_new: false },
        { rank: 5, name: "Contender Name", ufc_slug: null, fighter_id: CONTENDER, change: 2, is_new: false },
        { rank: 9, name: "P4P Only", ufc_slug: null, fighter_id: P4P_ONLY, change: null, is_new: true },
      ],
    },
    {
      key: "LIGHTWEIGHT", label: "Lightweight", is_womens: false, is_p4p: false,
      champion: { name: "Champ Name", ufc_slug: null, fighter_id: CHAMP },
      entries: [{ rank: 4, name: "Contender Name", ufc_slug: null, fighter_id: CONTENDER, change: -1, is_new: false }],
    },
    {
      key: "FLYWEIGHT", label: "Flyweight", is_womens: false, is_p4p: false,
      champion: { name: "Mens Fly Champ", ufc_slug: null, fighter_id: "mens-fly" },
      entries: [{ rank: 3, name: "Mens Fly Contender", ufc_slug: null, fighter_id: "mens-fly-3", change: 0, is_new: false }],
    },
    {
      key: "FLYWEIGHT", label: "Women's Flyweight", is_womens: true, is_p4p: false,
      champion: { name: "Unresolved Champ", ufc_slug: null, fighter_id: null },
      entries: [
        { rank: 3, name: "Womens Fly", ufc_slug: null, fighter_id: WOMENS, change: 0, is_new: false },
        { rank: 11, name: "Unresolved Entry", ufc_slug: null, fighter_id: null, change: null, is_new: false },
      ],
    },
  ],
} as never;

const index = buildRankingIndex(SNAP)!;
const ctx = (id: string) => index.byFighter.get(id);
const LW = { key: "LIGHTWEIGHT", isWomens: false };

test("a fighter keeps every simultaneous ranking identity", () => {
  const c = ctx(CHAMP)!;
  assert.equal(c.championships.length, 1);
  assert.equal(c.championships[0].divisionLabel, "Lightweight");
  assert.equal(c.p4p.length, 1);
  assert.equal(c.p4p[0].rank, 1);
  assert.equal(c.divisionRanks.length, 0, "a champion is not also listed among the ranked entries");
});

test("a champion is a state, never rank zero", () => {
  const { primary } = rankForDivision(ctx(CHAMP), LW);
  assert.equal(primary?.kind, "champion");
  assert.equal(primary?.compact, "C");
  assert.equal(primary?.full, "Lightweight Champion");
  assert.equal(primary?.rank, null);
  assert.ok(!/#\s*0/.test(primary!.compact + primary!.full));
});

test("P4P always carries its label and never renders as a bare number", () => {
  /* P4P-only fighter, asked about a division they are not ranked in. */
  const { primary, secondary } = rankForDivision(ctx(P4P_ONLY), LW);
  assert.equal(primary, null, "no division rank is claimed");
  assert.equal(secondary?.kind, "p4p");
  assert.equal(secondary?.compact, "#9 P4P");
  assert.ok(!/^#\d+$/.test(secondary!.compact), "a bare #9 would read as a division rank");
  /* And as the best single badge, still labelled. */
  assert.equal(bestRank(ctx(P4P_ONLY))?.compact, "#9 P4P");
});

test("division rank wins over P4P on a bout surface, P4P stays secondary", () => {
  const { primary, secondary } = rankForDivision(ctx(CONTENDER), LW);
  assert.equal(primary?.compact, "#4");
  assert.equal(primary?.full, "#4 Lightweight");
  assert.equal(secondary?.compact, "#5 P4P");
});

test("two divisions sharing a key are never merged", () => {
  /* FLYWEIGHT exists for both mens and womens. Keying on the string alone
   * would give the womens fighter the mens champion's division. */
  const w = rankForDivision(ctx(WOMENS), { key: "FLYWEIGHT", isWomens: true });
  assert.equal(w.primary?.compact, "#3");
  assert.equal(w.primary?.divisionLabel, "Women's Flyweight");
  const wrongSide = rankForDivision(ctx(WOMENS), { key: "FLYWEIGHT", isWomens: false });
  assert.equal(wrongSide.primary, null, "a womens ranking never answers for the mens division");
  assert.equal(ctx("mens-fly")!.championships[0].divisionLabel, "Flyweight");
});

test("a champion fighting outside their division is not shown as champion there", () => {
  /* The welterweight-champion-at-lightweight case: the badge must describe
   * the bout in front of the reader, not the fighter's best credential. */
  const { primary, secondary } = rankForDivision(ctx(CHAMP), { key: "FLYWEIGHT", isWomens: false });
  assert.equal(primary, null);
  assert.equal(secondary?.compact, "#1 P4P", "their true P4P standing still shows, labelled");
});

test("an unranked fighter produces nothing at all", () => {
  assert.equal(isRanked(ctx(UNRANKED)), false);
  assert.equal(bestRank(ctx(UNRANKED)), null);
  assert.deepEqual(rankStack(ctx(UNRANKED)), []);
  const { primary, secondary } = rankForDivision(ctx(UNRANKED), LW);
  assert.equal(primary, null);
  assert.equal(secondary, null);
});

test("an unresolved ranking identity is reported, never attached by name", () => {
  assert.equal(index.unresolved.length, 2);
  const kinds = index.unresolved.map((u) => u.kind).sort();
  assert.deepEqual(kinds, ["champion", "entry"]);
  /* Crucially, no context was invented for them. */
  assert.equal(index.byFighter.size, 6);
  for (const c of index.byFighter.values()) assert.ok(c.fighterId, "every context is keyed by a real fighter id");
});

test("the profile stack shows every identity with provenance", () => {
  const rows = rankStack(ctx(CHAMP));
  assert.deepEqual(rows.map((r) => r.kind), ["champion", "p4p"]);
  assert.equal(rows[0].full, "Lightweight Champion");
  assert.equal(rows[1].full, "#1 Men's Pound-for-Pound");
  assert.equal(ctx(CHAMP)!.snapshotDate, "2026-09-10");
  assert.equal(ctx(CHAMP)!.sourceUrl, "https://www.ufc.com/rankings");
});

test("movement is carried through, including a new entry", () => {
  assert.equal(ctx(CONTENDER)!.divisionRanks[0].change, -1);
  assert.equal(ctx(P4P_ONLY)!.p4p[0].isNew, true);
  assert.equal(ctx(P4P_ONLY)!.p4p[0].change, null);
});

test("a missing snapshot fails closed", () => {
  assert.equal(buildRankingIndex(null), null);
  assert.equal(buildRankingIndex({ divisions: null } as never), null);
  /* And every accessor tolerates the resulting absence. */
  assert.equal(bestRank(undefined), null);
  assert.equal(isRanked(undefined), false);
  assert.deepEqual(rankForDivision(undefined, LW), { primary: null, secondary: null });
});

test("a bout with no weight class never matches a division", () => {
  const { primary } = rankForDivision(ctx(CONTENDER), { key: null, isWomens: false });
  assert.equal(primary, null, "an unknown division must not fall through to the first ranking");
});
