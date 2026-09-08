/**
 * Store contract tests.
 *
 *   node --test web/lib/store/store.test.ts
 *
 * Run under Node's native type stripping, so these exercise the same modules
 * the app imports rather than a transpiled copy that could drift from them.
 *
 * The point of this file is one property: nothing operational reaches a page.
 * Everything else here is scaffolding around that.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_PUBLIC_KEYS, formatPrice, toStorefront, variantKey, type ProvisionRecord } from "./types.ts";
import { LINES, PRODUCTS, bySlug, productsFor, provisionable } from "./catalog.ts";
import { IMAGE_VERSION, imagePath, toneFor } from "./art.ts";

const IMG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "store", "img");
import { MAX_SKEW_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign, signedPayload, verifySignedRequest } from "./signing.ts";

const NOW = Date.parse("2026-09-07T12:00:00Z");

const created = (over: Partial<ProvisionRecord> = {}): ProvisionRecord => ({
  slug: "propbetedge-logo-tee",
  state: "created",
  provider_store_id: 111,
  provider_product_id: 222,
  provider_variant_ids: { "M / Black": 4012 },
  provider_costs: { "M / Black": 1340 },
  print_areas: { front: { width: 1800, height: 2400 } },
  reconciled_at: null,
  reconcile_note: null,
  last_error: "boom",
  attempts: 1,
  updated_at: "2026-09-07T00:00:00Z",
  ...over,
});

test("the storefront projection carries no provider or operational field", () => {
  const def = bySlug("propbetedge-logo-tee");
  assert.ok(def);
  const pub = toStorefront(def, created());
  const keys = Object.keys(pub);
  for (const forbidden of FORBIDDEN_PUBLIC_KEYS) {
    assert.ok(!keys.includes(forbidden), `projection leaked ${forbidden}`);
  }
  /* Belt and braces: the serialised form is what actually ships in the HTML,
   * so assert against the string, not just the key list. */
  const wire = JSON.stringify(pub);
  assert.ok(!wire.includes("4012"), "a provider variant id reached the wire");
  assert.ok(!wire.includes("1340"), "a provider cost reached the wire");
  assert.ok(!wire.includes("boom"), "an operational error string reached the wire");
});

test("a product is purchasable only when the provider confirmed it", () => {
  const def = bySlug("propbetedge-logo-tee");
  assert.ok(def);
  assert.equal(toStorefront(def, created()).purchasable, true);

  /* Every other state, including uncertain, must not offer to sell. */
  for (const state of ["unclaimed", "in_flight", "failed", "uncertain"] as const) {
    const p = toStorefront(def, created({ state }));
    assert.equal(p.purchasable, false, `${state} must not be purchasable`);
    assert.ok(p.unavailable_reason, `${state} must explain itself`);
  }

  /* Marked created but with nothing to point at: still not purchasable. */
  assert.equal(toStorefront(def, created({ provider_product_id: null })).purchasable, false);
  assert.equal(toStorefront(def, created({ provider_variant_ids: {} })).purchasable, false);
  assert.equal(toStorefront(def, null).purchasable, false);
});

test("an uncertain product reads as being confirmed, not as unavailable", () => {
  const def = bySlug("propbetedge-logo-tee");
  assert.ok(def);
  const p = toStorefront(def, created({ state: "uncertain" }));
  assert.match(p.unavailable_reason ?? "", /confirm/i);
});

test("slugs are unique and stable-looking", () => {
  const seen = new Set<string>();
  for (const p of PRODUCTS) {
    assert.ok(!seen.has(p.slug), `duplicate slug ${p.slug}`);
    seen.add(p.slug);
    assert.match(p.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `slug ${p.slug} is not kebab-case`);
  }
});

test("the shared set is exactly ten slugs, and nothing new has joined it", () => {
  /* This file is served to another site's shop. A new `sites: [ufc, news]`
   * product does not just appear here, it appears there, on a shelf whose
   * owner never agreed to it. Widening the shared set is a decision for both
   * sites; asserting the count makes taking it by accident impossible. */
  const shared = PRODUCTS.filter((p) => p.sites.includes("news"));
  assert.equal(shared.length, 10, `the shared set changed: ${shared.map((p) => p.slug).join(", ")}`);
});

test("a piece whose blank is unresolved can never be purchasable", () => {
  /* The strongest property in this file. A blocked piece should have no
   * provisioning row at all, but a row written by hand, or left behind when a
   * blank was set aside, must not be able to put it on sale: the authored
   * decision wins over the recorded state. */
  const blocked = PRODUCTS.filter((p) => p.blocked);
  assert.ok(blocked.length > 0, "expected at least one set-aside blank to exercise this");
  for (const def of blocked) {
    const p = toStorefront(def, created({ slug: def.slug }));
    assert.equal(p.purchasable, false, `${def.slug} was purchasable despite an unresolved blank`);
    assert.equal(p.awaiting_blank, true, `${def.slug} must say why`);
    assert.ok(p.unavailable_reason, `${def.slug} must explain itself`);
  }
});

