import assert from "node:assert/strict";
import test from "node:test";
import { buildEditorialEvidence } from "./editorialEvidence.ts";

test("only displays verification badges backed by stored evidence", () => {
  const evidence = buildEditorialEvidence({
    gate: { ok: true },
    sourceLinked: true,
    chartCount: 2,
    dataFamilies: ["ufc_fighters", "ufc_bouts"],
  });

  assert.deepEqual(evidence.badges.map((badge) => badge.label), [
    "Fact packet verified",
    "Automated editorial",
    "Source linked",
    "Data-drawn charts",
  ]);
  assert.match(evidence.receipts.join(" "), /2 first-party data families/);
  assert.match(evidence.receipts.join(" "), /2 charts drawn/);
});

test("fails closed when verification metadata is absent", () => {
  const evidence = buildEditorialEvidence({ chartCount: 0 });

  assert.equal(evidence.gateVerified, false);
  assert.deepEqual(evidence.badges.map((badge) => badge.label), ["Automated editorial"]);
  assert.equal(evidence.receipts.length, 0);
  assert.ok(evidence.limitations.some((line) => line.includes("No verified market snapshot")));
});

test("turns known analytical omissions into reader language and hides raw reasons", () => {
  const evidence = buildEditorialEvidence({
    oddsStatus: "available",
    omitted: [
      { id: "fight_dna", reason: "coverage_gate_0.82" },
      { id: "fight_dna", reason: "duplicate" },
      { id: "official_video", reason: "youtube_api_empty" },
    ],
  });

  assert.equal(evidence.limitations.filter((line) => line.includes("Fight DNA")).length, 1);
  assert.equal(evidence.limitations.some((line) => line.includes("coverage_gate")), false);
  assert.equal(evidence.limitations.some((line) => line.includes("youtube_api")), false);
  assert.equal(evidence.limitations.some((line) => line.includes("No verified market snapshot")), false);
});

test("never implies human review", () => {
  const evidence = buildEditorialEvidence({ gate: { green_path: true } });
  assert.equal(JSON.stringify(evidence).toLowerCase().includes("human reviewed"), false);
});
