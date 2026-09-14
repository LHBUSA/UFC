/* Search snippet copy. Run: npm run test:seo
 *
 * The claims worth pinning: a null fact never produces a clause, nothing
 * exceeds the description budget, strikes read in the same order as the
 * sentence that precedes them, and a UTM strip never touches a functional
 * query parameter. */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DESCRIPTION_MAX, fitParts, shortEventName, fightResultSentence, fightResultDescription,
  eventResultsDescription, fighterDescription, fighterTitle, newsSearchTitle, stripUtm,
  type FightSeoFacts,
} from "./seo.ts";

const ian: FightSeoFacts = {
  a: "Ian McCall", b: "Iliarde Santos", winner: "Ian McCall", loser: "Iliarde Santos",
  methodCode: "DEC_U", methodLabel: "Unanimous Decision", finishDetail: null, round: 3, time: "5:00",
  event: "UFC 163: Aldo vs Jung", date: "Aug 3, 2013", referee: "Mario Yamasaki",
  sigStrikes: { a: 92, b: 43 }, scorecards: ["30–27", "30–27", "29–28"], roundStats: true, fightDna: true,
};

test("fitParts keeps the anchor and skips clauses that do not fit", () => {
  assert.equal(fitParts(["a".repeat(150), "too long clause", "ok"], 160), `${"a".repeat(150)} ok`);
  assert.equal(fitParts([null, "", "anchor"]), "anchor");
  assert.equal(fitParts([]), "");
});

test("shortEventName only shortens unambiguous event names", () => {
  assert.equal(shortEventName("UFC 163: Aldo vs Jung"), "UFC 163");
  assert.equal(shortEventName("Dana White's Contender Series: Season 10, Week 5"), "DWCS Season 10, Week 5");
  assert.equal(shortEventName("UFC Fight Night: Oezdemir vs. Smith"), "UFC Fight Night: Oezdemir vs. Smith");
  assert.equal(shortEventName("UFC on FUEL TV: Munoz vs Weidman"), "UFC on FUEL TV: Munoz vs Weidman");
});

test("a decision states winner, method, event and date without a round clause", () => {
  assert.equal(fightResultSentence(ian), "Ian McCall defeated Iliarde Santos by unanimous decision at UFC 163 (Aug 3, 2013).");
});

test("the full description carries referee, scorecards and strikes within budget", () => {
  const d = fightResultDescription(ian);
  assert.ok(d.length <= DESCRIPTION_MAX, `${d.length}: ${d}`);
  assert.match(d, /Referee: Mario Yamasaki\./);
  assert.match(d, /Scorecards 30–27, 30–27, 29–28\./);
  assert.match(d, /Sig. strikes 92–43\./);
});

test("null facts produce no clause at all", () => {
  const bare: FightSeoFacts = { ...ian, referee: null, sigStrikes: null, scorecards: [], roundStats: false, fightDna: false };
  const d = fightResultDescription(bare);
  assert.equal(d, "Ian McCall defeated Iliarde Santos by unanimous decision at UFC 163 (Aug 3, 2013).");
  assert.doesNotMatch(d, /Referee|Scorecards|strikes|Fight DNA|round-by-round/);
});

test("a finish names the round and time; strikes read winner-first", () => {
  const ko: FightSeoFacts = {
    ...ian, winner: "Iliarde Santos", loser: "Ian McCall", methodCode: "KO_TKO", methodLabel: "KO/TKO",
    round: 2, time: "3:14", scorecards: [], referee: null, roundStats: false, fightDna: false,
  };
  const d = fightResultDescription(ko);
  assert.match(d, /^Iliarde Santos defeated Ian McCall by KO\/TKO in round 2 \(3:14\) at UFC 163/);
  assert.match(d, /Sig. strikes 43–92\./);
});

test("draws and no contests never name a winner", () => {
  assert.equal(
    fightResultSentence({ ...ian, winner: null, loser: null, methodCode: "DRAW", methodLabel: "Draw" }),
    "Ian McCall and Iliarde Santos fought to a draw at UFC 163 (Aug 3, 2013).",
  );
  assert.equal(
    fightResultSentence({ ...ian, winner: null, loser: null, methodCode: "NC", methodLabel: "No Contest", date: null }),
    "Ian McCall vs Iliarde Santos at UFC 163 ended in a no contest.",
  );
});

