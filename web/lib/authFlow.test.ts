/* Paid-only UFC auth: NO PAID UFC ENTITLEMENT = NO LOGIN EMAIL, NO ACCOUNT,
 * NO SESSION, NO PRO. OWNER = THE ONLY EXCEPTION. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { handleLoginRequest, handleLoginVerify, type AuthDeps } from "./authFlow.ts";
import { GENERIC_LOGIN_RESPONSE, THROTTLE, decideLoginEligibility, isCanonicalOwner } from "./authPolicy.ts";
import { decideUfcAccess, parseCheckoutReturn, checkoutReturnState } from "./accessDecision.ts";

const OWNER = "owner@propbetedge.example";
type Acct = { id: string; email: string; role: string; plan: string; unlimited: boolean };

function world(opts: { entitled?: Record<string, boolean>; billingDown?: boolean; ownerEmail?: string | null } = {}) {
  let clock = Date.parse("2026-09-14T21:00:00Z");
  const accounts = new Map<string, Acct>([[OWNER, { id: "acct_owner", email: OWNER, role: "owner", plan: "owner", unlimited: true }]]);
  const tokens = new Map<string, { email: string; next_path: string; expires: number; used: boolean }>();
  const sessions: Array<{ accountId: string; raw: string }> = [];
  const attempts: Array<{ emailHash: string; fingerprintHash: string; at: number }> = [];
  const sent: string[] = [];
  const entitled = { ...(opts.entitled || {}) };
  const calls = { entitlementReads: 0, memberCreates: 0 };
  const deps: AuthDeps = {
    ownerEmail: opts.ownerEmail === undefined ? OWNER : opts.ownerEmail,
    hash: (v) => createHash("sha256").update(v).digest("hex"),
    async countRecentAttempts(q) {
      const since = Date.parse(q.sinceIso);
      return { email: attempts.filter((a) => a.emailHash === q.emailHash && a.at >= since).length, fingerprint: attempts.filter((a) => a.fingerprintHash === q.fingerprintHash && a.at >= since).length };
    },
    async recordAttempt(a) { attempts.push({ ...a, at: clock }); },
    async findAccount(email) { return accounts.get(email) || null; },
    async readEntitlement(email) {
      calls.entitlementReads += 1;
      if (opts.billingDown) return { state: "unavailable" };
      return { state: "ok", entitled: entitled[email] === true };
    },
    async createLoginToken(email, next) { const raw = randomBytes(24).toString("base64url"); tokens.set(raw, { email, next_path: next, expires: clock + 15 * 60_000, used: false }); return { raw }; },
    async sendLoginEmail(email) { sent.push(email); },
    async consumeLoginToken(raw) { const t = tokens.get(raw); if (!t || t.used || t.expires <= clock) return null; t.used = true; return { email: t.email, next_path: t.next_path }; },
    async createEntitledMember(proof) {
      assert.equal(proof.kind, "entitled");
      calls.memberCreates += 1;
      const a = { id: `acct_${accounts.size}`, email: proof.email, role: "member", plan: "free", unlimited: false };
      accounts.set(proof.email, a); return a;
    },
    async createSession(account) { const raw = randomBytes(24).toString("base64url"); sessions.push({ accountId: account.id, raw }); return { raw }; },
    now: () => clock,
    log: () => {},
  };
  const lastToken = () => [...tokens.keys()].at(-1)!;
  return { deps, accounts, tokens, sessions, attempts, sent, entitled, calls, lastToken, advance: (ms: number) => { clock += ms; } };
}

let ipSeq = 0;
const req = (w: ReturnType<typeof world>, email: string, fingerprint = `ip-${++ipSeq}`) => handleLoginRequest(w.deps, { email, next: "/account", fingerprint });
function assertNothingCreated(w: ReturnType<typeof world>) {
  assert.equal(w.sent.length, 0, "no Resend call");
  assert.equal(w.tokens.size, 0, "no login token");
  assert.equal(w.accounts.size, 1, "no account beyond the owner");
  assert.equal(w.sessions.length, 0, "no session");
}

test("random valid email → generic 200, zero Resend call, zero token, zero account, zero session", async () => {
  const w = world();
  const r = await req(w, "Random.Person+x@gmail.com");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, GENERIC_LOGIN_RESPONSE);
  assertNothingCreated(w);
});

test("nonexistent email → identical public response", async () => {
  const w = world();
  const a = await req(w, "nobody-at-all@nowhere.example");
  const b = await req(w, OWNER);
  assert.deepEqual(a.body, b.body, "owner and unknown email are indistinguishable publicly");
  assert.equal(a.status, b.status);
  assert.equal(w.accounts.size, 1);
});

test("invalid email syntax is a 400 with nothing created", async () => {
  const w = world();
  assert.equal((await req(w, "not-an-email")).status, 400);
  assertNothingCreated(w);
});

test("owner → email sent, token valid, session created on the existing owner row", async () => {
  const w = world();
  await req(w, ` ${OWNER.toUpperCase()} `);
  assert.deepEqual(w.sent, [OWNER]);
  assert.equal(w.calls.entitlementReads, 0, "owner needs no billing hop");
  const v = await handleLoginVerify(w.deps, { rawToken: w.lastToken(), userAgent: "ua" });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.kind, "owner");
  assert.equal(w.sessions[0].accountId, "acct_owner");
  assert.equal(w.calls.memberCreates, 0);
});

test("owner exception needs BOTH the configured owner email and the owner row", () => {
  const ownerRow = { id: "o", email: OWNER, role: "owner", plan: "owner", unlimited: true };
  assert.equal(isCanonicalOwner(OWNER, ownerRow, OWNER), true);
  assert.equal(isCanonicalOwner(OWNER, ownerRow, null), false, "no configured owner → no exception");
  assert.equal(isCanonicalOwner(OWNER, { ...ownerRow, role: "member" }, OWNER), false);
  assert.equal(isCanonicalOwner(OWNER, { ...ownerRow, unlimited: false }, OWNER), false);
  assert.equal(isCanonicalOwner("impostor@x.example", { ...ownerRow, email: "impostor@x.example" }, OWNER), false, "an owner-flagged row under another email is not the owner");
  assert.equal(isCanonicalOwner(OWNER, null, OWNER), false);
});

test("owner request is denied when UFC_OWNER_EMAIL is not configured (fail closed)", async () => {
  const w = world({ ownerEmail: null, billingDown: true });
  await req(w, OWNER);
  assertNothingCreated(w);
});

test("active UFC entitlement → email sent, member created only now, login succeeds", async () => {
  const w = world({ entitled: { "fan@example.com": true } });
  await req(w, "fan@example.com");
  assert.deepEqual(w.sent, ["fan@example.com"]);
  assert.equal(w.accounts.size, 1, "requesting a link creates no account");
  const v = await handleLoginVerify(w.deps, { rawToken: w.lastToken(), userAgent: null });
  assert.equal(v.ok && v.kind, "entitled");
  assert.equal(w.calls.memberCreates, 1);
  assert.equal(w.sessions.length, 1);
});

test("cancel_at_period_end inside the paid period is entitled (the ledger RPC decides); login allowed", async () => {
  // pbe_has_sport_entitlement returns true for active + future period end regardless of cancel_at_period_end.
  const w = world({ entitled: { "leaving@example.com": true } });
  await req(w, "leaving@example.com");
  assert.equal(w.sent.length, 1);
});

for (const [label, email] of [["past_due", "late@example.com"], ["canceled", "gone@example.com"], ["expired", "lapsed@example.com"], ["cross-sport (NBA only)", "nba-fan@example.com"]] as const) {
  test(`${label} → the ledger says not entitled → denied, nothing created`, async () => {
    const w = world({ entitled: { [email]: false } });
    const r = await req(w, email);
    assert.deepEqual(r.body, GENERIC_LOGIN_RESPONSE);
    assertNothingCreated(w);
  });
}

test("billing Worker unavailable → denied for everyone but the owner", async () => {
  const w = world({ entitled: { "fan@example.com": true }, billingDown: true });
  await req(w, "fan@example.com");
  assertNothingCreated(w);
  await req(w, OWNER);
  assert.deepEqual(w.sent, [OWNER]);
});

test("forged checkout=success / session_id grant nothing: they are not inputs to auth or access", async () => {
  const w = world();
  // The request handler has no parameter for them; a forged body field is ignored.
  const r = await handleLoginRequest(w.deps, { email: "forger@example.com", next: "/pro?checkout=success&plan=monthly&session_id=cs_live_forged", fingerprint: "ip-forge" });
  assert.deepEqual(r.body, GENERIC_LOGIN_RESPONSE);
  assertNothingCreated(w);
  const signedOut = decideUfcAccess(null, { state: "ok", entitled: true, subscription: null }, OWNER);
  const ret = parseCheckoutReturn({ checkout: "success", plan: "monthly", session_id: "cs_live_forged" });
  assert.equal(signedOut.pro, false);
  assert.equal(checkoutReturnState(ret, signedOut), "sign_in");
  const v = await handleLoginVerify(w.deps, { rawToken: "cs_live_forged", userAgent: null });
  assert.deepEqual(v, { ok: false, error: "expired" });
});

test("stale, reused and unknown magic tokens → denied", async () => {
  const w = world();
  await req(w, OWNER);
  const raw = w.lastToken();
  assert.equal((await handleLoginVerify(w.deps, { rawToken: raw, userAgent: null })).ok, true);
  assert.deepEqual(await handleLoginVerify(w.deps, { rawToken: raw, userAgent: null }), { ok: false, error: "expired" }, "reuse");
  await req(w, OWNER, "ip-owner-2");
  w.advance(15 * 60_000 + 1);
  assert.deepEqual(await handleLoginVerify(w.deps, { rawToken: w.lastToken(), userAgent: null }), { ok: false, error: "expired" }, "stale");
  assert.deepEqual(await handleLoginVerify(w.deps, { rawToken: "never-issued", userAgent: null }), { ok: false, error: "expired" });
  assert.equal(w.sessions.length, 1);
});

test("entitlement removed between request and verify → denied, no account, no session", async () => {
  const w = world({ entitled: { "fan@example.com": true } });
  await req(w, "fan@example.com");
  assert.equal(w.sent.length, 1);
  w.entitled["fan@example.com"] = false; // subscription deleted after the email went out
  const v = await handleLoginVerify(w.deps, { rawToken: w.lastToken(), userAgent: null });
  assert.deepEqual(v, { ok: false, error: "not_authorized" });
  assert.equal(w.accounts.size, 1);
  assert.equal(w.sessions.length, 0);
});

test("billing outage between request and verify → denied", async () => {
  const w = world({ entitled: { "fan@example.com": true } });
  await req(w, "fan@example.com");
  const raw = w.lastToken();
  w.deps.readEntitlement = async () => ({ state: "unavailable" });
  assert.deepEqual(await handleLoginVerify(w.deps, { rawToken: raw, userAgent: null }), { ok: false, error: "not_authorized" });
  assert.equal(w.sessions.length, 0);
});

test("repeated arbitrary-email requests are throttled per fingerprint without billing or Resend work", async () => {
  const w = world({ entitled: { "fan@example.com": true } });
  for (let i = 0; i < THROTTLE.perFingerprint; i += 1) await req(w, `spray${i}@example.com`, "ip-attacker");
  const readsBefore = w.calls.entitlementReads;
  const r = await req(w, "fan@example.com", "ip-attacker");
  assert.equal(r.status === 200 && r.outcome, "throttled");
  assert.equal(w.calls.entitlementReads, readsBefore, "throttled request never reaches billing");
  assert.equal(w.sent.length, 0, "not even an entitled address gets mail from a throttled source");
  assert.deepEqual(r.body, GENERIC_LOGIN_RESPONSE);
});

test("repeated requests for one email are throttled across rotating IPs", async () => {
  const w = world();
  for (let i = 0; i < THROTTLE.perEmail; i += 1) await req(w, OWNER, `rot-${i}`);
  assert.equal(w.sent.length, THROTTLE.perEmail);
  const r = await req(w, OWNER, "rot-new");
  assert.equal(r.status === 200 && r.outcome, "throttled");
  assert.equal(w.sent.length, THROTTLE.perEmail);
  w.advance(THROTTLE.windowSeconds * 1000 + 1);
  await req(w, OWNER, "rot-later");
  assert.equal(w.sent.length, THROTTLE.perEmail + 1, "window expires");
});

test("throttle store failure fails closed (generic, nothing sent)", async () => {
  const w = world();
  w.deps.countRecentAttempts = async () => { throw new Error("db down"); };
  const r = await req(w, OWNER);
  assert.equal(r.status === 200 && r.outcome, "throttle_unavailable");
  assert.equal(w.sent.length, 0);
});

test("owner remains unaffected by the paid-only rule", () => {
  const ownerRow = { id: "acct_owner", email: OWNER, role: "owner", plan: "owner", unlimited: true, access_expires_at: null };
  for (const ledger of [{ state: "unavailable" as const }, { state: "ok" as const, entitled: false, subscription: null }]) {
    const a = decideUfcAccess(ownerRow, ledger, OWNER);
    assert.deepEqual([a.tier, a.pro, a.signedIn, a.revokeSession], ["owner", true, true, false]);
  }
  assert.deepEqual(decideLoginEligibility({ email: OWNER, account: ownerRow, ownerEmail: OWNER, entitlement: { state: "unavailable" } }), { allowed: true, kind: "owner" });
});
