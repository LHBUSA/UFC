/**
 * Printful order submission. The write side, kept in its own file.
 *
 * lib/store/printful.ts exports no function capable of creating anything, and
 * that is a property other code depends on — the read-only canary states it
 * as a guarantee, and the guarantee is only true because the module it imports
 * has nothing to create with. Adding an order call there would quietly retire
 * that. So the writes live here, in a module imported by exactly one thing:
 * the fulfilment worker.
 *
 * Everything in this file is reachable only from a server-side path that has
 * already established, from the database, that a specific order was paid for
 * and is claimed by the caller. Nothing here validates that; it is not this
 * layer's job and pretending otherwise would encourage callers to skip it.
 *
 * On confirm: orders are created with `confirm: false`. That makes the
 * irreversible step explicit — the order lands at Printful as a draft, and
 * confirming it is a separate deliberate call. A create that also charges and
 * ships is a single request whose failure mode is a parcel.
 */
import "server-only";

const API = "https://api.printful.com";

export class ProviderWriteError extends Error {
  status: number;
  detail: string | null;
  /**
   * Whether the outcome was actually observed.
   *
   * The distinction this whole system is built around. A 422 is an observed
   * refusal: Printful read the request and said no, and nothing was created.
   * A timeout, a socket reset or a 502 is NOT observed — the order may exist.
   * The caller must record those differently, because one is retryable and
   * the other must be reconciled by lookup.
   */
  observed: boolean;
  constructor(status: number, message: string, detail: string | null, observed: boolean) {
    super(message);
    this.name = "ProviderWriteError";
    this.status = status;
    this.detail = detail;
    this.observed = observed;
  }
}

export function writeConfigured(): boolean {
  return Boolean(process.env.PRINTFUL_API_TOKEN);
}

function headers(storeId?: number): Record<string, string> {
  const token = process.env.PRINTFUL_API_TOKEN;
  if (!token) throw new ProviderWriteError(0, "PROVIDER_NOT_CONFIGURED", null, true);
  const h: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const pinned = storeId ?? (process.env.PRINTFUL_STORE_ID ? Number(process.env.PRINTFUL_STORE_ID) : undefined);
  if (pinned) h["x-pf-store-id"] = String(pinned);
  return h;
}

export type OrderItem = { variantId: number; quantity: number; fileUrl: string; name: string };
export type Recipient = {
  name: string;
  address1: string;
  address2?: string | null;
  city: string;
  stateCode?: string | null;
  countryCode: string;
  zip: string;
  email?: string | null;
};

/**
 * Create a draft order at the provider, carrying our external id.
 *
 * The external id is the thing that makes an unobserved outcome recoverable:
 * if this call times out, the order may exist, and `findByExternalId` can find
 * out. Without it the only way to check is to eyeball a list of orders, which
 * is not a thing an automated reconciliation can do.
 */
export async function createDraftOrder(args: {
  externalId: string;
  recipient: Recipient;
  items: OrderItem[];
  storeId?: number;
}): Promise<{ id: number; status: string }> {
  const body = {
    external_id: args.externalId,
    recipient: {
      name: args.recipient.name,
      address1: args.recipient.address1,
      address2: args.recipient.address2 || undefined,
      city: args.recipient.city,
      state_code: args.recipient.stateCode || undefined,
      country_code: args.recipient.countryCode,
      zip: args.recipient.zip,
      email: args.recipient.email || undefined,
    },
    items: args.items.map((i) => ({
      variant_id: i.variantId,
      quantity: i.quantity,
      name: i.name,
      files: [{ url: i.fileUrl }],
    })),
  };

  let res: Response;
  try {
    res = await fetch(`${API}/orders?confirm=false`, {
      method: "POST",
      headers: headers(args.storeId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    /* Never reached the point of an answer. The order may or may not exist,
     * and the only honest thing to say is that we do not know. */
    throw new ProviderWriteError(0, `order submission not observed: ${String((e as Error)?.message).slice(0, 120)}`, null, false);
  }

  const text = await res.text();
  if (!res.ok) {
    /* 4xx means Printful read it and refused: observed, and nothing created.
     * 5xx and 429 mean the request may have been processed before the failure:
     * not observed. */
    const observed = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new ProviderWriteError(res.status, `Printful ${res.status} creating order`, text.slice(0, 300), observed);
  }

  try {
    const parsed = JSON.parse(text) as { result?: { id?: number; status?: string } };
    const id = Number(parsed?.result?.id);
    if (!Number.isFinite(id)) {
      /* A 200 we cannot read is not a failure — it very likely created the
       * order. Unobserved, so it reconciles rather than retries. */
      throw new ProviderWriteError(res.status, "order created but the id could not be read", text.slice(0, 200), false);
    }
    return { id, status: String(parsed?.result?.status ?? "draft") };
  } catch (e) {
    if (e instanceof ProviderWriteError) throw e;
    throw new ProviderWriteError(res.status, "unparseable order response", text.slice(0, 200), false);
  }
}

/**
 * Find any order at the provider carrying our external id.
 *
 * Plural, because the provider is not documented to enforce uniqueness on
 * external_id and a guarantee nobody has observed is an assumption. Returning
 * every match lets the caller escalate on two rather than take the first and
 * never notice.
 */
export async function findOrdersByExternalId(
  externalId: string,
  storeId?: number,
): Promise<Array<{ id: number; status: string; external_id: string }>> {
  const res = await fetch(`${API}/orders?limit=100`, {
    headers: headers(storeId),
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderWriteError(res.status, `Printful ${res.status} listing orders`, text.slice(0, 200), true);
  }
  const parsed = JSON.parse(text) as { result?: Array<Record<string, unknown>> };
  return (parsed?.result || [])
    .filter((o) => String(o.external_id) === externalId)
    .map((o) => ({ id: Number(o.id), status: String(o.status ?? ""), external_id: String(o.external_id) }));
}
