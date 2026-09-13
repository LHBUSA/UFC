import { test } from "node:test";
import assert from "node:assert/strict";
import { RETIRED_FIGHTER_SLUGS, retiredFighterSlugRedirects, retiredSlugPattern } from "./retiredFighterSlugs.ts";

const matches = (id: string, slug: string) => new RegExp(`^${retiredSlugPattern(id)}$`).test(slug);

test("a retired UFC Stats-keyed slug matches, with or without a name", () => {
  assert.ok(matches("1eff7bc0f815b270", "yorgan-de-castro-1eff7bc0f815b270"));
  assert.ok(matches("1eff7bc0f815b270", "de-castro-1eff7bc0f815b270"));
  assert.ok(matches("e530df53922f413e", "luis-pajuelo-e530df53922f413e"));
});

test("the canonical slug never matches its own redirect (no loop)", () => {
  for (const r of RETIRED_FIGHTER_SLUGS) {
    assert.ok(!matches(r.retiredSourceId, r.canonicalSlug), `${r.canonicalSlug} would redirect to itself`);
    assert.ok(!r.canonicalSlug.endsWith(r.retiredSourceId));
  }
});

test("an id that merely contains the retired id is not captured", () => {
  assert.ok(!matches("1eff7bc0f815b270", "someone-x1eff7bc0f815b270"));
  assert.ok(!matches("1eff7bc0f815b270", "yorgan-de-castro-1eff7bc0f815b2701"));
});

test("one permanent redirect per retired fighter, never Joey Gomez", () => {
  const r = retiredFighterSlugRedirects();
  assert.equal(r.length, 28, "2 DWCS merges + 16 TUF 1 + 10 TUF 2 ESPN-id attachments");
  assert.equal(new Set(RETIRED_FIGHTER_SLUGS.map((x) => x.retiredSourceId)).size, r.length, "one entry per retired id");
  assert.ok(r.every((x) => x.permanent));
  assert.ok(!JSON.stringify(r).includes("0778f94eb5d588a5") && !JSON.stringify(r).includes("4357555"));
});

test("a TUF 1 contestant's old UFC Stats URL lands on the ESPN-keyed profile", () => {
  const griffin = RETIRED_FIGHTER_SLUGS.find((x) => x.canonicalSlug === "forrest-griffin-2335522");
  assert.ok(griffin, "Forrest Griffin is redirected");
  assert.equal(griffin!.retiredSourceId, "fcffee71cff5530e");
  assert.ok(matches(griffin!.retiredSourceId, "forrest-griffin-fcffee71cff5530e"));
  const quarry = RETIRED_FIGHTER_SLUGS.find((x) => x.retiredSourceId === "52cae54377b433b7");
  assert.equal(quarry?.canonicalSlug, "nate-quarry-2335773", "the canonical row's own name, not the season's printed Nathan");
  assert.equal(RETIRED_FIGHTER_SLUGS.filter((x) => x.reconciliation === "tuf1-espn-athlete-ids-2026-09-13").length, 16);
});

test("the 10 TUF 2 contestants' old UFC Stats URLs land on their ESPN-keyed profiles", () => {
  const tuf2 = RETIRED_FIGHTER_SLUGS.filter((x) => x.reconciliation === "tuf2-espn-athlete-ids-2026-09-13");
  assert.equal(tuf2.length, 10);
  const burkman = tuf2.find((x) => x.retiredSourceId === "6da99156486ed6c2");
  assert.equal(burkman?.canonicalSlug, "joshua-burkman-2354104", "the canonical row's own name, not the season's printed Josh");
  assert.ok(matches("6da99156486ed6c2", "joshua-burkman-6da99156486ed6c2"));
  assert.ok(matches("6da99156486ed6c2", "josh-burkman-6da99156486ed6c2"), "an old link under another name prefix still redirects");
  for (const x of tuf2) assert.match(x.canonicalSlug, /-\d{7}$/);
});
