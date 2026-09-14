import test from "node:test";
import assert from "node:assert/strict";
import {
  decideUfcAccess, needsLedger, parseCheckoutReturn, checkoutReturnState, unlockHref,
  type AccountInput, type LedgerRead,
} from "./accessDecision.ts";

const OWNER = "owner@propbetedge.example";
const future = "2026-10-14T12:00:00Z";
const past = "2026-09-01T12:00:00Z";
const account = (over: Partial<AccountInput> = {}): AccountInput => ({ email: "fan@example.com", role: "member", plan: "free", unlimited: false, access_expires_at: null, ...over });
const ownerRow = (over: Partial<AccountInput> = {}) => account({ email: OWNER, role: "owner", plan: "owner", unlimited: true, ...over });
const ok = (entitled: boolean, status = entitled ? "active" : "canceled", periodEnd: string | null = entitled ? future : past, cancel = false): LedgerRead =>
  ({ state: "ok", entitled, subscription: { plan: "monthly", status, current_period_end: periodEnd, cancel_at_period_end: cancel } });
const none: LedgerRead = { state: "ok", entitled: false, subscription: null };
const down: LedgerRead = { state: "unavailable" };

test("signed-out is free and never consults the ledger", () => {
  const a = decideUfcAccess(null, ok(true), OWNER);
  assert.equal(a.pro, false);
  assert.equal(a.signedIn, false);
  assert.equal(needsLedger(null, OWNER), false);
});

test("a free account is NOT a session: signed out, and revoked when the ledger positively says not entitled", () => {
  const a = decideUfcAccess(account(), none, OWNER);
  assert.deepEqual([a.tier, a.pro, a.signedIn, a.revokeSession], ["free", false, false, true]);
});

test("canonical owner stays unlimited whatever the ledger says, including when it is down", () => {
  for (const ledger of [none, down, ok(false)]) {
    const a = decideUfcAccess(ownerRow(), ledger, OWNER);
    assert.deepEqual([a.tier, a.pro, a.signedIn, a.source, a.revokeSession], ["owner", true, true, "owner", false]);
  }
  assert.equal(needsLedger(ownerRow(), OWNER), false);
});

test("owner flags on any other email, or with no configured owner, grant nothing", () => {
  for (const acct of [account({ unlimited: true }), account({ role: "owner" }), account({ plan: "owner" }), account({ role: "owner", plan: "owner", unlimited: true })]) {
    const a = decideUfcAccess(acct, none, OWNER);
    assert.deepEqual([a.pro, a.signedIn], [false, false], JSON.stringify(acct));
  }
  assert.equal(decideUfcAccess(ownerRow(), none, undefined).pro, false);
  assert.equal(decideUfcAccess(ownerRow({ unlimited: false }), none, OWNER).pro, false);
});

test("legacy ufc_accounts.plan=pro grants nothing, with or without expiry", () => {
  for (const exp of [null, future, past]) {
    const a = decideUfcAccess(account({ plan: "pro", access_expires_at: exp }), none, OWNER);
    assert.deepEqual([a.pro, a.signedIn], [false, false]);
  }
});

test("new ufc_pro entitlement (monthly or weekly) is Pro, with billing detail", () => {
  for (const plan of ["monthly", "weekly"]) {
    const ledger: LedgerRead = { state: "ok", entitled: true, subscription: { plan, status: "active", current_period_end: future, cancel_at_period_end: false } };
    const a = decideUfcAccess(account(), ledger, OWNER);
    assert.deepEqual([a.tier, a.pro, a.signedIn, a.source, a.subscription?.plan], ["pro", true, true, "stripe", plan]);
  }
});

test("the ledger's entitled boolean is authoritative: a row that looks active but is not entitled grants nothing", () => {
  const lookalike: LedgerRead = { state: "ok", entitled: false, subscription: { plan: "monthly", status: "active", current_period_end: future, cancel_at_period_end: false } };
  assert.equal(decideUfcAccess(account(), lookalike, OWNER).pro, false);
});

test("cancel at period end stays Pro while entitled; past_due / canceled / expired lose the session", () => {
  assert.equal(decideUfcAccess(account(), ok(true, "active", future, true), OWNER).pro, true);
  for (const l of [ok(false, "past_due", future), ok(false, "canceled", past, true)]) {
    const a = decideUfcAccess(account(), l, OWNER);
    assert.deepEqual([a.pro, a.signedIn, a.revokeSession], [false, false, true]);
  }
});

test("ledger outage fails closed for subscribers but never deletes their session", () => {
  const a = decideUfcAccess(account(), down, OWNER);
  assert.deepEqual([a.pro, a.signedIn, a.revokeSession, a.ledger], [false, false, false, "unavailable"]);
});

test("browser checkout query selects copy only and never grants", () => {
  const ret = parseCheckoutReturn({ checkout: "success", plan: "weekly", session_id: "cs_live_forged" });
  assert.deepEqual(ret, { success: true, plan: "weekly" });
  const free = decideUfcAccess(account(), none, OWNER);
  assert.equal(free.pro, false, "query params are not an input to the decision");
  assert.equal(checkoutReturnState(ret, free), "sign_in");
  assert.equal(checkoutReturnState(ret, decideUfcAccess(null, none, OWNER)), "sign_in");
  assert.equal(checkoutReturnState(ret, decideUfcAccess(account(), ok(true), OWNER)), "active");
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
