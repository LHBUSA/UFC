import test from "node:test";
import assert from "node:assert/strict";
import { portraitDecision, classifyLicense, identityConfidence, suitability, fighterPriority, candidatePriority, buildScope, ESPN_RIGHTS } from "./fighterMediaPolicy.ts";

const approved = {
  id: "a", fighter_id: "f", image_url: "https://x.supabase.co/storage/v1/object/public/ufc-media/fighters/f/portrait.jpg",
  storage_key: "fighters/f/portrait.jpg", legacy_image_id: null, source_url: "https://commons.wikimedia.org/wiki/File:X.jpg",
  source_name: "Wikimedia Commons", source_type: "wikimedia_commons", license_type: "cc_by_sa", license_label: "CC BY-SA 4.0",
  author: "Someone", commercial_use_allowed: true, derivative_use_allowed: true, attribution_required: true,
  attribution_text: "Someone, CC BY-SA 4.0, via Wikimedia Commons", verified_identity: true, review_status: "approved",
  is_primary: true, surface_policy: "all_surfaces", width: 800, height: 1000, focal_x: null, focal_y: null,
  suitability_score: 80, last_verified_at: "2026-09-10T00:00:00Z",
};
const espn = { ...approved, image_url: "https://a.espncdn.com/i/headshots/mma/players/full/1.png", source_type: "espn", ...ESPN_RIGHTS, attribution_text: "Photo: ESPN", surface_policy: "standard_surfaces" };

test("approved, verified, primary, commercial asset renders everywhere", () => {
  assert.deepEqual(portraitDecision(approved, "high_visibility"), { ok: true });
  assert.deepEqual(portraitDecision(approved, "standard"), { ok: true });
});

test("anything short of approved + verified + primary is refused", () => {
  assert.equal(portraitDecision(null, "standard").ok, false);
  for (const s of ["pending", "rejected", "quarantined", "retired"]) {
    assert.deepEqual(portraitDecision({ ...approved, review_status: s }, "standard"), { ok: false, reason: "not_approved" });
  }
  assert.deepEqual(portraitDecision({ ...approved, verified_identity: false }, "standard"), { ok: false, reason: "identity_unverified" });
  assert.deepEqual(portraitDecision({ ...approved, is_primary: false }, "standard"), { ok: false, reason: "not_primary" });
  assert.deepEqual(portraitDecision({ ...approved, last_verified_at: null }, "standard"), { ok: false, reason: "never_verified" });
  assert.deepEqual(portraitDecision({ ...approved, image_url: "http://x/y.jpg" }, "standard"), { ok: false, reason: "insecure_url" });
  assert.deepEqual(portraitDecision({ ...approved, attribution_text: " " }, "standard"), { ok: false, reason: "missing_attribution" });
  assert.deepEqual(portraitDecision({ ...approved, surface_policy: "internal_only" }, "standard"), { ok: false, reason: "internal_only" });
});

test("high-visibility surfaces require a commercial grant", () => {
  assert.deepEqual(portraitDecision(espn, "high_visibility"), { ok: false, reason: "surface_restricted" });
  assert.deepEqual(portraitDecision({ ...espn, surface_policy: "all_surfaces" }, "high_visibility"), { ok: false, reason: "commercial_rights_required" });
  assert.deepEqual(portraitDecision(espn, "standard"), { ok: true });
  assert.deepEqual(portraitDecision({ ...approved, license_type: "unknown" }, "standard"), { ok: false, reason: "rights_basis_inconsistent" });
});

test("license allowlist matches the Commons ingest gate and nothing wider", () => {
  assert.equal(classifyLicense("CC BY-SA 4.0").license_type, "cc_by_sa");
  assert.equal(classifyLicense("CC BY 2.0").license_type, "cc_by");
  assert.equal(classifyLicense("CC0").license_type, "cc0");
  assert.equal(classifyLicense("Public domain").license_type, "public_domain");
  for (const bad of ["CC BY-NC 2.0", "CC BY-ND 4.0", "CC BY-NC-SA 3.0", "GFDL", "", null, "All rights reserved", "Fair use"]) {
    const r = classifyLicense(bad);
    assert.equal(r.license_type, "unknown", String(bad));
    assert.equal(r.commercial_use_allowed, false, String(bad));
  }
});

test("identity confidence orders the queue but never reaches 1", () => {
  assert.equal(identityConfidence({ method: "wikidata_p18", dob_match: true }, "wikimedia_commons"), 0.95);
  assert.equal(identityConfidence({}, "wikimedia_commons"), 0.2);
  assert.equal(identityConfidence({ former_fighter_id: "x", status: "detached" }, "wikimedia_commons"), 0);
  assert.equal(identityConfidence({ athlete_id_match: true, name_exact: true, dob_match: true }, "espn"), 0.9);
  assert.equal(identityConfidence({ athlete_id_match: true, name_exact: true, dob_match: false }, "espn"), 0.05);
  assert.equal(identityConfidence({ athlete_id_match: true, name_exact: false }, "espn"), 0.3);
});

test("suitability rejects non-photo formats outright", () => {
  assert.equal(suitability({ image_url: "https://upload.wikimedia.org/x/Book_1860.djvu", source_type: "wikimedia_commons" }).score, 0);
  assert.ok(suitability({ image_url: "https://x/y.jpg", width: 800, height: 1000, framing_status: "ok", source_type: "wikimedia_commons" }).score >= 90);
  assert.ok(suitability({ image_url: "https://x/y.jpg", width: 200, height: 3000, source_type: "wikimedia_commons" }).flags.includes("low_resolution"));
});

test("scope: ranked, next cards, featured and active roster with reasons", () => {
  const scope = buildScope({
    rankings: { divisions: [
      { is_p4p: false, champion: { fighter_id: "champ" }, entries: [{ rank: 1, fighter_id: "r1" }, { rank: 9, fighter_id: "r9" }] },
      { is_p4p: true, champion: null, entries: [{ rank: 1, fighter_id: "champ" }] },
    ] },
    cards: [[{ fighter_a_id: "m1", fighter_b_id: "m2" }, { fighter_a_id: "u1", fighter_b_id: "r9" }], [{ fighter_a_id: "c2", fighter_b_id: "c2b" }], [{ fighter_a_id: "c3", fighter_b_id: "c3b" }], [{ fighter_a_id: "c4", fighter_b_id: "c4b" }]],
    featuredIds: ["f1"],
    activeIds: ["a1", "champ"],
  });
  assert.deepEqual(scope.get("champ").reasons.sort(), ["active_roster", "champion", "p4p"]);
  assert.deepEqual(scope.get("m1").reasons, ["next_card_main_event"]);
  assert.deepEqual(scope.get("r9").reasons.sort(), ["next_card", "ranked"]);
  assert.deepEqual(scope.get("c3").reasons, ["card_3"]);
  assert.equal(scope.has("c4"), false, "only the next three cards are in scope");
  assert.ok(scope.get("champ").priority > scope.get("m1").priority);
  assert.ok(scope.get("m1").priority > scope.get("a1").priority);
});

test("priority: champion and next-card main event lead; extra reasons add a little", () => {
  assert.equal(fighterPriority([]), 0);
  assert.equal(fighterPriority(["champion"]), 100);
  assert.ok(fighterPriority(["ranked", "next_card"]) > fighterPriority(["next_card"]));
  assert.ok(fighterPriority(["active_roster"]) < fighterPriority(["card_3"]));
  assert.ok(candidatePriority(100, 0.95, 80, true) > candidatePriority(100, 0.2, 80, true));
});
