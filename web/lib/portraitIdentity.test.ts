/* Generational-suffix identity equivalence for portrait verification.
 *
 * The rule exists for one real case: our records say "Sean King", ESPN athlete
 * 5401058 says "Sean King III", the ESPN id and the DOB (2003-10-17) both
 * agree, and the correct portrait was being rejected over "iii".
 *
 * These tests exist to stop the fix from ever becoming fuzzy name matching.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameIdentityName, withoutGenerationalSuffix, normalizedName } from "./portraitIdentity.ts";

test("identical names always match, confirmed or not", () => {
  assert.equal(sameIdentityName("sean king", "sean king", true), true);
  assert.equal(sameIdentityName("sean king", "sean king", false), true);
});

test("the real case: Sean King vs Sean King III, id and DOB confirmed", () => {
  const ours = normalizedName("Sean King");
  const espn = normalizedName("Sean King III");
  assert.notEqual(ours, espn, "these are genuinely different strings");
  assert.equal(sameIdentityName(ours, espn, true), true);
});

test("WITHOUT identity confirmation the strict rule still stands", () => {
  /* No DOB to corroborate the id, so a suffix difference is not forgiven. */
  assert.equal(sameIdentityName(normalizedName("Sean King"), normalizedName("Sean King III"), false), false);
});

test("every generational suffix is covered, in both directions", () => {
  for (const suffix of ["Jr", "Sr", "II", "III", "IV", "V"]) {
    const plain = normalizedName("John Smith");
    const suffixed = normalizedName(`John Smith ${suffix}`);
    assert.equal(sameIdentityName(plain, suffixed, true), true, `${suffix} plain->suffixed`);
    assert.equal(sameIdentityName(suffixed, plain, true), true, `${suffix} suffixed->plain`);
  }
});

test("it never shortens a real surname", () => {
  assert.equal(withoutGenerationalSuffix(normalizedName("Sean Kingston")), "sean kingston");
  assert.equal(withoutGenerationalSuffix(normalizedName("Danny Ives")), "danny ives");
  /* "v" only strips as a whole trailing token, never off the end of a word. */
  assert.equal(withoutGenerationalSuffix(normalizedName("Alex Volkanovski")), "alex volkanovski");
});

test("DIFFERENT fighters never match, even with identity confirmed", () => {
  const cases: Array<[string, string]> = [
    ["Sean King", "Sean Kingston"],
    ["John Smith", "John Smyth"],
    ["Jose Aldo", "Jose Aldo Junior Something"],
    ["Charles Oliveira", "Charles Oliver"],
    ["Sean King", "Shaun King"],
  ];
  for (const [a, b] of cases) {
    assert.equal(
      sameIdentityName(normalizedName(a), normalizedName(b), true),
      false,
      `${a} must not match ${b}`,
    );
  }
});

test("a name that is ONLY a suffix cannot collapse to an empty match", () => {
  /* Two fighters recorded as bare suffixes must not become equal by both
   * stripping to "". */
  assert.equal(sameIdentityName(normalizedName("III"), normalizedName("IV"), true), false);
  assert.equal(sameIdentityName(normalizedName("Jr"), normalizedName("Sr"), true), false);
});

test("empty input never matches", () => {
  assert.equal(sameIdentityName("", "sean king", true), false);
  assert.equal(sameIdentityName("sean king", "", true), false);
});

test("suffix stripping is applied to both sides, so Jr vs III still needs id+DOB", () => {
  /* With identity confirmed these are the same athlete record by construction
   * (same ESPN id, same DOB), so this is intentional. Without confirmation it
   * must fail. */
  const a = normalizedName("John Smith Jr");
  const b = normalizedName("John Smith III");
  assert.equal(sameIdentityName(a, b, false), false);
  assert.equal(sameIdentityName(a, b, true), true);
});
