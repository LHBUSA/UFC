/** /api/store/fulfill — submit already-paid orders to Printful as drafts. */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  adoptExisting, claimForSubmission, expireStaleSubmissions, fulfillableOrders,
  getOrderById, markSubmitFailed, markSubmitted, markSubmitUncertain, ordersConfigured,
} from "@/lib/store/orders";
import {
  createDraftOrder, findOrdersByExternalId, ProviderWriteError, writeConfigured, type OrderItem,
} from "@/lib/store/printful-orders";
import { liveBySlug } from "@/lib/store/live-products";
import { DROP001_SLUG, drop001ArtFiles } from "@/lib/store/release";
import {
  FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG, TALE_OF_TAPE_HOODIE_SLUG,
  PBE_CLASSIC_HAT_SLUG, TRUST_DATA_MUG_SLUG, isReleaseLine,
} from "@/lib/store/release-policy";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function bearerMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) { timingSafeEqual(b, b); return false; }
  return timingSafeEqual(a, b);
}
function presentedBearer(req: Request): string { return String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""); }
function authorize(req: Request, expected: string | undefined): boolean {
  const presented = presentedBearer(req);
  return Boolean(expected && presented && bearerMatches(presented, expected));
}

function releaseFiles(slug: string, origin: string): { files?: OrderItem["files"]; fileUrl?: string; missing?: string[] } {
  if (slug === DROP001_SLUG) {
    const release = drop001ArtFiles();
    if (!release.ready) return { missing: release.missing };
    return { files: [{ type: "front", url: release.front }, { type: "sleeve_right", url: release.sleeve }] };
  }
  if (slug === FIGHT_DNA_TEE_SLUG) return { fileUrl: `${origin}/store/print/drop002-fight-dna-tee-front` };
  if (slug === PBE_MUG_SLUG) return { fileUrl: `${origin}/store/print/drop002-pbe-mug-wrap` };
  if (slug === TALE_OF_TAPE_HOODIE_SLUG) return { files: [{ type: "front", url: `${origin}/store/print/drop003-tale-of-the-tape-hoodie-front` }] };
  if (slug === PBE_CLASSIC_HAT_SLUG) return { files: [{ type: "embroidery_front_large", url: `${origin}/store/print/drop003-pbe-hat-front` }] };
  if (slug === TRUST_DATA_MUG_SLUG) return { fileUrl: `${origin}/store/print/drop003-trust-the-data-mug-wrap` };
  return { missing: ["no released production artwork"] };
}

async function runFulfillment(req: Request) {
  if (!ordersConfigured()) return json({ error: "ORDERS_NOT_CONFIGURED" }, 503);
  if (!writeConfigured()) return json({ error: "PROVIDER_NOT_CONFIGURED" }, 503);
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const origin = (process.env.STORE_PUBLIC_ORIGIN || SITE.url).replace(/\/$/, "");
  const worker = `fulfill@${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local"}`;
  const report: Array<Record<string, unknown>> = [];
  const expired = await expireStaleSubmissions();
  const queue = await fulfillableOrders(10);

  for (const row of queue) {
    const full = await getOrderById(row.id);
    if (!full) continue;
    const { order, lines } = full;
    const items: OrderItem[] = [];
    const missing: string[] = [];
    for (const l of lines) {
      const def = liveBySlug(l.slug);
      if (!def || typeof l.provider_variant_id !== "number") { missing.push(`${l.slug} ${l.size}/${l.color}: no provider variant recorded`); continue; }
      if (!isReleaseLine(l.slug, l.size, l.color)) { missing.push(`${l.slug} ${l.size}/${l.color}: not in the active release`); continue; }
      const art = releaseFiles(l.slug, origin);
      if (art.missing?.length) { missing.push(`${l.slug}: final production art not released (${art.missing.join(", ")})`); continue; }
      items.push({ variantId: l.provider_variant_id, quantity: l.quantity, name: `${def.name} (${l.size} / ${l.color})`, ...(art.files ? { files: art.files } : { fileUrl: art.fileUrl! }) });
    }
    if (missing.length || !items.length) { report.push({ order: order.public_token, action: "refused", reasons: missing }); continue; }
    if (!order.ship_line1 || !order.ship_city || !order.ship_country || !order.ship_postal) { report.push({ order: order.public_token, action: "refused", reasons: ["incomplete shipping address"] }); continue; }
    if (dry) { report.push({ order: order.public_token, action: "would submit draft", external_id: order.external_id, items: items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity, name: i.name, files: i.files || (i.fileUrl ? [{ url: i.fileUrl }] : []) })) }); continue; }
    const claim = await claimForSubmission(order.id, worker);
    if (!claim) { report.push({ order: order.public_token, action: "not claimable", state: order.state }); continue; }
    try {
      const created = await createDraftOrder({ externalId: order.external_id, recipient: { name: order.ship_name || "Customer", address1: order.ship_line1, address2: order.ship_line2, city: order.ship_city, stateCode: order.ship_state, countryCode: order.ship_country, zip: order.ship_postal, email: order.email }, items });
      await markSubmitted(order.id, claim.attemptId, created.id);
      report.push({ order: order.public_token, action: "submitted as draft", provider_order_id: created.id, status: created.status });
    } catch (e) {
      const err = e instanceof ProviderWriteError ? e : null;
      const detail = err ? `HTTP ${err.status}: ${String(err.detail || err.message).slice(0, 200)}` : String((e as Error)?.message).slice(0, 200);
      if (err?.observed) { await markSubmitFailed(order.id, claim.attemptId, detail); report.push({ order: order.public_token, action: "refused by provider", detail }); }
      else { await markSubmitUncertain(order.id, claim.attemptId, detail); report.push({ order: order.public_token, action: "uncertain", detail }); }
    }
  }
  const reconciled: Array<Record<string, unknown>> = [];
  if (!dry) for (const row of expired) {
    try {
      const matches = await findOrdersByExternalId(row.external_id);
      if (matches.length === 1) { await adoptExisting(row.id, matches[0].id); reconciled.push({ order: row.public_token, action: "adopted", provider_order_id: matches[0].id }); }
      else if (matches.length > 1) reconciled.push({ order: row.public_token, action: "ESCALATE", matches: matches.map((m) => m.id) });
      else reconciled.push({ order: row.public_token, action: "still absent", note: "absence is not proof; leave uncertain" });
    } catch (e) { reconciled.push({ order: row.public_token, action: "lookup failed", detail: String((e as Error)?.message).slice(0, 160) }); }
  }
  return json({ ran_at: new Date().toISOString(), dry_run: dry, confirm_manufacturing: false, expired_stale_claims: expired.length, considered: queue.length, results: report, reconciled });
}

export async function POST(req: Request) {
  const gate = process.env.STORE_FULFILL_TOKEN || process.env.CRON_SECRET;
  if (!gate) return json({ error: "FULFILMENT_NOT_ENABLED" }, 503);
  if (!authorize(req, gate)) return json({ error: "unauthorized" }, 401);
  return runFulfillment(req);
}
export async function GET(req: Request) {
  const gate = process.env.CRON_SECRET;
  if (!gate) return json({ error: "CRON_NOT_ENABLED" }, 503);
  if (!authorize(req, gate)) return json({ error: "unauthorized" }, 401);
  return runFulfillment(req);
}
