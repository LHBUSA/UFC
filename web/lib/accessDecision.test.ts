import test from "node:test";
import assert from "node:assert/strict";
import {
  decideUfcAccess, needsLedger, parseCheckoutReturn, checkoutReturnState, unlockHref,
  type AccountInput, type LedgerRead,
} from "./accessDecision.ts";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const future = "2026-10-14T12:00:00Z";
const past = "2026-09-01T12:00:00Z";
const account = (over: Partial<AccountInput> = {}): AccountInput => ({ email: "fan@example.com", role: "member", plan: "free", unlimited: false, access_expires_at: null, ...over });
const ok = (entitled: boolean, status = entitled ? "active" : "canceled", periodEnd: string | null = entitled ? future : past, cancel = false): LedgerRead =>
  ({ state: "ok", entitled, subscription: { plan: "monthly", status, current_period_end: periodEnd, cancel_at_period_end: cancel } });
const none: LedgerRead = { state: "ok", entitled: false, subscription: null };
const down: LedgerRead = { state: "unavailable" };

test("signed-out is free and never consults the ledger", () => {
  const a = decideUfcAccess(null, ok(true), NOW);
  assert.equal(a.pro, false);
  assert.equal(a.signedIn, false);
  assert.equal(needsLedger(null, NOW), false);
});

test("free account without entitlement is free", () => {
  const a = decideUfcAccess(account(), none, NOW);
  assert.deepEqual([a.tier, a.pro, a.signedIn], ["free", false, true]);
});

test("owner stays unlimited whatever the ledger says, including when it is down", () => {
  for (const acct of [account({ unlimited: true }), account({ role: "owner" }), account({ plan: "owner" })]) {
    for (const ledger of [none, down, ok(false)]) {
      const a = decideUfcAccess(acct, ledger, NOW);
      assert.deepEqual([a.tier, a.pro, a.source], ["owner", true, "owner"]);
    }
    assert.equal(needsLedger(acct, NOW), false);
  }
});

test("legacy UFC plan=pro stays Pro with no expiry or an unexpired one, even when the ledger is down", () => {
  for (const exp of [null, future]) {
    const a = decideUfcAccess(account({ plan: "pro", access_expires_at: exp }), down, NOW);
    assert.deepEqual([a.tier, a.pro, a.source, a.legacyAccessThrough], ["pro", true, "legacy", exp]);
  }
});

test("expired legacy Pro is free unless the ledger grants", () => {
  assert.equal(decideUfcAccess(account({ plan: "pro", access_expires_at: past }), none, NOW).pro, false);
  assert.equal(decideUfcAccess(account({ plan: "pro", access_expires_at: "not-a-date" }), none, NOW).pro, false);
  const both = decideUfcAccess(account({ plan: "pro", access_expires_at: past }), ok(true), NOW);
  assert.deepEqual([both.pro, both.source], [true, "stripe"]);
});

test("new ufc_pro entitlement (monthly or weekly) is Pro, with billing detail", () => {
  for (const plan of ["monthly", "weekly"]) {
    const ledger: LedgerRead = { state: "ok", entitled: true, subscription: { plan, status: "active", current_period_end: future, cancel_at_period_end: false } };
    const a = decideUfcAccess(account(), ledger, NOW);
    assert.deepEqual([a.tier, a.pro, a.source, a.subscription?.plan], ["pro", true, "stripe", plan]);
  }
});

test("the ledger's entitled boolean is authoritative: a row that looks active but is not entitled grants nothing", () => {
  const lookalike: LedgerRead = { state: "ok", entitled: false, subscription: { plan: "monthly", status: "active", current_period_end: future, cancel_at_period_end: false } };
  assert.equal(decideUfcAccess(account(), lookalike, NOW).pro, false);
});

test("cancel at period end stays Pro while entitled; past_due / canceled / expired are free", () => {
  assert.equal(decideUfcAccess(account(), ok(true, "active", future, true), NOW).pro, true);
  assert.equal(decideUfcAccess(account(), ok(false, "past_due", future), NOW).pro, false);
  assert.equal(decideUfcAccess(account(), ok(false, "canceled", past, true), NOW).pro, false);
});

test("ledger outage fails closed for Stripe-only customers", () => {
  const a = decideUfcAccess(account(), down, NOW);
  assert.deepEqual([a.pro, a.ledger], [false, "unavailable"]);
});

test("browser checkout query selects copy only and never grants", () => {
  const ret = parseCheckoutReturn({ checkout: "success", plan: "weekly", session_id: "cs_live_forged" });
  assert.deepEqual(ret, { success: true, plan: "weekly" });
  const free = decideUfcAccess(account(), none, NOW);
  assert.equal(free.pro, false, "query params are not an input to the decision");
  assert.equal(checkoutReturnState(ret, free), "verifying");
  assert.equal(checkoutReturnState(ret, decideUfcAccess(null, none, NOW)), "sign_in");
  assert.equal(checkoutReturnState(ret, decideUfcAccess(account(), ok(true), NOW)), "active");
  assert.deepEqual(parseCheckoutReturn({ checkout: "success", plan: "lifetime" }), { success: true, plan: null });
  assert.deepEqual(parseCheckoutReturn({ checkout: ["success", "x"], plan: ["monthly"] }), { success: true, plan: "monthly" });
  assert.equal(checkoutReturnState(parseCheckoutReturn({}), free), "not_returning");
});

test("unlock CTA: signed-out carries a safe return path, signed-in goes to /pro", () => {
  assert.equal(unlockHref({ signedIn: false }, "/fighters/jon-jones"), "/pro?next=%2Ffighters%2Fjon-jones");
  assert.equal(unlockHref({ signedIn: true }, "/fighters/jon-jones"), "/pro");
  assert.equal(unlockHref({ signedIn: false }, "//evil.example"), "/pro");
  assert.equal(unlockHref({ signedIn: false }, "https://evil.example"), "/pro");
  assert.equal(unlockHref({ signedIn: false }, null), "/pro");
});