test("long Fight Night names stay within budget", () => {
  const d = fightResultDescription({
    ...ian, a: "Raphael Assuncao", b: "Issei Tamura", winner: "Raphael Assuncao", loser: "Issei Tamura",
    event: "UFC on FUEL TV: Munoz vs Weidman", date: "Jul 11, 2012", referee: "Herb Dean",
  });
  assert.ok(d.length <= DESCRIPTION_MAX, `${d.length}: ${d}`);
  assert.match(d, /^Raphael Assuncao defeated Issei Tamura by unanimous decision at UFC on FUEL TV: Munoz vs Weidman \(Jul 11, 2012\)\. Referee: Herb Dean\./);
});

test("event results description stays within budget and omits absent parts", () => {
  const d = eventResultsDescription({
    name: "Dana White's Contender Series: Season 10, Week 5", date: "Sep 8, 2026", where: "Meta APEX, Las Vegas",
    bouts: 5, finishes: 3, decisions: 2, titleFights: 0, mainResult: null, roundStats: true,
  });
  assert.ok(d.length <= DESCRIPTION_MAX, `${d.length}: ${d}`);
  assert.match(d, /5 bouts: 3 finishes, 2 decisions\./);
  assert.doesNotMatch(d, /title/);
});

test("fighter title only promises a next fight when one is scheduled", () => {
  assert.equal(fighterTitle("Ian McCall", "Uncle Creepy", false), "Ian McCall “Uncle Creepy” — UFC Record, Stats & Fight History");
  assert.equal(fighterTitle("Jean Silva", null, true), "Jean Silva — UFC Record, Stats & Next Fight");
});

test("fighter description uses archive facts and never invents a next bout", () => {
  const d = fighterDescription({
    name: "Ian McCall", record: "13-5-1", archive: { fights: 7, w: 2, l: 3, d: 1, ko: 0, sub: 1, dec: 1 },
    sigLanded: 312, statRounds: 18, fightDna: true, next: null,
  });
  assert.ok(d.length <= DESCRIPTION_MAX, `${d.length}: ${d}`);
  assert.match(d, /^Ian McCall UFC record and stats: 13-5-1 pro record\./);
  assert.doesNotMatch(d, /Next/);
  const n = fighterDescription({ name: "Jean Silva", record: "16-2-0", archive: null, sigLanded: null, statRounds: 0, fightDna: false, next: { opponent: "Jose Delgado", event: "UFC 331: Van vs. Pantoja 2", date: "Sep 19, 2026" } });
  assert.match(n, /Next: vs Jose Delgado at UFC 331 \(Sep 19, 2026\)\./);
  assert.doesNotMatch(n, /round stats|Fight DNA/);
});

test("template preview headlines get a search title naming the sections present", () => {
  const h = "Norma Dumont vs. Ailin Perez: women's bantamweight prelim preview at UFC Fight Night: Rosas Jr. vs. Barcelos";
  const t = newsSearchTitle(h, ["The setup", "Tale of the tape", "Recent form", "Style and statistical matchup", "Final read"]);
  assert.equal(t.title, "Norma Dumont vs. Ailin Perez Preview: Tale of the Tape, Recent Form & Stats Matchup");
  const noStats = newsSearchTitle("Mehemmedeli Osmanli vs. Ilimbek Akylbek Uulu: bantamweight main card preview at UFC Fight Night: Rosas Jr. vs. Barcelos", ["The setup", "Tale of the tape", "Recent form"]);
  assert.equal(noStats.title, "Mehemmedeli Osmanli vs. Ilimbek Akylbek Uulu Preview: Tale of the Tape & Recent Form");
});

test("editorial headlines are never rewritten, only lose the suffix when too long", () => {
  const h = "Conor McGregor’s ACL Surgery Forces Bettors to Reset the Baseline";
  assert.deepEqual(newsSearchTitle(h, []), { title: h, absolute: true });
  assert.deepEqual(newsSearchTitle("Song holds No. 3", []), { title: "Song holds No. 3", absolute: false });
  /* A template headline whose article lacks the sections keeps its headline. */
  const t = "JJ Aldrich vs. Regina Tarin: women's flyweight prelim preview at Noche UFC";
  assert.equal(newsSearchTitle(t, ["Something else"]).title, t);
});

test("stripUtm removes only utm_* keys", () => {
  assert.equal(stripUtm("?utm_source=propbetedge&utm_medium=fight_week_rail&utm_campaign=ufc_fight_week"), "");
  assert.equal(stripUtm("?season=10&utm_source=x"), "?season=10");
  assert.equal(stripUtm("?q=jones&tab=history"), null);
  assert.equal(stripUtm(""), null);
});