test("the operational reason a blank was set aside never reaches a page", () => {
  /* `note` names the printer's suppliers and the shape of our catalog search.
   * `public` is the sentence a reader gets. They are separate fields so this
   * can be asserted rather than remembered. */
  for (const def of PRODUCTS) {
    if (!def.blocked) continue;
    const wire = JSON.stringify(toStorefront(def, null));
    assert.ok(!wire.includes(def.blocked.note), `${def.slug} leaked the operational block note`);
    assert.ok(wire.includes(def.blocked.public), `${def.slug} did not carry its reader-facing reason`);
  }
});

test("provisioning walks a narrower list than the shop displays", () => {
  /* The shop shows a set-aside piece and says why. Provisioning must not see
   * it at all: an unresolved blank one forgotten branch away from a create
   * call is how the wrong garment gets printed. */
  const offered = provisionable().map((p) => p.slug);
  const shown = productsFor("ufc").map((p) => p.slug);
  for (const def of PRODUCTS) {
    if (!def.blocked) continue;
    assert.ok(!offered.includes(def.slug), `${def.slug} is provisionable despite an unresolved blank`);
    assert.ok(shown.includes(def.slug), `${def.slug} should still be displayed, with its reason`);
  }
  assert.ok(offered.length > 0 && offered.length < PRODUCTS.length);
});

test("every product has a mark, a line with a section to sit in, and copy for it", () => {
  const sections = new Set(LINES.map((l) => l.key));
  for (const p of PRODUCTS) {
    assert.ok(p.mark, `${p.slug} has no mark`);
    assert.ok(sections.has(p.line), `${p.slug} is in line "${p.line}", which no section renders`);
    for (const line of p.lines ?? []) {
      assert.ok(line.trim().length > 0, `${p.slug} carries an empty type line`);
    }
  }
  /* Each section must actually have something in it, or the shop renders a
   * heading over nothing. */
  for (const l of LINES) {
    assert.ok(PRODUCTS.some((p) => p.line === l.key), `section "${l.key}" is empty`);
  }
});

test("all four forms are offered, and every design family covers more than one", () => {
  const forms = new Set(PRODUCTS.map((p) => p.form));
  for (const f of ["tee", "hoodie", "cap", "mug"] as const) assert.ok(forms.has(f), `no ${f} in the catalog`);
  for (const l of LINES) {
    const inLine = PRODUCTS.filter((p) => p.line === l.key);
    assert.ok(new Set(inLine.map((p) => p.form)).size > 1, `line "${l.key}" is only one form`);
  }
});

test("the preview tone follows the colourway, and the print file name agrees", () => {
  /* A preview showing gold type on a garment we only sell in white is a
   * preview of a product that does not exist. The -ink / -gold suffix on the
   * print file is the same claim written down twice, so it is checked against
   * the colours rather than trusted. */
  for (const p of PRODUCTS) {
    const tone = toneFor(p.colors);
    const claimsInk = p.art.includes("-ink");
    assert.equal(
      tone === "light",
      claimsInk,
      `${p.slug}: lead colour "${p.colors[0]}" gives ${tone}, but the print file is named ${p.art}`,
    );
  }
});

test("every product has its committed preview image, and no orphans are left behind", () => {
  /* The images are committed rather than built, so the bytes a reviewer sees
   * are the bytes that ship. That only holds if somebody actually ran
   * scripts/store/build_images.mjs after editing the catalog, which is
   * exactly the step a person forgets. */
  const onDisk = new Set(fs.readdirSync(IMG_DIR).filter((f) => f.endsWith(".svg")));
  const expected = new Set(PRODUCTS.map((p) => path.basename(imagePath(p.slug))));
  for (const want of expected) {
    assert.ok(onDisk.has(want), `missing preview image ${want} — run scripts/store/build_images.mjs`);
  }
  for (const got of onDisk) {
    assert.ok(expected.has(got), `orphaned preview image ${got} — run scripts/store/build_images.mjs`);
  }
});

test("the ten shared slugs the news-site store already defines are present and shared", () => {
  /* These strings are the join between the two storefronts. If one drifts,
   * that site provisions a second product at the provider instead of reusing
   * the existing one, so the list is asserted literally. */
  const shared = [
    "propbetedge-logo-tee",
    "propbetedge-hoodie",
    "propbetedge-hat",
    "propbetedge-mug",
    "trust-the-data-tee",
    "no-vibes-just-variance-tee",
    "my-model-said-no-tee",
    "spreadsheet-for-this-mug",
    "fight-dna-tee",
    "fight-dna-over-fight-takes-tee",
  ];
  for (const slug of shared) {
    const p = bySlug(slug);
    assert.ok(p, `shared slug missing: ${slug}`);
    assert.ok(p.sites.includes("news") && p.sites.includes("ufc"), `${slug} must be featured on both storefronts`);
  }
});

