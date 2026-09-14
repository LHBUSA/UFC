/* UFC magic-link request and verify, with every side effect injected so the
 * paid-only policy is provable in tests. The routes wire real dependencies.
 *
 * Request order (authorization happens BEFORE any token, account or email):
 *   validate email → throttle (email + fingerprint) → record attempt →
 *   owner? else billing entitlement (fail closed) → only then token + email.
 * Verify order:
 *   atomically consume token → RE-CHECK eligibility now → owner row, or create
 *   the member only with proof of a current entitlement → session.
 */
import {
  decideLoginEligibility, GENERIC_LOGIN_RESPONSE, isThrottled, normalizeAuthEmail, THROTTLE,
  type AuthAccount, type EntitlementRead,
} from "./authPolicy.ts";

export type EntitlementProof = { kind: "entitled"; email: string; checkedAt: string };

export type AuthDeps = {
  ownerEmail: string | undefined | null;
  hash(value: string): string;
  countRecentAttempts(q: { emailHash: string; fingerprintHash: string; sinceIso: string }): Promise<{ email: number; fingerprint: number }>;
  recordAttempt(a: { emailHash: string; fingerprintHash: string; outcome: string }): Promise<void>;
  findAccount(email: string): Promise<AuthAccount | null>;
  readEntitlement(email: string): Promise<EntitlementRead>;
  createLoginToken(email: string, nextPath: string, fingerprintHash: string): Promise<{ raw: string }>;
  sendLoginEmail(email: string, rawToken: string): Promise<void>;
  consumeLoginToken(raw: string): Promise<{ email: string; next_path: string | null } | null>;
  createEntitledMember(proof: EntitlementProof): Promise<AuthAccount>;
  createSession(account: AuthAccount, userAgent: string | null): Promise<{ raw: string }>;
  now(): number;
  log(event: string, detail?: Record<string, unknown>): void;
};

export type RequestResult =
  | { status: 400; body: { error: string } }
  | { status: 200; body: typeof GENERIC_LOGIN_RESPONSE; outcome: string };

export async function handleLoginRequest(deps: AuthDeps, input: { email: unknown; next: string; fingerprint: string }): Promise<RequestResult> {
  const email = normalizeAuthEmail(input.email);
  if (!email) return { status: 400, body: { error: "Enter a valid email address." } };
  const generic = (outcome: string) => ({ status: 200 as const, body: GENERIC_LOGIN_RESPONSE, outcome });

  const emailHash = deps.hash(`email:${email}`);
  const fingerprintHash = deps.hash(`fp:${input.fingerprint}`);
  let counts;
  try {
    counts = await deps.countRecentAttempts({ emailHash, fingerprintHash, sinceIso: new Date(deps.now() - THROTTLE.windowSeconds * 1000).toISOString() });
  } catch (error) {
    deps.log("auth.request.throttle_store_unavailable", { error: String((error as Error)?.message || error).slice(0, 120) });
    return generic("throttle_unavailable");
  }
  if (isThrottled(counts)) {
    deps.log("auth.request.throttled");
    return generic("throttled");
  }
  // The attempt is recorded before any decision, so denied emails count too.
  try { await deps.recordAttempt({ emailHash, fingerprintHash, outcome: "received" }); }
  catch { return generic("throttle_unavailable"); }

  const account = await deps.findAccount(email).catch(() => null);
  const ownerCheck = decideLoginEligibility({ email, account, ownerEmail: deps.ownerEmail, entitlement: null });
  const eligibility = ownerCheck.allowed
    ? ownerCheck
    : decideLoginEligibility({ email, account, ownerEmail: deps.ownerEmail, entitlement: await deps.readEntitlement(email).catch(() => ({ state: "unavailable" as const })) });

  if (!eligibility.allowed) {
    deps.log("auth.request.denied", { reason: eligibility.reason });
    return generic(`denied_${eligibility.reason}`);
  }

  const { raw } = await deps.createLoginToken(email, input.next, fingerprintHash);
  try {
    await deps.sendLoginEmail(email, raw);
  } catch (error) {
    deps.log("auth.request.send_failed", { error: String((error as Error)?.message || error).slice(0, 120) });
    return generic("send_failed");
  }
  deps.log("auth.request.sent", { kind: eligibility.kind });
  return generic(`sent_${eligibility.kind}`);
}

export type VerifyResult =
  | { ok: false; error: "expired" | "not_authorized" | "unavailable" }
  | { ok: true; sessionRaw: string; nextPath: string | null; kind: "owner" | "entitled" };

export async function handleLoginVerify(deps: AuthDeps, input: { rawToken: string; userAgent: string | null }): Promise<VerifyResult> {
  const token = await deps.consumeLoginToken(input.rawToken);
  if (!token) return { ok: false, error: "expired" };
  const email = normalizeAuthEmail(token.email);
  if (!email) return { ok: false, error: "expired" };

  const account = await deps.findAccount(email);
  const ownerCheck = decideLoginEligibility({ email, account, ownerEmail: deps.ownerEmail, entitlement: null });
  // A token issued while entitled is worthless once the entitlement is gone:
  // eligibility is decided again, now, before any account or session exists.
  const eligibility = ownerCheck.allowed
    ? ownerCheck
    : decideLoginEligibility({ email, account, ownerEmail: deps.ownerEmail, entitlement: await deps.readEntitlement(email).catch(() => ({ state: "unavailable" as const })) });
  if (!eligibility.allowed) {
    deps.log("auth.verify.denied", { reason: eligibility.reason });
    return { ok: false, error: "not_authorized" };
  }

  let sessionAccount: AuthAccount;
  if (eligibility.kind === "owner") {
    sessionAccount = account!;
  } else if (account) {
    sessionAccount = account;
  } else {
    sessionAccount = await deps.createEntitledMember({ kind: "entitled", email, checkedAt: new Date(deps.now()).toISOString() });
  }
  const session = await deps.createSession(sessionAccount, input.userAgent);
  deps.log("auth.verify.session", { kind: eligibility.kind });
  return { ok: true, sessionRaw: session.raw, nextPath: token.next_path, kind: eligibility.kind };
}
