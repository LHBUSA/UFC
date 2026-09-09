/**
 * The cart, as a shape and a set of rules.
 *
 * The browser never carries price as authority. Every checkout line is
 * resolved again against our authored live catalog on the server.
 */
import { liveBySlug } from "./live-products.ts";
import { ACTIVE_RELEASE_SLUGS, isActiveReleaseSlug, releaseLineAllowed, releaseSpec } from "./release-policy.ts";
import { formatPrice } from "./types.ts";

export const CART_STORAGE_KEY = "pbe.store.cart.v1";
export const MAX_QTY = 10;
export const MAX_LINES = 20;

export type CartLine = { slug: string; size: string; color: string; qty: number };

export type ResolvedLine = {
  line: CartLine;
  name: string;
  unit_price_cents: number;
  image: string;
};

export type CartProblem = { line: CartLine; reason: string };

export function lineKey(l: Pick<CartLine, "slug" | "size" | "color">): string {
  return `${l.slug}::${l.size}::${l.color}`;
}

export function parseCart(raw: unknown): CartLine[] {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return []; }
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
    if (!slug || !size || !color || !Number.isFinite(qty) || qty < 1) continue;
    const key = lineKey({ slug, size, color });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, size, color, qty: Math.min(qty, MAX_QTY) });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

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
    const def = liveBySlug(line.slug);
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
      problems.push({ line, reason: `${def.name} is offered only as ${spec.sizes.join("/")} in ${spec.colors.join("/")}` });
      continue;
    }
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) {
      problems.push({ line, reason: `quantity must be between 1 and ${MAX_QTY}` });
      continue;
    }
    ok.push({ line, name: def.name, unit_price_cents: def.retail_price, image: def.art });
  }
  return { ok, problems };
}

export function subtotalCents(resolved: readonly ResolvedLine[]): number {
  return resolved.reduce((sum, r) => sum + r.unit_price_cents * r.line.qty, 0);
}

export function formatSubtotal(resolved: readonly ResolvedLine[]): string {
  return formatPrice(subtotalCents(resolved));
}

export function countUnits(lines: readonly CartLine[]): number {
  return lines.reduce((n, l) => n + l.qty, 0);
}

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

export function launchSlugs(): string[] {
  return [...ACTIVE_RELEASE_SLUGS];
}
