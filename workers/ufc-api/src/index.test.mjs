import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "./index.js";

test("clampInt applies defaults and bounds", () => {
  assert.equal(__test.clampInt(undefined, 25, 1, 100), 25);
  assert.equal(__test.clampInt("0", 25, 1, 100), 1);
  assert.equal(__test.clampInt("999", 25, 1, 100), 100);
  assert.equal(__test.clampInt("42", 25, 1, 100), 42);
});

test("sanitizeLike strips PostgREST wildcard punctuation", () => {
  assert.equal(__test.sanitizeLike("  Sean*(O'Malley),  "), "Sean O'Malley");
});

test("identityFilter routes UUID, UFCStats ids, and ESPN ids", () => {
  assert.deepEqual(
    __test.identityFilter("bc0f994d-e052-1926-a123-123456789abc", "id", "ufcstats_id", "espn_event_id"),
    ["id", "eq.bc0f994d-e052-1926-a123-123456789abc"],
  );
  assert.deepEqual(
    __test.identityFilter("abcdef1234567890", "id", "ufcstats_id", "espn_event_id"),
    ["ufcstats_id", "eq.abcdef1234567890"],
  );
  assert.deepEqual(
    __test.identityFilter("600056266", "id", "ufcstats_id", "espn_event_id"),
    ["espn_event_id", "eq.600056266"],
  );
});

test("normalizeBout turns embedded result arrays into one result", () => {
  assert.deepEqual(__test.normalizeBout({ id: "x", result: [{ bout_id: "x" }] }), { id: "x", result: { bout_id: "x" } });
  assert.deepEqual(__test.normalizeBout({ id: "x", result: [] }), { id: "x", result: null });
});
