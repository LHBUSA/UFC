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
import test from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_PUBLIC_KEYS, formatPrice, toStorefront, variantKey, type ProvisionRecord } from "./types.ts";
import { PRODUCTS, bySlug, productsFor } from "./catalog.ts";

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
