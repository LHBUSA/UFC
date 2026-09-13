import { test } from "node:test";
import assert from "node:assert/strict";
import { alumniMetrics, filterAlumni, paginate, parseFilter, parseSeries, parseSort, sortAlumni } from "./dwcsAlumni.ts";
import { contenderIdentity } from "./contenderIdentity.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const bout = (date: string, outcome: string | null, extra: Any = {}) => ({
  boutId: `b-${date}`, event: { id: `e-${date}`, name: "x", eventDate: date }, opponentId: "o", fighterAId: "a",
  outcome, method: outcome ? "DEC_U" : null, round: 3, timeSec: 300, weightClass: "LIGHTWEIGHT", isWomens: false, isTitle: false, status: outcome ? "complete" : "announced", ...extra,
});
function alum(id: string, name: string, dwcsName: string, dwcsDate: string, ufc: Array<[string, string | null]>): Any {
  const app = { ...bout(dwcsDate, "W"), identity: contenderIdentity(dwcsName, dwcsDate) };
  const done = ufc.filter(([, o]) => o).map(([d, o]) => bout(d, o));
  const since = done.filter((b) => b.event.eventDate > dwcsDate);
  return {
    fighter: { id, name }, appearances: [app], dwcsW: 1, dwcsL: 0, firstDwcs: app, lastDwcs: app,
    ufc: { fights: done.length, w: done.filter((b) => b.outcome === "W").length, l: 0, d: 0, nc: 0, debut: done[0] || null, last: done.at(-1) || null, next: null, titleWins: 0, beforeDwcs: done.length - since.length, sinceDwcsFights: since.length, sinceDwcsWins: since.filter((b) => b.outcome === "W").length },
    reachedUfc: since.length > 0,
  };
}

const champ = alum("c", "Champ", "Dana White's Contender Series: Season 2, Week 1", "2018-06-12", [["2019-01-01", "W"], ["2026-03-01", "W"]]);
const ranked = alum("r", "Ranked", "Dana White's Contender Series: Season 5, Week 2", "2021-09-07", [["2022-01-01", "W"]]);
const never = alum("n", "Never", "Dana White's Contender Series: Brazil 2", "2018-08-12", []);
const vet = alum("v", "Veteran", "Dana White's Contender Series: Season 1, Week 1", "2017-07-11", [["2015-01-01", "L"], ["2018-02-01", "W"]]);
const all = [never, ranked, champ, vet];
const ctx = (champion: boolean) => ({ fighterId: "", snapshotDate: "2026-09-10", capturedAt: "", sourceUrl: "", divisionRanks: champion ? [] : [{ divisionKey: "LW", divisionLabel: "Lightweight", isWomens: false, rank: 3, change: null, isNew: false }], championships: champion ? [{ divisionKey: "LHW", divisionLabel: "Light Heavyweight", isWomens: false }] : [], p4p: [] });
const rank = (id: string) => (id === "c" ? ctx(true) : id === "r" ? ctx(false) : null);

test("metrics count canonical facts, and UFC totals only since DWCS", () => {
  const m = alumniMetrics(all as Any, rank as Any);
  assert.deepEqual(m, { fighters: 4, reachedUfc: 3, ranked: 2, champions: 1, ufcFights: 4, ufcWins: 4 });
});

test("filters: reached, ranked, champions, series (Brazil is not Season 2)", () => {
  const f = (filter: Any, series: Any = null) => filterAlumni(all as Any, { filter, series, rank: rank as Any }).map((a: Any) => a.fighter.id).sort();
  assert.deepEqual(f("ufc"), ["c", "r", "v"]);
  assert.deepEqual(f("ranked"), ["c", "r"]);
  assert.deepEqual(f("champions"), ["c"]);
  assert.deepEqual(f("all", parseSeries("2")), ["c"]);
  assert.deepEqual(f("all", parseSeries("brazil")), ["n"]);
});

test("contract filter only ever matches sourced claims", () => {
  assert.deepEqual(filterAlumni(all as Any, { filter: "contract", series: null, rank: rank as Any }), []);
  assert.deepEqual(filterAlumni(all as Any, { filter: "contract", series: null, rank: rank as Any, hasContractClaim: (id) => id === "r" }).map((a: Any) => a.fighter.id), ["r"]);
});

test("recent activity puts UFC activity first, newest first", () => {
  assert.deepEqual(sortAlumni(all as Any, "recent").map((a: Any) => a.fighter.id), ["c", "r", "v", "n"]);
  assert.deepEqual(sortAlumni(all as Any, "fights").map((a: Any) => a.fighter.id).slice(0, 2).sort(), ["c", "v"]);
});

test("params and pagination are clamped", () => {
  assert.equal(parseFilter("nope"), "all");
  assert.equal(parseSort("wins"), "wins");
  assert.equal(parseSeries("0"), null);
  const p = paginate([1, 2, 3, 4, 5], 9, 2);
  assert.deepEqual([p.page, p.pages, p.rows], [3, 3, [5]]);
});
