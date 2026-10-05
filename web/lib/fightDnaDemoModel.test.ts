/* Homepage Fight DNA public demo: selection is deterministic, values come only
 * from the stored snapshot, and missing data is omitted rather than invented. */
import test from "node:test";
import assert from "node:assert/strict";
import { MIN_PORTRAIT_SOURCE_HEIGHT, ROTATION_DAYS, buildDemoView, orderCandidates, portraitQualifies, rotationWindow, snapshotQualifies, type DemoPortrait } from "./fightDnaDemoModel.ts";
import type { DnaSnapshot, MetricObject } from "./dna";

const mo = (value: number | null, unit: string, extra: Partial<MetricObject> = {}): MetricObject => ({ value, unit, confidence: "high", ...extra });

function snap(over: Partial<DnaSnapshot> = {}): DnaSnapshot {
  return {
    as_of_date: "2026-10-05", definition_version: 1, sample_bouts: 18, sample_completed_bouts: 18, sample_stat_bouts: 18, sample_rounds: 63, sample_seconds: 18179, coverage_status: "high",
    metrics: {
      sig_landed_per_min: mo(5.99, "per_min"), sig_accuracy: mo(0.57, "ratio"), sig_defense: mo(0.587, "ratio"), sig_diff_per_min: mo(2.68, "per_min"),
      td_attempts_per_15: mo(4.8, "per_15"), td_accuracy: mo(0.34, "ratio"), control_share: mo(0.1975, "ratio"), sub_attempts_per_15: mo(0.198, "per_15"),
      head_attack_share: mo(0.73, "ratio"), body_attack_share: mo(0.09, "ratio"), leg_attack_share: mo(0.18, "ratio"),
    },
    stance_splits: {
      ORTHODOX: { record: { w: 13, l: 1, d: 0, nc: 0, appearances: 14 }, td_landed_per_15: mo(1.85, "per_15"), stat_bouts: 14, confidence: "high" },
      SOUTHPAW: { record: { w: 1, l: 2, d: 0, nc: 0, appearances: 3 }, td_landed_per_15: mo(1.28, "per_15"), stat_bouts: 3, confidence: "medium" },
      SIDEWAYS: { record: { w: 0, l: 0, d: 0, nc: 0, appearances: 0 }, stat_bouts: 0, confidence: "insufficient" },
      same: { record: { w: 13, l: 1, d: 0, nc: 0, appearances: 14 } },
    },
    round_profile: {
      rounds: {
        "1": { sig_landed_per_min: mo(4.56, "per_min", { confidence: "medium" }), absorbed_per_min: mo(2.74, "per_min"), rounds: 18 },
        "2": { sig_landed_per_min: mo(6.2, "per_min"), absorbed_per_min: mo(3.4, "per_min"), rounds: 17 },
        "3": { sig_landed_per_min: mo(6.81, "per_min"), rounds: 13 },
      },
      pace_retention_r3_vs_r1: mo(1.3445, "ratio"), defensive_drift_r3_vs_r1: mo(0.716, "per_min"),
    },
    finish_profile: {
      finish_rate: mo(5 / 15, "ratio", { numerator: 5, denominator: 15 }), ko_finish_rate: mo(5 / 15, "ratio", { numerator: 5, denominator: 15 }),
      submission_finish_rate: mo(0, "ratio", { numerator: 0, denominator: 15 }), finish_time_median_sec: mo(597, "seconds"),
      finish_round_distribution: { value: { total: 5, buckets: { "1": 0, "2": 3, "3": 1, "4": 1, "5": 0 } } as unknown as number, unit: "distribution", confidence: "high" },
    },
    context_splits: { short_notice: { record: { w: 1, l: 0, d: 0, nc: 0 } } }, position_profile: { secret: 1 }, provenance: { bouts: ["a", "b"] },
    ...over,
  };
}

const portrait = (h: number | null, firstParty = true): DemoPortrait => ({ src: "https://media/x/card.jpg", firstParty, sourceHeight: h });

test("a portrait qualifies only when stored first-party and tall enough for the hero panel", () => {
  assert.ok(portraitQualifies(portrait(MIN_PORTRAIT_SOURCE_HEIGHT)));
  assert.ok(!portraitQualifies(portrait(470)), "low-res source (webcam still) is rejected");
  assert.ok(!portraitQualifies(portrait(null)), "unknown source size is rejected");
  assert.ok(!portraitQualifies(portrait(1300, false)), "display-only provider fallback is rejected");
  assert.ok(!portraitQualifies(null));
});

