import { test } from "node:test";
import assert from "node:assert/strict";
import { ageRange, dobDispute } from "./dobEvidence.ts";

test("sources that agree are not a dispute", () => {
  assert.equal(dobDispute([{ source: "espn", dob: "1994-12-12" }, { source: "ufcstats", dob: "1994-12-12" }]), null);
  assert.equal(dobDispute([{ source: "espn", dob: "1994-12-12" }]), null);
  assert.equal(dobDispute([]), null);
});

test("De Castro and Pajuelo: both values are kept, neither is chosen", () => {
  const dc = dobDispute([{ source: "espn", dob: "1987-12-19" }, { source: "ufcstats", dob: "1986-12-19" }]);
  assert.deepEqual(dc, { values: [{ dob: "1986-12-19", sources: ["UFC Stats"] }, { dob: "1987-12-19", sources: ["ESPN"] }] });
  const lp = dobDispute([{ source: "espn", dob: "1994-12-12" }, { source: "ufcstats", dob: "1994-12-18" }]);
  assert.equal(lp?.values.length, 2);
});

test("the age is shown as the range the sources allow", () => {
  const dc = dobDispute([{ source: "espn", dob: "1987-12-19" }, { source: "ufcstats", dob: "1986-12-19" }])!;
  assert.equal(ageRange(dc, new Date("2026-09-13T00:00:00Z")), "38–39");
  const lp = dobDispute([{ source: "espn", dob: "1994-12-12" }, { source: "ufcstats", dob: "1994-12-18" }])!;
  assert.equal(ageRange(lp, new Date("2026-09-13T00:00:00Z")), "31", "six days apart can still be one age");
  assert.equal(ageRange(lp, new Date("2026-12-15T00:00:00Z")), "31–32");
});

test("malformed or empty dates are ignored, never treated as a disagreement", () => {
  assert.equal(dobDispute([{ source: "espn", dob: "1994-12-12" }, { source: "ufcstats", dob: "" }, { source: "x", dob: "unknown" }]), null);
});
