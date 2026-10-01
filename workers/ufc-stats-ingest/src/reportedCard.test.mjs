import test from "node:test";
import assert from "node:assert/strict";
import { fightmagDwcsUrl, matchupKey, parseFightmagDwcsCard } from "./reportedCard.mjs";

const HTML = `
<html><body>
<h1>Dana White’s Contender Series Season 10, Week 9</h1>
<h2>DWCS Season 10, Week 9 fight card</h2>
<ul>
<li>Roque Conceicao Moreira Jr. vs. Alexander Chavez, flyweight</li>
<li>Ivan Gnizditskiy vs. Nell Ariano, light heavyweight</li>
<li>Ryuho Miyaguchi vs. Matheus Soares, bantamweight</li>
<li>Salhahuddin Everett vs. Ozzy Martin, welterweight</li>
<li>Alivia Bierley vs. Summer Onley, bantamweight</li>
</ul>
<h2>Event details</h2>
</body></html>`;

test("builds deterministic FIGHTMAG DWCS URL", () => {
  assert.equal(
    fightmagDwcsUrl("Dana White's Contender Series: Season 10, Week 9"),
    "https://schedule.fightmag.com/events/dana-whites-contender-series-season-10-week-9/",
  );
});

test("extracts only sourced fight-card rows", () => {
  const rows = parseFightmagDwcsCard(HTML, "Dana White's Contender Series: Season 10, Week 9");
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    fighter_a_name: "Roque Conceicao Moreira Jr.",
    fighter_b_name: "Alexander Chavez",
    weight_class_raw: "flyweight",
  });
  assert.equal(rows[1].weight_class_raw, "light heavyweight");
});

test("fails closed on the wrong DWCS week", () => {
  assert.deepEqual(parseFightmagDwcsCard(HTML, "Dana White's Contender Series: Season 10, Week 8"), []);
});

test("matchup key is orientation independent", () => {
  assert.equal(matchupKey("Ozzy Martin", "Salhahuddin Everett"), matchupKey("Salhahuddin Everett", "Ozzy Martin"));
});