test("the UFC collection is featured here and not on the news site", () => {
  const ufcOnly = PRODUCTS.filter((p) => p.sites.length === 1 && p.sites[0] === "ufc");
  assert.ok(ufcOnly.length >= 4, "expected a UFC-specific collection");
  for (const p of ufcOnly) assert.equal(p.collection, "ufc");
});

test("every product this storefront lists has sane commercial fields", () => {
  for (const p of productsFor("ufc")) {
    assert.ok(p.retail_price > 0 && Number.isInteger(p.retail_price), `${p.slug} price must be whole cents`);
    assert.ok(p.sizes.length > 0, `${p.slug} has no sizes`);
    assert.ok(p.colors.length > 0, `${p.slug} has no colours`);
    assert.ok(p.description.length > 40, `${p.slug} needs real copy`);
  }
});

test("no product artwork claims a rights-holder's marks", () => {
  /* The site reports on the sport; merchandise carrying a promotion's marks
   * would need a licence we do not have. Copy is checked as well as art. */
  for (const p of PRODUCTS) {
    const text = `${p.name} ${p.blurb} ${p.art}`;
    assert.ok(!/\bUFC\b/.test(text), `${p.slug} puts "UFC" on the product`);
    assert.ok(!/octagon/i.test(p.art), `${p.slug} art references the octagon trademark`);
  }
});

test("price formatting drops a trailing .00 and keeps real cents", () => {
  assert.equal(formatPrice(3200), "$32");
  assert.equal(formatPrice(1950), "$19.50");
  assert.equal(variantKey("M", "Black"), "M / Black");
});

/* ---- shared-catalog signing --------------------------------------------- */

test("a correctly signed request verifies, and a tampered one does not", async () => {
  const secret = "test-secret-not-a-real-one";
  const ts = String(NOW);
  const path = "/api/catalog/products?site=news";
  const sig = await sign(secret, signedPayload(ts, "GET", path));

  const req = (over: Record<string, string> = {}, p = path) =>
    new Request(`https://ufc.propbetedge.ai${p}`, {
      headers: { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: `sha256=${sig}`, ...over },
    });

  assert.deepEqual(await verifySignedRequest(req(), path, secret, NOW), { ok: true });

  /* A signature captured for one path must not work on another, or one
   * endpoint's signature becomes every endpoint's. */
  const other = await verifySignedRequest(req({}, "/api/catalog/other"), "/api/catalog/other", secret, NOW);
  assert.equal(other.ok, false);

  /* Wrong secret, flipped digest, and a missing header all refuse. */
  assert.equal((await verifySignedRequest(req(), path, "different-secret", NOW)).ok, false);
  assert.equal((await verifySignedRequest(req({ [SIGNATURE_HEADER]: `sha256=${"0".repeat(64)}` }), path, secret, NOW)).ok, false);
  assert.equal((await verifySignedRequest(new Request(`https://x${path}`), path, secret, NOW)).ok, false);
});

test("an old signature stops working, in both directions", async () => {
  const secret = "test-secret-not-a-real-one";
  const path = "/api/catalog/products";
  for (const offset of [MAX_SKEW_MS + 1000, -(MAX_SKEW_MS + 1000)]) {
    const ts = String(NOW + offset);
    const sig = await sign(secret, signedPayload(ts, "GET", path));
    const req = new Request(`https://ufc.propbetedge.ai${path}`, {
      headers: { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: sig },
    });
    const r = await verifySignedRequest(req, path, secret, NOW);
    assert.equal(r.ok, false, `offset ${offset} should be outside the window`);
    assert.match(r.ok === false ? r.reason : "", /window/);
  }
});

test("a missing secret refuses as misconfiguration, not as a bad caller", async () => {
  /* 401 would send whoever is debugging after the wrong problem. */
  const r = await verifySignedRequest(new Request("https://x/api/catalog/products"), "/api/catalog/products", undefined, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 503);
});

test("image URLs are versioned, so a URL handed to another site stays valid", () => {
  const def = bySlug("propbetedge-logo-tee");
  assert.ok(def);
  const p = toStorefront(def, null, "https://ufc.propbetedge.ai");
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].url, `https://ufc.propbetedge.ai/store/img/propbetedge-logo-tee-${IMAGE_VERSION}.svg`);
  assert.match(p.images[0].url, /-v\d+\.svg$/);
  assert.ok(p.images[0].width > 0 && p.images[0].height > 0, "dimensions must be declared to avoid layout shift");
  /* Never a provider mockup link: those expire, and a permanent contract
   * cannot be built on a URL with a lifetime. */
  assert.ok(!/printful|cdn\.printful/i.test(p.images[0].url));
});
