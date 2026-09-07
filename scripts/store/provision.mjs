#!/usr/bin/env node
/**
 * The one authoritative provisioning path.
 *
 *   node scripts/store/provision.mjs --plan                 offline: what would happen
 *   node scripts/store/provision.mjs --reconcile            read provider, settle uncertain rows
 *   node scripts/store/provision.mjs --create --i-mean-it   actually create (both flags required)
 *
 * Nothing else in either repository may create a product at the provider. The
 * web apps cannot: lib/store/printful.ts exports no create function. This
 * script is the only writer, and it is not a deploy step — it is run
 * deliberately, by a person, against the durable claim in store_provisioning.
 *
 * ---------------------------------------------------------------------------
 * Why a committed lock file is not enough
 *
 * A catalog.lock.json records what one build believed. Two deployments read
 * the same file, both see a slug absent, and both create. So do two runs of
 * this script started a second apart, and so does one run retried after a
 * timeout. The lock file is a useful snapshot for the storefront to read; it
 * is not a mutual-exclusion primitive and cannot be made into one.
 *
 * The authority is a row, claimed atomically:
 *
 *   store_claim_slug(slug, attempt_id, claimed_by) -> row | null
 *
 * A row comes back only to the caller that won it. Null means the row exists
 * and was not takeable, and the caller must then look at why.
 *
 * ---------------------------------------------------------------------------
 * The state that actually matters is UNCERTAIN
 *
 * The dangerous failure is not a request that fails. It is a request whose
 * outcome we never learn: a socket closed mid-flight, a 502 from an edge in
 * front of the provider, a function killed at its timeout. The product may
 * exist. Retrying is how the duplicate gets made.
 *
 * So every unobserved outcome is written as 'uncertain', and 'uncertain' is
 * excluded from the claim query at the database level. It cannot be retried.
 * It must first be RECONCILED: ask the provider what actually exists, and
 * move the row forward only on something we observed.
 *
 * ---------------------------------------------------------------------------
 * external_id is a lookup key, not a uniqueness guarantee
 *
 * Printful accepts an external_id on a sync product, and it is tempting to
 * lean on it as an idempotency key. The documentation does not promise that a
 * second create carrying the same external_id is refused, and a guarantee we
 * have not observed is an assumption, not a control. It may well behave that
 * way; until that has been tested deliberately, this design does not depend
 * on it.
 *
 * What it depends on instead:
 *   - the claim, which lets exactly one caller act on a slug at a time;
 *   - reconciliation, which never retries an unobserved outcome;
 *   - a unique index on (provider, provider_product_id), so even if the
 *     provider cheerfully creates a second product under the same
 *     external_id, that second id cannot be recorded and the run fails loudly
 *     with both ids in hand.
 *
 * findByExternalId therefore returns every match, plural, so a duplicate is
 * detected rather than silently taking the first.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import process from "node:process";

const argv = new Set(process.argv.slice(2));
const PLAN = argv.has("--plan");
const RECONCILE = argv.has("--reconcile");
/* Two flags, deliberately. One is easy to leave in a shell history. */
const CREATE = argv.has("--create") && argv.has("--i-mean-it");
const WANTED_CREATE = argv.has("--create");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PRINTFUL_TOKEN = process.env.PRINTFUL_API_TOKEN || "";
const WHO = `${os.hostname()}/${process.pid}`;

const log = (...a) => console.log(...a);
/* Aborting by throwing rather than calling process.exit: an exit() from
 * inside an async call stack tears the event loop down while a socket is
 * still closing, and libuv asserts on Windows. What an operator should see is
 * the message, not a native assertion printed underneath it. */
class Abort extends Error {}
const fail = (msg) => {
  throw new Abort(msg);
};

/* ---- provider (read + the single create) --------------------------------- */

const PF = "https://api.printful.com";

function pfHeaders() {
  if (!PRINTFUL_TOKEN) fail("PRINTFUL_API_TOKEN is not set in this environment.");
  const h = { authorization: `Bearer ${PRINTFUL_TOKEN}`, "content-type": "application/json" };
  if (process.env.PRINTFUL_STORE_ID) h["x-pf-store-id"] = String(process.env.PRINTFUL_STORE_ID);
  return h;
}