test("rotation: one pick per 21-day window, stable inside it, portrait-gated and de-duplicated", () => {
  const cands = [{ id: "allen", context: "#1 Middleweight" }, { id: "van", context: "Flyweight champion" }, { id: "volk", context: "Featherweight champion" }, { id: "volk", context: "dupe" }, { id: "gaethje", context: "Lightweight champion" }, { id: "makhachev", context: "Welterweight champion" }];
  const portraits = new Map([["allen", portrait(470)], ["van", portrait(null)], ["volk", portrait(1300)], ["gaethje", portrait(1613)], ["makhachev", portrait(1080)]]);
  const w0 = orderCandidates(cands, portraits, 0).map((c) => c.id);
  assert.deepEqual([...w0].sort(), ["gaethje", "makhachev", "volk"], "low-res and unknown-size portraits never enter the pool; duplicates collapse");
  assert.deepEqual(orderCandidates(cands, portraits, 0).map((c) => c.id), w0, "same window, same order");
  assert.deepEqual(orderCandidates([...cands].reverse(), portraits, 0).map((c) => c.id), w0, "caller order does not matter inside a window");
  const firsts = new Set(Array.from({ length: 12 }, (_, i) => orderCandidates(cands, portraits, i)[0].id));
  assert.ok(firsts.size > 1, "the featured fighter changes across windows");
});

test("rotation windows are fixed 21-day calendar blocks from the epoch", () => {
  assert.equal(ROTATION_DAYS, 21);
  const t = (d: string) => Date.parse(`${d}T12:00:00Z`);
  assert.deepEqual(rotationWindow(t("2026-10-05")), { index: 0, start: "2026-10-05", end: "2026-10-25" });
  assert.deepEqual(rotationWindow(t("2026-10-25")), { index: 0, start: "2026-10-05", end: "2026-10-25" });
  assert.deepEqual(rotationWindow(t("2026-10-26")), { index: 1, start: "2026-10-26", end: "2026-11-15" });
});

test("only a high-coverage snapshot with the core metrics qualifies", () => {
  assert.ok(snapshotQualifies(snap()));
  assert.ok(!snapshotQualifies(snap({ coverage_status: "medium" })));
  assert.ok(!snapshotQualifies(snap({ sample_completed_bouts: 4 })));
  assert.ok(!snapshotQualifies(snap({ metrics: { ...snap().metrics, sig_accuracy: mo(null, "ratio") } })), "a null core metric disqualifies, it is never shown as a placeholder");
  assert.ok(!snapshotQualifies(snap({ round_profile: { rounds: { "1": { sig_landed_per_min: mo(4, "per_min") } } } })));
  assert.ok(!snapshotQualifies(null));
});

test("the view carries stored values only and omits what is missing", () => {
  const v = buildDemoView(snap());
  assert.deepEqual(v.striking.map((t) => [t.key, t.metric.value]), [["sig_landed_per_min", 5.99], ["sig_accuracy", 0.57], ["sig_defense", 0.587], ["sig_diff_per_min", 2.68]]);
  assert.deepEqual(v.target.map((t) => t.value), [0.73, 0.09, 0.18]);
  /* Round 3 has no absorbed value: null, not zero. Rounds 4-5 were never reached: absent. */
  assert.deepEqual(v.rounds.map((r) => [r.round, r.landed, r.absorbed]), [["1", 4.56, 2.74], ["2", 6.2, 3.4], ["3", 6.81, null]]);
  /* championship_round_delta is missing from the snapshot, so it is not a tile. */
  assert.deepEqual(v.roundDeltas.map((t) => t.key), ["pace_retention_r3_vs_r1", "defensive_drift_r3_vs_r1"]);
  /* Stances with no appearances are dropped; open/same groupings are not stance rows. */
  assert.deepEqual(v.stances.map((s) => s.stance), ["ORTHODOX", "SOUTHPAW"]);
  assert.deepEqual(v.stanceTd.map((s) => [s.stance, s.tdLanded?.value]), [["ORTHODOX", 1.85], ["SOUTHPAW", 1.28]]);
  /* Finish split: stored numerators; decision wins are wins minus finishes of the same stored ratio. */
  assert.deepEqual(v.finish && { wins: v.finish.wins, ko: v.finish.ko, sub: v.finish.sub, dec: v.finish.decision }, { wins: 15, ko: 5, sub: 0, dec: 10 });
  assert.deepEqual(v.finish?.byRound, [["1", 0], ["2", 3], ["3", 1], ["4", 1], ["5", 0]]);
  assert.equal(v.completedBouts, 18);
  /* No distance/clinch/ground shares in this snapshot: no position bar. Finished-by buckets absent: empty. */
  assert.deepEqual(v.position, []);
  assert.deepEqual(v.finishedByRound, []);
});

test("a missing grappling metric or target share is dropped, not zero-filled", () => {
  const s = snap();
  delete s.metrics.control_share;
  s.metrics.leg_attack_share = mo(null, "ratio");
  const v = buildDemoView(s);
  assert.deepEqual(v.grappling.map((t) => t.key), ["td_attempts_per_15", "td_accuracy", "sub_attempts_per_15"]);
  assert.deepEqual(v.target, [], "a partial target split is not drawn");
});

test("the view never carries provenance or premium-only splits", () => {
  const json = JSON.stringify(buildDemoView(snap()));
  for (const k of ["provenance", "context_splits", "position_profile", "short_notice", "secret"]) assert.ok(!json.includes(k), k);
});
