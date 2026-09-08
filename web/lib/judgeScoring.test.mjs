/* Judge scorecard attribution. Run: npm run test:judges
 *
 * The claims worth pinning are the ones a reader would be misled by if they
 * broke: that a score pair is never attributed to a fighter unless the bout's
 * own cards say which way round it is; that a finish shows as an absence and
 * not as a blank card; that a dissent is counted against the resolved cards
 * and not the whole sample; and that a small sample is refused a rate.
 *
 * The alias parity test exists because the same alias list lives in two
 * places by design — the runtime module and the migration — and a list that
 * can drift silently will. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const J = await import("./judgeScoring.ts");

const A = "fighter-a";
const B = "fighter-b";
const card = (judge, score) => ({ judge, score });

/* ---- slug -------------------------------------------------------------- */

test("judgeSlug mirrors the SQL slug expression, apostrophes included", () => {
  assert.equal(J.judgeSlug("Sal D'amato"), "sal-d-amato");
  assert.equal(J.judgeSlug("Patricia Morse-Jarman"), "patricia-morse-jarman");
  assert.equal(J.judgeSlug("  Chris Lee  "), "chris-lee");
  assert.equal(J.judgeSlug(""), "");
});

/* ---- identity ---------------------------------------------------------- */

test("a point-deduction annotation resolves to the official and keeps the note", () => {
  const r = J.resolveJudge("Low Blow by Blanco Richard Bertrand");
  assert.equal(r.name, "Richard Bertrand");
  assert.equal(r.cardNote, "Low Blow by Blanco");
  assert.equal(r.rawName, "Low Blow by Blanco Richard Bertrand");
});

test("a spelling variant resolves without inventing a note", () => {
  const r = J.resolveJudge("Mamunah Querido");
  assert.equal(r.name, "Maimunah Querido");
  assert.equal(r.cardNote, null);
});

test("an unaliased judge passes through untouched", () => {
  assert.equal(J.resolveJudge("  Derek Cleary ").name, "Derek Cleary");
  assert.equal(J.resolveJudge("Derek Cleary").cardNote, null);
});

test("Chris Lee and Chris Leben stay separate identities", () => {
  /* Near-identical names, two real officials. Nothing may merge them. */
  assert.equal(J.resolveJudge("Chris Leben").name, "Chris Leben");
  assert.notEqual(J.judgeSlug("Chris Leben"), J.judgeSlug("Chris Lee"));
});

/* ---- score parsing ----------------------------------------------------- */

test("parseScore reads both spaced and unspaced pairs, and refuses non-scores", () => {
  assert.deepEqual(J.parseScore("29-28"), { first: 29, second: 28 });
  assert.deepEqual(J.parseScore("47 - 47"), { first: 47, second: 47 });
  assert.equal(J.parseScore("Time Expired"), null);
  assert.equal(J.parseScore(null), null);
});

/* ---- orientation ------------------------------------------------------- */

test("orientation follows the winning cards, not the position", () => {
  /* Two bouts, identical score strings, opposite fighter order. Reading
   * position 1 as "fighter A" would invert one of them. */
  assert.equal(J.deriveWinnerPosition([{ first: 27, second: 30 }, { first: 27, second: 30 }, { first: 28, second: 29 }], true), 2);
  assert.equal(J.deriveWinnerPosition([{ first: 30, second: 27 }, { first: 30, second: 27 }, { first: 29, second: 28 }], true), 1);
});

test("orientation is refused where the evidence cannot decide", () => {
  assert.equal(J.deriveWinnerPosition([{ first: 29, second: 28 }, { first: 28, second: 29 }, { first: 29, second: 29 }], true), null, "1-1 tally");
  assert.equal(J.deriveWinnerPosition([{ first: 28, second: 29 }], false), null, "no winner");
  assert.equal(J.deriveWinnerPosition([], true), null, "no cards");
});

/* ---- bout scorecards --------------------------------------------------- */

test("a finish carries no scorecard and says so explicitly", () => {
  const s = J.buildBoutScorecard({ method: "KO_TKO", scorecards: null, winnerId: A, fighterAId: A, fighterBId: B });
  assert.equal(s.hasOfficialScorecard, false);
  assert.equal(s.wentToTheJudges, false);
  assert.equal(s.cardCount, 0);
  assert.deepEqual(s.cards, []);
  assert.equal(s.fighterATotal, null, "no zero-score card may be manufactured for a stoppage");
  assert.equal(s.fighterBTotal, null);
});

