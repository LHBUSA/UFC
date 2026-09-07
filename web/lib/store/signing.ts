/**
 * Request signing for the shared catalog.
 *
 * A shared secret rather than a bearer, because what needs authenticating is
 * a *request*, not a session. A bearer sent to the wrong host is a stolen
 * credential; a signature over the method, path and timestamp is worthless
 * anywhere else and expires on its own.
 *
 * The signed string covers:
 *   timestamp . method . path-with-query
 *
 * The path is included so a signature captured for /api/catalog/products
 * cannot be replayed against a different endpoint that happens to share the
 * secret. The timestamp is included and enforced so a captured signature is
 * useful for minutes rather than forever.
 *
 * This is not a replay *prevention* — within the window the same request can
 * be repeated — and it does not need to be: the endpoint is a read. Making it
 * single-use would mean shared nonce state between two deployments to protect
 * a request that returns a product catalogue.
 */

export const SIGNATURE_HEADER = "x-pbe-signature";
export const TIMESTAMP_HEADER = "x-pbe-timestamp";
/** Generous enough for ordinary clock drift, short enough that a captured
 * signature is not a lasting credential. */
export const MAX_SKEW_MS = 5 * 60_000;

export function signedPayload(timestamp: string, method: string, pathWithQuery: string): string {
  return `${timestamp}.${method.toUpperCase()}.${pathWithQuery}`;
}

/** Hex HMAC-SHA256. Node's webcrypto, so this works in any runtime we deploy to. */
export async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent constant-time compare over the hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    /* Still burn a comparison so a wrong-length forgery is not measurably
     * cheaper than a wrong-value one. */
    let sink = 0;
    for (let i = 0; i < b.length; i += 1) sink |= b.charCodeAt(i) ^ b.charCodeAt(i);
    return sink === -1;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type VerifyResult = { ok: true } | { ok: false; status: 401 | 503; reason: string };

/**
 * Verify an inbound signed request.
 *
 * Missing secret is 503, not 401: the endpoint is misconfigured rather than
 * the caller being wrong, and reporting it as an auth failure would send
 * whoever is debugging it after the wrong problem. It still refuses.
 */
export async function verifySignedRequest(
  req: Request,
  pathWithQuery: string,
  secret: string | undefined,
  now = Date.now(),
): Promise<VerifyResult> {
  if (!secret) return { ok: false, status: 503, reason: "CATALOG_SHARED_SECRET is not configured on this deployment" };

  const ts = req.headers.get(TIMESTAMP_HEADER) || "";
  const presented = (req.headers.get(SIGNATURE_HEADER) || "").replace(/^sha256=/i, "");
  if (!ts || !presented) return { ok: false, status: 401, reason: "missing signature headers" };

  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, status: 401, reason: "malformed timestamp" };
  if (Math.abs(now - t) > MAX_SKEW_MS) return { ok: false, status: 401, reason: "timestamp outside the accepted window" };

  const expected = await sign(secret, signedPayload(ts, req.method, pathWithQuery));
  if (!safeEqualHex(presented.toLowerCase(), expected)) return { ok: false, status: 401, reason: "signature mismatch" };
  return { ok: true };
}
