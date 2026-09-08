/**
 * Printful order submission. The write side, kept separate from the read-only
 * catalog client. Orders are ALWAYS created with confirm=false so manufacturing
 * is a second deliberate step after we inspect the first real order.
 */
import "server-only";

const API = "https://api.printful.com";

export class ProviderWriteError extends Error {
  status: number;
  detail: string | null;
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

export type OrderPrintFile = {
  url: string;
  /** Printful placement key, e.g. front or sleeve_right. Omitted only for
   * legacy one-file products where the provider has exactly one default. */
  type?: string;
  position?: { area_width?: number; area_height?: number; width?: number; height?: number; top?: number; left?: number };
};

export type OrderItem = {
  variantId: number;
  quantity: number;
  name: string;
  /** Legacy single-file form, retained for tee/mug compatibility. */
  fileUrl?: string;
  /** Placement-aware files. Drop 001 hoodie uses front + sleeve_right. */
  files?: OrderPrintFile[];
};

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

function itemFiles(item: OrderItem): OrderPrintFile[] {
  if (item.files?.length) return item.files;
  if (item.fileUrl) return [{ url: item.fileUrl }];
  return [];
}

export async function createDraftOrder(args: {
  externalId: string;
  recipient: Recipient;
  items: OrderItem[];
  storeId?: number;
}): Promise<{ id: number; status: string }> {
  const invalid = args.items.find((i) => !itemFiles(i).length);
  if (invalid) throw new ProviderWriteError(0, `NO_PRINT_FILE: ${invalid.name}`, null, true);

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
      files: itemFiles(i).map((f) => ({
        url: f.url,
        ...(f.type ? { type: f.type } : {}),
        ...(f.position ? { position: f.position } : {}),
      })),
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
    throw new ProviderWriteError(0, `order submission not observed: ${String((e as Error)?.message).slice(0, 120)}`, null, false);
  }

  const text = await res.text();
  if (!res.ok) {
    const observed = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new ProviderWriteError(res.status, `Printful ${res.status} creating order`, text.slice(0, 300), observed);
  }

  try {
    const parsed = JSON.parse(text) as { result?: { id?: number; status?: string } };
    const id = Number(parsed?.result?.id);
    if (!Number.isFinite(id)) {
      throw new ProviderWriteError(res.status, "order created but the id could not be read", text.slice(0, 200), false);
    }
    return { id, status: String(parsed?.result?.status ?? "draft") };
  } catch (e) {
    if (e instanceof ProviderWriteError) throw e;
    throw new ProviderWriteError(res.status, "unparseable order response", text.slice(0, 200), false);
  }
}

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
