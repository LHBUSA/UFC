/**
 * Crash-recovery tests.
 *
 *   node --test scripts/store/reconcile_rules.test.mjs
 *
 * Each of these corresponds to a way the provisioning run can die, and the
 * property under test is always the same one: no path may hand a slug back
 * for another create attempt unless we have positive evidence that nothing
 * was created.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CLAIMABLE, DEFAULTS, classifyOutcome, decideReconcile, decideStaleClaim, isClaimable } from "./reconcile_rules.mjs";

const T = Date.parse("2026-09-07T12:00:00Z");
const min = (n) => n * 60_000;
const iso = (t) => new Date(t).toISOString();

/* ---- claimability -------------------------------------------------------- */

test("only unclaimed and failed are claimable", () => {
  assert.deepEqual([...CLAIMABLE].sort(), ["failed", "unclaimed"]);
  for (const s of ["created", "uncertain", "in_flight"]) {
    assert.equal(isClaimable(s), false, `${s} must never be claimable`);
  }
});

/* ---- 1. the process dies before it can record anything ------------------- */

test("a claim abandoned mid-request becomes uncertain, never reclaimable", () => {
  const row = { state: "in_flight", claimed_at: iso(T - min(30)), claimed_by: "host/123" };
  const d = decideStaleClaim(row, T);
  assert.equal(d.action, "expire-to-uncertain");
  /* And the state it lands in is not claimable, so nothing can create next. */
  assert.equal(isClaimable("uncertain"), false);
});

test("uncertain_since is taken from the claim, not from the moment we noticed", () => {
  /* Otherwise an hour-old abandoned claim gets a fresh quarantine every time
   * a run happens to look at it, and it can never settle. */
  const claimedAt = T - min(90);
  const d = decideStaleClaim({ state: "in_flight", claimed_at: iso(claimedAt) }, T);
  assert.equal(d.uncertainSince, claimedAt);
});

test("a live claim is left alone", () => {
  const d = decideStaleClaim({ state: "in_flight", claimed_at: iso(T - min(2)) }, T);
  assert.equal(d.action, "leave");
});

/* ---- 2. abandoned claims reconcile before another create ----------------- */

test("an abandoned claim whose product does exist is adopted, not recreated", () => {
  const row = { state: "uncertain", uncertain_since: iso(T - min(30)), absent_checks: 0 };
  const d = decideReconcile(row, [{ id: 987 }], T);
  assert.equal(d.action, "adopt");
  assert.equal(d.productId, 987);
});

test("two products under one external_id escalate rather than resolve", () => {
  /* The provider is not assumed to enforce uniqueness on external_id, so this
   * case has to be reachable and must not be papered over by taking [0]. */
  const row = { state: "uncertain", uncertain_since: iso(T - min(60)), absent_checks: 9 };
  const d = decideReconcile(row, [{ id: 1 }, { id: 2 }], T);
  assert.equal(d.action, "escalate");
  assert.deepEqual(d.ids, [1, 2]);
});

/* ---- 3. zero matches now is not proof of absence ------------------------- */

test("zero matches immediately after an uncertain outcome does NOT permit a retry", () => {
  const row = { state: "uncertain", uncertain_since: iso(T - 1000), absent_checks: 0, last_absent_check_at: null };
  const d = decideReconcile(row, [], T);
  assert.notEqual(d.action, "settle-absent");
  assert.equal(d.action, "record-absent");
  assert.ok(d.stillNeeds.ms > 0, "quarantine must still have time left");
  assert.ok(d.stillNeeds.checks > 0, "more independent checks must still be required");
});

test("absence needs BOTH the quarantine window and enough independent checks", () => {
  const enoughTime = iso(T - min(20));   // past the 15-minute quarantine
  const freshTime = iso(T - min(3));     // not past it

  /* Time but not enough observations. */
  assert.equal(
    decideReconcile({ state: "uncertain", uncertain_since: enoughTime, absent_checks: 1, last_absent_check_at: iso(T - min(5)) }, [], T).action,
    "record-absent",
  );
  /* Observations but not enough time. */
  assert.equal(
    decideReconcile({ state: "uncertain", uncertain_since: freshTime, absent_checks: 9, last_absent_check_at: iso(T - min(5)) }, [], T).action,
    "record-absent",
  );
  /* Both. */
  assert.equal(
    decideReconcile({ state: "uncertain", uncertain_since: enoughTime, absent_checks: 3, last_absent_check_at: iso(T - min(5)) }, [], T).action,
    "settle-absent",
  );
});

test("hammering the provider cannot manufacture evidence that time has passed", () => {
  /* Three checks a second apart are one observation, not three. */
  const row = {
    state: "uncertain",
    uncertain_since: iso(T - min(20)),
    absent_checks: 2,
    last_absent_check_at: iso(T - 1000),
  };
  const d = decideReconcile(row, [], T);
  assert.equal(d.action, "wait");
  assert.match(d.reason, /independent/);
});

test("settling absence lands in failed, which is the only retryable state", () => {
  const row = { state: "uncertain", uncertain_since: iso(T - min(20)), absent_checks: 3, last_absent_check_at: iso(T - min(5)) };
  assert.equal(decideReconcile(row, [], T).action, "settle-absent");
  assert.equal(isClaimable("failed"), true);
});

/* ---- outcome classification --------------------------------------------- */

test("unobserved outcomes are uncertain; observed refusals are failures", () => {
  assert.equal(classifyOutcome({ transportError: "AbortError: timeout" }), "uncertain");
  assert.equal(classifyOutcome({ status: 502 }), "uncertain");
  assert.equal(classifyOutcome({ status: 429 }), "uncertain");
  assert.equal(classifyOutcome({ status: 200, parseError: true }), "uncertain");
  assert.equal(classifyOutcome({ status: 422 }), "failed");
  assert.equal(classifyOutcome({ status: 400 }), "failed");
  assert.equal(classifyOutcome({ status: 200 }), "ok");
});

test("the defaults are conservative enough to be worth trusting", () => {
  assert.ok(DEFAULTS.quarantineMs >= min(10), "quarantine must outlast provider indexing lag");
  assert.ok(DEFAULTS.minAbsentChecks >= 3, "one or two lookups is not evidence");
  assert.ok(DEFAULTS.recheckMs >= min(1), "checks must be spaced to be independent");
});
