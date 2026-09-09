/**
 * The cart, as a shape and a set of rules.
 *
 * Deliberately free of both React and the network, so the rules can be tested
 * directly and so the browser and the server run the same ones. Only one of
 * those two is trusted: the browser's copy exists to render a sensible cart
 * and to stop obvious mistakes early, and the server re-runs every check from
 * scratch on a request it assumes was written by hand.
 *
 * What a cart line carries is the smallest thing that identifies a product:
 * slug, size, colour, quantity. No price. A cart that carries a price is a
 * cart that can be edited to carry a different one, and every checkout bug
 * worth having ever heard of starts there. Prices are looked up from the
 * catalog on the server at the moment the session is created; the number the
 * browser shows is a courtesy, not an input.
 */
/* Explicit .ts extensions: Node's test runner resolves TypeScript by exact
 * specifier, and these are value imports, so they survive type stripping and
 * have to resolve at runtime. tsconfig sets allowImportingTsExtensions, and
 * noEmit means this affects type checking only, never what ships. */
import { bySlug } from "./catalog.ts";
import { ACTIVE_RELEASE_SLUGS, isActiveReleaseSlug, releaseLineAllowed, releaseSpec } from "./release-policy.ts";
import { formatPrice } from "./types.ts";

export const CART_STORAGE_KEY = "pbe.store.cart.v1";
/** Per line. Small on purpose: this is a print-on-demand shop, not a wholesaler. */
export const MAX_QTY = 10;
/** Distinct lines, not units. Enough for a real order, low enough that a
 * scripted cart cannot make the checkout route do unbounded work. */
export const MAX_LINES = 20;

export type CartLine = { slug: string; size: string; color: string; qty: number };

export type ResolvedLine = {
  line: CartLine;
  name: string;
  /** Cents, from the catalog. Server-resolved wherever it matters. */
  unit_price_cents: number;
  image: string;
};

export type CartProblem = { line: CartLine; reason: string };

export function lineKey(l: Pick<CartLine, "slug" | "size" | "color">): string {
  return `${l.slug}::${l.size}::${l.color}`;
}

/**
 * Parse whatever came out of localStorage or off the wire.
 *
 * Everything is treated as hostile: the stored value may be from an older
 * version of this file, hand-edited, or simply absent. Anything that does not
 * parse into the expected shape is dropped rather than repaired, because a
 * repaired cart line is a guess about what somebody wanted to buy.
 */
export function parseCart(raw: unknown): CartLine[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: CartLine[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_LINES * 2)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? r.slug : "";
    const size = typeof r.size === "string" ? r.size : "";
    const color = typeof r.color === "string" ? r.color : "";
    const qty = Math.floor(Number(r.qty));
    if (!slug || !size || !color) continue;
    if (!Number.isFinite(qty) || qty < 1) continue;
    const key = lineKey({ slug, size, color });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, size, color, qty: Math.min(qty, MAX_QTY) });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/**
 * Check every line against the authored catalog AND the active release gate.
 *
 * The permanent catalog can contain unreleased concepts and legacy launch
 * pieces. Neither is a promise that checkout accepts them. `release-policy`
 * is the narrow customer-facing allowlist: today it is the black premium
 * hoodie, black Fight DNA tee, and black 11 oz PBE mug.
 */
export function validateAgainstCatalog(
  lines: readonly CartLine[],
  site: "ufc" | "news" = "ufc",
): { ok: ResolvedLine[]; problems: CartProblem[] } {
  const ok: ResolvedLine[] = [];
  const problems: CartProblem[] = [];

  if (lines.length > MAX_LINES) {
    return { ok: [], problems: [{ line: lines[0], reason: `a cart may hold at most ${MAX_LINES} lines` }] };
  }

  for (const line of lines) {
    const def = bySlug(line.slug);
    if (!def) {
      problems.push({ line, reason: "no such product" });
      continue;
    }
    if (!def.sites.includes(site)) {
      problems.push({ line, reason: "not sold on this storefront" });
      continue;
    }
    if (def.blocked) {
      problems.push({ line, reason: `${def.name} is not on sale yet` });
      continue;
    }
    if (!isActiveReleaseSlug(line.slug)) {
      problems.push({ line, reason: `${def.name} is not in the current release` });
      continue;
    }
    if (!releaseLineAllowed(line)) {
      const spec = releaseSpec(line.slug)!;
      problems.push({
        line,
        reason: `${def.name} is offered only as ${spec.sizes.join("/")} in ${spec.colors.join("/")}`,
      });
      continue;
    }
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) {
      problems.push({ line, reason: `quantity must be between 1 and ${MAX_QTY}` });
      continue;
    }
    ok.push({
      line,
      name: def.name,
      /* From the catalog. This is the only place a price ever comes from. */
      unit_price_cents: def.retail_price,
      image: def.art,
    });
  }
  return { ok, problems };
}

/** Item subtotal in cents. Shipping and tax are Stripe's to compute and are
 * never guessed here. */
export function subtotalCents(resolved: readonly ResolvedLine[]): number {
  return resolved.reduce((sum, r) => sum + r.unit_price_cents * r.line.qty, 0);
}

export function formatSubtotal(resolved: readonly ResolvedLine[]): string {
  return formatPrice(subtotalCents(resolved));
}

export function countUnits(lines: readonly CartLine[]): number {
  return lines.reduce((n, l) => n + l.qty, 0);
}

/** Add or merge, keeping quantities inside the cap rather than rejecting. */
export function addLine(lines: readonly CartLine[], add: CartLine): CartLine[] {
  const key = lineKey(add);
  const next = lines.map((l) => ({ ...l }));
  const hit = next.find((l) => lineKey(l) === key);
  if (hit) {
    hit.qty = Math.min(MAX_QTY, hit.qty + add.qty);
    return next;
  }
  if (next.length >= MAX_LINES) return next;
  next.push({ ...add, qty: Math.min(MAX_QTY, add.qty) });
  return next;
}

export function setQty(lines: readonly CartLine[], key: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => lineKey(l) !== key);
  return lines.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(MAX_QTY, Math.floor(qty)) } : l));
}

/** Slugs the currently orderable release offers, for pruning stale carts. */
export function launchSlugs(): string[] {
  return [...ACTIVE_RELEASE_SLUGS];
}