/**
 * Every provider call returns one of three things, never a thrown string:
 * an observed success, an observed failure, or UNCERTAIN.
 *
 * The classification is the whole safety property, so it is written once,
 * here, rather than at each call site. A timeout, an aborted socket or a
 * gateway error is uncertain: the request may have been executed. A 4xx is an
 * observed refusal — the provider processed it and said no.
 */
async function pf(path, { method = "GET", body, timeoutMs = 25_000 } = {}) {
  let res;
  try {
    res = await fetch(`${PF}${path}`, {
      method,
      headers: pfHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { outcome: "uncertain", error: `${e.name}: ${String(e.message).slice(0, 160)}` };
  }
  const text = await res.text().catch(() => "");
  if (res.status === 429 || res.status >= 500) {
    /* The provider may have applied the write before failing to tell us. */
    return { outcome: "uncertain", error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  if (!res.ok) return { outcome: "failed", error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  try {
    return { outcome: "ok", data: JSON.parse(text) };
  } catch {
    /* A 200 we cannot parse means the write probably happened and we cannot
     * describe it. That is uncertainty, not failure. */
    return { outcome: "uncertain", error: `unparseable 200 from ${path}` };
  }
}

async function listSyncProducts() {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await pf(`/store/products?limit=100&offset=${offset}`);
    if (r.outcome !== "ok") return r;
    const page = r.data?.result || [];
    out.push(...page.map((p) => ({ id: Number(p.id), external_id: p.external_id ?? null, name: p.name ?? "" })));
    const total = r.data?.paging?.total;
    if (page.length < 100 || (typeof total === "number" && out.length >= total)) break;
  }
  return { outcome: "ok", data: out };
}

const matchesExternalId = (products, slug) => products.filter((p) => String(p.external_id) === String(slug));

/* ---- provisioning state -------------------------------------------------- */

function sbHeaders(extra = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return {
    apikey: SUPABASE_KEY,
    authorization: `Bearer ${SUPABASE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: sbHeaders(prefer ? { Prefer: prefer } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status} on ${path}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const claim = (slug, attemptId) =>
  sb("rpc/store_claim_slug", { method: "POST", body: { p_slug: slug, p_attempt_id: attemptId, p_claimed_by: WHO } });

const readRow = async (slug) => {
  const rows = await sb(`store_provisioning?slug=eq.${encodeURIComponent(slug)}&select=*`);
  return rows?.[0] ?? null;
};

/**
 * Release a claim with an outcome.
 *
 * The attempt_id is part of the filter, so a caller whose claim has already
 * expired and been taken by someone else cannot overwrite the new holder's
 * work. Without that check a slow run coming back from the dead would stamp
 * its stale result over a completed one.
 */
const release = (slug, attemptId, patch) =>
  sb(
    `store_provisioning?slug=eq.${encodeURIComponent(slug)}&attempt_id=eq.${attemptId}`,
    { method: "PATCH", body: { ...patch, updated_at: new Date().toISOString() }, prefer: "return=representation" },
  );

/* ---- reconciliation ------------------------------------------------------ */

/**
 * Settle rows whose outcome was never observed, using the provider as the
 * only source of truth.
 *
 * Three findings, three moves:
 *   exactly one match  -> 'created', recording the id we found
 *   no match           -> 'failed', which makes the slug claimable again
 *   more than one      -> left 'uncertain' and reported, because a duplicate
 *                         at the provider is a human decision, not a state
 *                         transition. Deleting the wrong one is not something
 *                         a script should choose.
 */
async function reconcile(rows, syncProducts) {
  const report = [];
  for (const row of rows) {
    const hits = matchesExternalId(syncProducts, row.slug);
    if (hits.length === 1) {
      await sb(`store_provisioning?slug=eq.${encodeURIComponent(row.slug)}`, {
        method: "PATCH",
        body: {
          state: "created",
          provider_product_id: hits[0].id,
          attempt_id: null,
          reconciled_at: new Date().toISOString(),
          reconcile_note: `adopted existing sync product ${hits[0].id} found by external_id`,
          updated_at: new Date().toISOString(),
        },
      });
      report.push({ slug: row.slug, from: row.state, to: "created", note: `adopted ${hits[0].id}` });
    } else if (hits.length === 0) {
      await sb(`store_provisioning?slug=eq.${encodeURIComponent(row.slug)}`, {
        method: "PATCH",
        body: {
          state: "failed",
          attempt_id: null,
          reconciled_at: new Date().toISOString(),
          reconcile_note: "no sync product carries this external_id; safe to retry",
          updated_at: new Date().toISOString(),
        },
      });
      report.push({ slug: row.slug, from: row.state, to: "failed", note: "nothing exists; retryable" });
    } else {
      report.push({
        slug: row.slug,
        from: row.state,
        to: row.state,
        note: `AMBIGUOUS: ${hits.length} sync products carry this external_id (${hits.map((h) => h.id).join(", ")}) — resolve by hand`,
      });
    }
  }
  return report;
}

/* ---- main ---------------------------------------------------------------- */

const main = async () => {
  const { PRODUCTS } = await import("../../web/lib/store/catalog.ts");

  log("PropBetEdge store — provisioning\n");
  log(`catalog: ${PRODUCTS.length} products`);
  log(`mode:    ${PLAN ? "plan (offline)" : RECONCILE ? "reconcile" : CREATE ? "CREATE" : "inspect"}\n`);

  if (WANTED_CREATE && !CREATE) {
    fail("--create also requires --i-mean-it. Nothing was contacted.");
  }

  if (PLAN) {
    /* Offline. Shows what the run would touch without a credential in sight,
     * which is the only mode that is useful before provisioning is enabled. */
    for (const p of PRODUCTS) {
      log(`  ${p.slug.padEnd(34)} ${p.form.padEnd(7)} ${p.sizes.length}×${p.colors.length} variants  [${p.sites.join(", ")}]`);
    }
    log(`\nNothing was contacted. ${PRODUCTS.length} slugs would be claimed one at a time.`);
    return;
  }

  const rows = await sb("store_provisioning?select=*");
  const byslug = new Map((rows || []).map((r) => [r.slug, r]));
  const counts = {};
  for (const r of rows || []) counts[r.state] = (counts[r.state] || 0) + 1;
  log(`provisioning rows: ${rows?.length ?? 0}${Object.keys(counts).length ? ` (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(", ")})` : ""}`);
  for (const p of PRODUCTS) if (!byslug.has(p.slug)) log(`  unclaimed (no row): ${p.slug}`);

  const uncertain = (rows || []).filter((r) => r.state === "uncertain" || (r.state === "in_flight" && Date.parse(r.claimed_at || 0) < Date.now() - 10 * 60_000));

  if (RECONCILE || uncertain.length) {
    if (!uncertain.length) {
      log("\nnothing to reconcile: no uncertain or stale in-flight rows.");
    } else {
      log(`\nreconciling ${uncertain.length} row(s) against the provider…`);
      const list = await listSyncProducts();
      if (list.outcome !== "ok") fail(`cannot reconcile: provider unreadable (${list.error}). Nothing was changed.`);
      for (const r of await reconcile(uncertain, list.data)) {
        log(`  ${r.slug.padEnd(34)} ${r.from} -> ${r.to}  ${r.note}`);
      }
    }
  }

  if (!CREATE) {
    log("\nNo product was created. Pass --create --i-mean-it to enable creation.");
    log("Creation stays disabled until the print assets have been validated against");
    log("the provider's real print areas, which the read-only canary reports.");
    return;
  }

  /* ---- creation ---------------------------------------------------------
   * Reached only with both flags. Even here, the order of operations is the
   * safety property: claim, re-check the provider under the claim, create,
   * and write the observed outcome — with an unobserved one recorded as
   * uncertain so the next run reconciles rather than retries. */
  fail(
    "Creation is not enabled in this build.\n" +
      "  The provisioning state machine, the claim and reconciliation are in place and\n" +
      "  exercised, but no product has been created and the create call is deliberately\n" +
      "  absent until the live canary has reported real print areas and the assets have\n" +
      "  been regenerated against them.",
  );
};

main().catch((e) => {
  if (e instanceof Abort) console.error(`\n✖ ${e.message}\n`);
  else console.error("FATAL", e);
  process.exitCode = 1;
});
