import test from "node:test";
import assert from "node:assert/strict";
import { pickDivisionContext } from "./dnaDivisionContextModel.ts";

const doc = {
  as_of: "2026-10-05",
  definition_version: 1,
  metrics: { sig_landed_per_min: { better: "higher" }, sig_absorbed_per_min: { better: "lower" }, td_accuracy: { better: "higher" } },
  divisions: { "M:FEATHERWEIGHT": { label: "Featherweight", population: 99 } },
  fighters: {
    volk: { division: "M:FEATHERWEIGHT", ranks: { sig_landed_per_min: [9, 95], sig_absorbed_per_min: [34, 95], td_accuracy: [96, 93] } },
    orphan: { division: "M:UNKNOWN", ranks: { sig_landed_per_min: [1, 1] } },
  },
};

test("picks one fighter's ranks in metric order with direction", () => {
  assert.deepEqual(pickDivisionContext(doc, "volk"), {
    as_of: "2026-10-05",
    division: { key: "M:FEATHERWEIGHT", label: "Featherweight", population: 99 },
    ranks: [
      { metric: "sig_landed_per_min", rank: 9, n: 95, better: "higher" },
      { metric: "sig_absorbed_per_min", rank: 34, n: 95, better: "lower" },
    ],
  }, "an impossible rank (96 of 93) is dropped, never clamped");
});

test("fail-null on unknown fighter, unknown division or malformed document", () => {
  assert.equal(pickDivisionContext(doc, "nobody"), null);
  assert.equal(pickDivisionContext(doc, "orphan"), null);
  assert.equal(pickDivisionContext(null, "volk"), null);
  assert.equal(pickDivisionContext({ ...doc, as_of: 5 }, "volk"), null);
  assert.equal(pickDivisionContext({ ...doc, fighters: { volk: { division: "M:FEATHERWEIGHT", ranks: { sig_landed_per_min: ["9", 95] } } } }, "volk"), null);
});