test("submissions and DQs are finishes too", () => {
  for (const m of ["SUB", "DQ", "NC"]) {
    const s = J.buildBoutScorecard({ method: m, scorecards: [], winnerId: A, fighterAId: A, fighterBId: B });
    assert.equal(s.hasOfficialScorecard, false, m);
    assert.equal(s.wentToTheJudges, false, m);
  }
});

test("a unanimous decision attributes every card to the winner", () => {
  const s = J.buildBoutScorecard({
    method: "DEC_U",
    scorecards: [card("Sal D'amato", "27-30"), card("Derek Cleary", "27-30"), card("Chris Lee", "28-29")],
    winnerId: A, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.decisionType, "unanimous");
  assert.equal(s.cardCount, 3);
  assert.equal(s.dissentCards, 0);
  assert.deepEqual(s.cards.map((c) => c.fighterAScore), [30, 30, 29]);
  assert.deepEqual(s.cards.map((c) => c.fighterBScore), [27, 27, 28]);
  assert.ok(s.cards.every((c) => c.favoredFighterId === A));
  assert.equal(s.fighterATotal, 89);
  assert.equal(s.fighterBTotal, 82);
  assert.equal(s.cardShapeMatchesMethod, true);
});

test("attribution flips with fighter order, not with score position", () => {
  const s = J.buildBoutScorecard({
    method: "DEC_U",
    scorecards: [card("Sal D'amato", "27-30"), card("Derek Cleary", "27-30"), card("Chris Lee", "28-29")],
    winnerId: B, fighterAId: A, fighterBId: B,
  });
  assert.deepEqual(s.cards.map((c) => c.fighterBScore), [30, 30, 29]);
  assert.deepEqual(s.cards.map((c) => c.fighterAScore), [27, 27, 28]);
  assert.ok(s.cards.every((c) => c.favoredFighterId === B));
});

test("a split decision names its dissenting judge", () => {
  const s = J.buildBoutScorecard({
    method: "DEC_S",
    scorecards: [card("Mike Bell", "28-29"), card("Ron McCarthy", "29-28"), card("Sal D'amato", "28-29")],
    winnerId: B, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.decisionType, "split");
  assert.equal(s.dissentCards, 1);
  assert.deepEqual(s.dissentingJudges, ["Ron McCarthy"]);
  assert.equal(s.cards[1].favoredFighterId, A);
  assert.equal(s.cards[1].isDissent, true);
  assert.equal(s.cards[0].isDissent, false);
  assert.equal(s.cardShapeMatchesMethod, true);
});

test("a majority decision has an even card and no dissent", () => {
  const s = J.buildBoutScorecard({
    method: "DEC_M",
    scorecards: [card("Ben Cartlidge", "46-48"), card("Derek Cleary", "46-48"), card("Clemens Werner", "47-47")],
    winnerId: A, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.decisionType, "majority");
  assert.equal(s.evenCards, 1);
  assert.equal(s.dissentCards, 0);
  assert.equal(s.cards[2].favoredFighterId, null, "an even card favours neither fighter");
  assert.equal(s.cards[2].isDissent, false);
  assert.equal(s.cardShapeMatchesMethod, true);
});

test("a draw is never attributed, because there is no winner to orient on", () => {
  const s = J.buildBoutScorecard({
    method: "DRAW",
    scorecards: [card("Chris Lee", "28-28"), card("Mike Bell", "28-28"), card("Sal D'amato", "29-28")],
    winnerId: null, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.decisionType, "draw");
  assert.equal(s.drawType, "majority_draw");
  assert.equal(s.orientationBasis, "unresolved_no_winner");
  assert.ok(s.cards.every((c) => c.fighterAScore === null && c.fighterBScore === null));
  assert.ok(s.cards.every((c) => c.favoredFighterId === null));
  assert.ok(s.cards.every((c) => c.isDissent === null));
  assert.equal(s.fighterATotal, null);
  assert.equal(s.cards[0].scoreFirst, 28, "the raw pair is still shown");
  assert.equal(s.cards[2].rawScore, "29-28");
});

test("draw shapes are distinguished", () => {
  const draw = (cards) => J.buildBoutScorecard({ method: "DRAW", scorecards: cards, winnerId: null, fighterAId: A, fighterBId: B }).drawType;
  assert.equal(draw([card("a", "28-28"), card("b", "28-28"), card("c", "28-28")]), "unanimous_draw");
  assert.equal(draw([card("a", "29-28"), card("b", "28-29"), card("c", "28-28")]), "majority_draw");
  assert.equal(draw([card("a", "29-28"), card("b", "28-29"), card("c", "30-27")]), "split_draw");
});

test("a card tally that contradicts the recorded winner refuses attribution", () => {
  /* Chris Cariaso vs Louis Smolka, UFC Fight Night 2014-05-10: recorded as a
   * split decision but the stored cards are one each and one even, so no
   * position holds a majority. Showing a fighter-attributed 29 there would be
   * a guess. */
  const s = J.buildBoutScorecard({
    method: "DEC_S",
    scorecards: [card("Chris Lee", "29-29"), card("Sal D'amato", "29-28"), card("Cardo Urso", "28-29")],
    winnerId: A, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.orientationBasis, "unresolved_conflicting_cards");
  assert.ok(s.cards.every((c) => c.fighterAScore === null));
  assert.equal(s.cardShapeMatchesMethod, null, "shape cannot be judged without orientation");
  assert.equal(s.hasOfficialScorecard, true, "the cards still exist and must still be shown");
});

test("a card shape that disagrees with the method is flagged, not smoothed", () => {
  /* Trinaldo vs Parke, 2015-05-30: stored as unanimous, cards read 2-1. */
  const s = J.buildBoutScorecard({
    method: "DEC_U",
    scorecards: [card("Felipe Frank", "28-29"), card("Chris Lee", "29-28"), card("Rick Winter", "28-29")],
    winnerId: A, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.cardShapeMatchesMethod, false);
  assert.equal(s.dissentCards, 1);
});

test("a partial panel is preserved rather than padded to three", () => {
  const s = J.buildBoutScorecard({
    method: "DEC_U", scorecards: [card("Mike Bell", "27-30"), card("Derek Cleary", "27-30")],
    winnerId: A, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.cardCount, 2);
  assert.equal(s.cardShapeMatchesMethod, null, "a two-card panel is not a three-card shape to check");
  assert.equal(s.fighterATotal, 60, "totals cover the cards we hold, not an assumed third");
});

test("an unparsable or unnamed card is dropped, not rendered as a zero", () => {
  const s = J.buildBoutScorecard({
    method: "DEC_U", scorecards: [card("Mike Bell", "27-30"), card("Derek Cleary", null), card("", "27-30")],
    winnerId: A, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.cardCount, 1);
  assert.equal(s.cards[0].judge, "Mike Bell");
});

test("a deduction annotation on a card survives into the rendered card", () => {
  const s = J.buildBoutScorecard({
    method: "DEC_U",
    scorecards: [card("Low Blow by Watson Richard Bertrand", "27-30"), card("Derek Cleary", "27-30"), card("Chris Lee", "27-30")],
    winnerId: A, fighterAId: A, fighterBId: B,
  });
  assert.equal(s.cards[0].judge, "Richard Bertrand");
  assert.equal(s.cards[0].cardNote, "Low Blow by Watson");
  assert.equal(s.cards[0].judgeSlug, "richard-bertrand");
});

/* ---- gap classification ------------------------------------------------ */

const gap = (over) => J.classifyGap({
  method: "DEC_U", resultSource: "ufcstats", finishDetail: null, boutUfcstatsId: null,
  eventUfcstatsId: null, eventHasIngestedSiblings: false, eventName: "UFC 1", ...over,
});

test("gaps are classified from row evidence", () => {
  assert.deepEqual(gap({ finishDetail: "Time Expired", method: "DRAW" }),
    { classification: "non_standard", reason: "tournament_era_time_expired_no_decision" });
  assert.deepEqual(gap({ finishDetail: "27 - 30. 27 - 30. 28 - 29." }),
    { classification: "recoverable", reason: "scores_present_judges_unnamed_upstream" });
  assert.deepEqual(gap({ resultSource: "espn", boutUfcstatsId: "abc123" }),
    { classification: "recoverable", reason: "ufcstats_fight_page_identified" });
  assert.deepEqual(gap({ resultSource: "espn", eventUfcstatsId: "ev1", eventHasIngestedSiblings: true }),
    { classification: "identity_mismatch", reason: "espn_row_unmatched_at_ingested_event" });
  assert.deepEqual(gap({ resultSource: "espn", eventName: "Dana White's Contender Series 2024: Week 3" }),
    { classification: "source_unavailable", reason: "event_series_not_covered_by_source" });
  assert.deepEqual(gap({ eventName: "UFC 12: Judgement Day" }),
    { classification: "source_unavailable", reason: "no_scorecard_recorded_upstream" });
});

test("an unmatched ESPN row at an event we never ingested is not an identity mismatch", () => {
  assert.equal(gap({ resultSource: "espn", eventUfcstatsId: null, eventHasIngestedSiblings: false }).classification, "source_unavailable");
});

/* ---- statistics -------------------------------------------------------- */

test("the Wilson interval does not collapse at the extremes", () => {
  const zero = J.wilsonInterval(0, 20);
  assert.equal(zero.low, 0);
  assert.ok(zero.high > 0.1, "0 of 20 is not proof of 0%");
  const all = J.wilsonInterval(20, 20);
  assert.ok(all.low < 1, "20 of 20 is not proof of 100%");
  assert.ok(all.high > 0.999, "the upper bound reaches 1 up to floating-point slack");
  assert.equal(J.wilsonInterval(1, 0), null);
});

test("a small sample is refused a rate", () => {
  const r = J.dissentRead({ displayName: "Test Judge", dissents: 3, attributed: 9, archiveDissents: 800, archiveAttributed: 11900 });
  assert.equal(r.verdict, "sample_too_small");
  assert.match(r.body, /9 orientation-resolved cards/);
  assert.doesNotMatch(r.body, /33/, "no rate may be quoted below the sample floor");
});

test("a sample near the baseline is not called an outlier", () => {
  const r = J.dissentRead({ displayName: "Test Judge", dissents: 7, attributed: 100, archiveDissents: 800, archiveAttributed: 11900 });
  assert.equal(r.verdict, "not_distinguishable");
  assert.match(r.headline, /In line with the archive/);
});

test("a genuine outlier is named, and only as a difference from the result", () => {
  const r = J.dissentRead({ displayName: "Test Judge", dissents: 40, attributed: 200, archiveDissents: 800, archiveAttributed: 11900 });
  assert.equal(r.verdict, "above_baseline");
  assert.match(r.body, /says nothing about which card was correct/);
  assert.doesNotMatch(r.body, /favour[s]? (?:strikers|grapplers|aggression)/i);
});

test("the significance gate needs the sample floor as well as the test", () => {
  /* 10 of 20 is wildly above a 6.7% baseline, but 20 cards cannot carry it. */
  const r = J.dissentRead({ displayName: "Test Judge", dissents: 10, attributed: 20, archiveDissents: 800, archiveAttributed: 11900 });
  assert.equal(r.verdict, "sample_too_small");
});

/* ---- alias parity with the migration ----------------------------------- */

test("every runtime alias is seeded by the migration, with the same canonical name", () => {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const sql = readFileSync(join(root, "supabase", "migrations", "20260908000012_ufc_judge_intelligence.sql"), "utf8");
  const rows = [...sql.matchAll(/^\s*\('((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'(spelling_variant|deduction_annotation)'/gm)]
    .map((m) => ({ raw: m[1].replace(/''/g, "'"), canonical: m[2].replace(/''/g, "'"), kind: m[3] }));
  assert.ok(rows.length > 0, "migration alias seed not found");
  const bySql = new Map(rows.map((r) => [r.raw, r]));
  const entries = Object.entries(J.JUDGE_ALIASES);
  assert.equal(entries.length, rows.length, "alias counts differ between judgeScoring.ts and the migration");
  for (const [raw, alias] of entries) {
    const hit = bySql.get(raw);
    assert.ok(hit, `migration is missing alias ${raw}`);
    assert.equal(hit.canonical, alias.canonical, `canonical name differs for ${raw}`);
    assert.equal(hit.kind, alias.kind, `alias kind differs for ${raw}`);
  }
});

test("no alias points at another alias, and none is a self-reference", () => {
  for (const [raw, alias] of Object.entries(J.JUDGE_ALIASES)) {
    assert.notEqual(alias.canonical, raw, `${raw} maps to itself`);
    assert.ok(!J.JUDGE_ALIASES[alias.canonical], `${raw} resolves to another alias (${alias.canonical})`);
  }
});

/* ---- identity evidence: an unconfirmed name never becomes canonical ----- */

test("every spelling_variant merge carries external, re-checkable evidence", () => {
  /* The rule that stops the next plausible near-name from being merged on a
     resemblance. A deduction_annotation is a parsing artefact and needs no
     source; merging two NAMES combines two officials' records and does. */
  const variants = Object.entries(J.JUDGE_ALIASES).filter(([, a]) => a.kind === "spelling_variant");
  for (const [raw, alias] of variants) {
    const ev = J.SPELLING_VARIANT_EVIDENCE.find((e) => e.rawName === raw);
    assert.ok(ev, `spelling_variant ${raw} has no entry in SPELLING_VARIANT_EVIDENCE`);
    assert.equal(ev.canonical, alias.canonical, `evidence for ${raw} names a different canonical`);
    assert.match(ev.sourceUrl, /^https?:\/\/\S+$/, `evidence for ${raw} has no usable source URL`);
    assert.ok(ev.sourceName && ev.method, `evidence for ${raw} does not say what was checked`);
    assert.ok(ev.crossMatchedEvents.length >= 2, `evidence for ${raw} cites fewer than two cross-matched assignments`);
    assert.ok(ev.verifiedAt, `evidence for ${raw} has no verification date`);
  }
  assert.equal(J.SPELLING_VARIANT_EVIDENCE.length, variants.length, "evidence exists for a merge that is not applied");
});

test("a provisional candidate is never merged, in either direction", () => {
  for (const c of J.PROVISIONAL_IDENTITY_CANDIDATES) {
    for (const name of c.names) {
      assert.ok(!J.JUDGE_ALIASES[name], `${name} is a provisional candidate but appears as an alias key`);
      const asTarget = Object.entries(J.JUDGE_ALIASES).find(([, a]) => a.canonical === name);
      assert.ok(!asTarget, `${name} is a provisional candidate but is the canonical target of ${asTarget?.[0]}`);
      assert.equal(J.resolveJudge(name).name, name, `${name} does not resolve to itself`);
    }
    const [a, b] = c.names;
    assert.notEqual(J.judgeSlug(a), J.judgeSlug(b), `${a} and ${b} collide on one profile URL`);
  }
});

test("Richie Gerrard resolves to Ritchie Gerard, in that direction only", () => {
  /* This pair has been wrong in both available ways: first merged the other
     way round on archive resemblance, then split while unsourced. It is now
     merged on MMA Decisions judge 606, whose five decisions are exactly the
     union of the two spellings — and the registry's spelling is the MINORITY
     archive form, so a regression toward "whichever name appears more often"
     would silently flip the canonical name back. */
  assert.equal(J.resolveJudge("Richie Gerrard").name, "Ritchie Gerard");
  assert.equal(J.resolveJudge("Ritchie Gerard").name, "Ritchie Gerard", "the canonical name must not itself be aliased away");
  assert.ok(!J.JUDGE_ALIASES["Ritchie Gerard"], "canonical direction is reversed");
  const ev = J.SPELLING_VARIANT_EVIDENCE.find((e) => e.rawName === "Richie Gerrard");
  assert.ok(ev, "the merge exists with no evidence entry");
  assert.equal(ev.canonical, "Ritchie Gerard");
  assert.equal(ev.sourceUrl, "https://mmadecisions.com/judge/606/Ritchie-Gerard");
  assert.equal(ev.crossMatchedEvents.length, 5, "all five registry decisions must be accounted for");
  assert.ok(J.PROVISIONAL_IDENTITY_CANDIDATES.every((c) => !c.names.includes("Richie Gerrard")),
    "a merged pair must not still be listed as awaiting review");
});

test("a merged pair pools onto one record, and only because it is sourced", () => {
  const bout = (judge, winner) => J.buildBoutScorecard({
    method: "DEC_U",
    scorecards: [card(judge, "27-30"), card("Mike Bell", "27-30"), card("Sal D'amato", "27-30")],
    winnerId: winner, fighterAId: A, fighterBId: B,
  });
  const bySlug = new Map();
  for (const [judge, winner] of [["Ritchie Gerard", A], ["Richie Gerrard", B]]) {
    for (const c of bout(judge, winner).cards) bySlug.set(c.judgeSlug, (bySlug.get(c.judgeSlug) || 0) + 1);
  }
  assert.equal(bySlug.get("ritchie-gerard"), 2, "both spellings must land on the canonical record");
  assert.equal(bySlug.get("richie-gerrard"), undefined, "the alias must not keep a record of its own");
});

test("an unconfirmed near-name never combines samples", () => {
  /* The behavioural form of the rule, and it must not depend on any pair
     currently sitting in the review list — that list is empty in the steady
     state. Chris Lee and Chris Leben are the real case: two working officials
     whose names are one token apart, both present in the archive, neither
     aliased. If resemblance ever started driving identity, this is where it
     would show up first. */
  const bout = (judge, winner) => J.buildBoutScorecard({
    method: "DEC_U",
    scorecards: [card(judge, "27-30"), card("Mike Bell", "27-30"), card("Sal D'amato", "27-30")],
    winnerId: winner, fighterAId: A, fighterBId: B,
  });
  const bySlug = new Map();
  for (const [judge, winner] of [["Chris Lee", A], ["Chris Leben", B], ["Chris Le", A]]) {
    for (const c of bout(judge, winner).cards) bySlug.set(c.judgeSlug, (bySlug.get(c.judgeSlug) || 0) + 1);
  }
  assert.equal(bySlug.get("chris-lee"), 1, "Chris Lee's card did not stay on his own record");
  assert.equal(bySlug.get("chris-leben"), 1, "Chris Leben's card did not stay on his own record");
  assert.equal(bySlug.get("chris-le"), 1, "an unseen near-name was folded into an existing judge");
  assert.equal(bySlug.get("mike-bell"), 3, "a judge who really did work all three bouts should accumulate");
  assert.equal(bySlug.size, 5, "expected five distinct judges across the three bouts");
});

test("only names with evidence are merged; every other name resolves to itself", () => {
  /* The general invariant behind the two tests above: resolveJudge merges
     exactly the alias table and nothing else, so no amount of similarity can
     pool two records without an entry — and no spelling_variant entry can
     exist without a source, per the evidence test above. */
  for (const name of ["Chris Lee", "Chris Leben", "Ritchie Gerard", "Maimunah Querido", "Derek Cleary", "Richard Bertrand"]) {
    if (J.JUDGE_ALIASES[name]) continue;
    assert.equal(J.resolveJudge(name).name, name, `${name} was rewritten without an alias entry`);
  }
  for (const [raw, alias] of Object.entries(J.JUDGE_ALIASES)) {
    assert.equal(J.resolveJudge(raw).name, alias.canonical, `${raw} does not resolve to its declared canonical`);
  }
});

test("a pair still under review is absent from the migration seed too", () => {
  /* Vacuous while the review list is empty, and deliberately kept: it is the
     guard that stops the next candidate being merged in SQL while the runtime
     still shows it as undecided. */
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const sql = readFileSync(join(root, "supabase", "migrations", "20260908000012_ufc_judge_intelligence.sql"), "utf8");
  const seed = sql.slice(sql.indexOf("_judge_alias_seed"), sql.indexOf("insert into public.ufc_judge_profiles"));
  for (const c of J.PROVISIONAL_IDENTITY_CANDIDATES) {
    for (const name of c.names) {
      assert.ok(!seed.includes(`('${name}'`), `${name} is still seeded as an alias by the migration`);
    }
  }
  /* The other direction: every merge the runtime applies must be seeded. */
  for (const e of J.SPELLING_VARIANT_EVIDENCE) {
    assert.ok(seed.includes(`('${e.rawName}', '${e.canonical}', 'spelling_variant'`),
      `${e.rawName} -> ${e.canonical} is applied at runtime but not seeded by the migration`);
  }
});

test("a provisional candidate records what is and is not established", () => {
  for (const c of J.PROVISIONAL_IDENTITY_CANDIDATES) {
    assert.ok(["unconfirmed", "externally_confirmed_pending_review"].includes(c.status));
    assert.ok(c.archiveEvidence && c.note, "a candidate must say why it is a candidate and why it is not merged");
    if (c.status === "externally_confirmed_pending_review") {
      assert.match(c.externalSourceUrl || "", /^https?:\/\/\S+$/, "a confirmed candidate must cite its source");
      assert.ok(c.externalFinding, "a confirmed candidate must say what the source showed");
      assert.ok(c.proposedCanonical && c.names.includes(c.proposedCanonical),
        "a confirmed candidate must name which of the two spellings would become canonical");
    }
  }
});

test("a merged spelling's old profile URL still resolves somewhere", () => {
  /* Merging an identity retires a slug that was a live page. The route
     redirects it to the canonical profile; this pins the mapping the route
     depends on, so a merge can never silently 404 a URL that used to work. */
  for (const e of J.SPELLING_VARIANT_EVIDENCE) {
    const from = J.judgeSlug(e.rawName);
    const to = J.judgeSlug(e.canonical);
    assert.notEqual(from, to, `${e.rawName} and ${e.canonical} share a slug, so nothing to redirect`);
    assert.ok(from && to, "both slugs must be non-empty");
  }
});
