// Network source-brand standard (DATA · PropSports): article text boundary + repo guard.
import test from "node:test";
import assert from "node:assert/strict";
import { brandText, brandArticle, brandArticlesDeep } from "./sourceBrand.ts";
import { scan } from "../../scripts/guard-source-brand.mjs";

test("article text names PropSports, not the round-stat lane; publishers untouched", () => {
  assert.equal(brandText("Round-level UFC Stats exist for 5 archived rounds"), "Round-level stats exist for 5 archived rounds");
  assert.equal(brandText("All of these are career-to-date UFC Stats snapshots"), "All of these are career-to-date PropSports snapshots");
  assert.equal(brandText("ESPN's 30 under 30 list"), "ESPN's 30 under 30 list");
  const a = { headline: "x", dek: "UFC Stats averages", body_md: "UFCStats", fact_block: { source: "UFC Stats" } };
  const b = brandArticle(a);
  assert.equal(b.dek, "PropSports averages");
  assert.equal(b.body_md, "PropSports");
  assert.deepEqual(b.fact_block, a.fact_block, "only article text keys change");
  assert.equal(a.dek, "UFC Stats averages", "stored row untouched");
  assert.deepEqual(brandArticlesDeep({ rows: [{ body_md: "UFC Stats" }], ufcstats_id: "abc" }), { rows: [{ body_md: "PropSports" }], ufcstats_id: "abc" });
});
test("source-brand guard: customer surfaces and public serializers are clean", () => {
  assert.deepEqual(scan(), []);
});
