import { test } from "node:test";
import assert from "node:assert/strict";
import { contenderIdentity, isDanaWhiteContenderSeries } from "./contenderIdentity.ts";

test("numbered season and week come from the name", () => {
  const id = contenderIdentity("Dana White's Contender Series: Season 4, Week 6", "2020-09-15");
  assert.deepEqual([id.series, id.season, id.week, id.episode, id.label, id.short], ["dwcs", 4, 6, null, "Season 4 · Week 6", "S4 W6"]);
});

test("Contender Series Brazil is its own series, never Season 2", () => {
  for (const [name, ep] of [["Dana White's Contender Series: Brazil 1", 1], ["Dana White's Contender Series: Brazil 3", 3]] as const) {
    const id = contenderIdentity(name, "2018-08-12");
    assert.equal(id.series, "brazil");
    assert.equal(id.season, null, "a 2018 date must not make Brazil Season 2");
    assert.equal(id.week, null, "Brazil episodes are not numbered weeks");
    assert.equal(id.episode, ep);
    assert.equal(id.label, `Brazil · Episode ${ep}`);
  }
});

test("the year fallback applies to the numbered series only", () => {
  assert.equal(contenderIdentity("Dana White's Contender Series 2019", "2019-07-02").season, 3);
  assert.equal(contenderIdentity("Dana White's Contender Series: Brazil", "2018-08-11").season, null);
});

test("Road to UFC is not the Contender Series", () => {
  assert.equal(isDanaWhiteContenderSeries("Road to UFC Season 3: Episode 1"), false);
  assert.equal(isDanaWhiteContenderSeries("Dana White's Contender Series: Season 10, Week 5"), true);
});
