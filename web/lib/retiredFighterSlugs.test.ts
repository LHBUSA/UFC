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
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => x.permanent));
  assert.ok(!JSON.stringify(r).includes("0778f94eb5d588a5") && !JSON.stringify(r).includes("4357555"));
});
