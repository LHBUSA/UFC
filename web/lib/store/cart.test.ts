/**
 * Cart and checkout-input tests.
 *
 *   node --test web/lib/store/cart.test.ts
 *
 * The property under test throughout: a cart is a list of things somebody
 * wants, not a list of what they cost. Everything here is about what the
 * server must refuse when a request arrives that was written by hand rather
 * than produced by the page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINES,
  MAX_QTY,
  addLine,
  countUnits,
  lineKey,
  parseCart,
  setQty,
  subtotalCents,
  validateAgainstCatalog,
  launchSlugs,
} from "./cart.ts";
import { PRODUCTS, bySlug } from "./catalog.ts";

const TEE = "propbetedge-logo-tee";

test("a cart line carries no price, and a supplied one is discarded", () => {
  /* The single most important property in this file. If a price can ride in
   * on the request, the shop can be bought out for a cent. */
  const parsed = parseCart([
    { slug: TEE, size: "M", color: "Black", qty: 1, unit_price_cents: 1, price: 1, total: 1 },
  ]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["color", "qty", "size", "slug"]);

  const { ok } = validateAgainstCatalog(parsed);
  assert.equal(ok[0].unit_price_cents, bySlug(TEE)!.retail_price);
  assert.equal(ok[0].unit_price_cents, 3200);
});

test("parsing survives anything that could be in localStorage", () => {
  for (const junk of [null, undefined, "", "not json", "{}", 42, [], [null], [{}], [{ slug: TEE }]]) {
    assert.deepEqual(parseCart(junk as unknown), [], `${JSON.stringify(junk)} should parse to an empty cart`);
  }
  /* A stringified cart is the normal case: that is what localStorage holds. */
  assert.equal(parseCart(JSON.stringify([{ slug: TEE, size: "M", color: "Black", qty: 2 }])).length, 1);
});

test("quantities are clamped and duplicates collapse", () => {
  const parsed = parseCart([
    { slug: TEE, size: "M", color: "Black", qty: 999 },
    { slug: TEE, size: "M", color: "Black", qty: 3 },
    { slug: TEE, size: "L", color: "Black", qty: -4 },
    { slug: TEE, size: "S", color: "Black", qty: 1.7 },
  ]);
  assert.equal(parsed.length, 2, "the duplicate variant and the negative quantity are gone");
  assert.equal(parsed[0].qty, MAX_QTY);
  assert.equal(parsed[1].qty, 1, "1.7 floors to 1 rather than rounding up");
});

test("a cart cannot be grown without limit", () => {
  const many = Array.from({ length: MAX_LINES + 25 }, (_, i) => ({
    slug: TEE,
    size: "M",
    color: `Colour${i}`,
    qty: 1,
  }));
  assert.ok(parseCart(many).length <= MAX_LINES);

  let lines = parseCart(many);
  lines = addLine(lines, { slug: TEE, size: "XL", color: "Nope", qty: 1 });
  assert.ok(lines.length <= MAX_LINES, "addLine must not exceed the cap either");
});

test("only launch products can be bought, and the rest say why", () => {
  const unreleased = PRODUCTS.find((p) => p.status === "unreleased" && !p.blocked);
  assert.ok(unreleased, "expected a held-back design to exercise this");
  const { ok, problems } = validateAgainstCatalog([
    { slug: unreleased.slug, size: unreleased.sizes[0], color: unreleased.colors[0], qty: 1 },
  ]);
  assert.equal(ok.length, 0);
  assert.match(problems[0].reason, /launch collection/i);
});

test("a piece whose blank is unresolved can never enter a cart", () => {
  const blocked = PRODUCTS.find((p) => p.blocked);
  assert.ok(blocked);
  const { ok, problems } = validateAgainstCatalog([
    { slug: blocked.slug, size: blocked.sizes[0], color: blocked.colors[0], qty: 1 },
  ]);
  assert.equal(ok.length, 0);
  assert.equal(problems.length, 1);
  /* And the operational note never appears in what a customer is told. */
  assert.ok(!problems[0].reason.includes(blocked.blocked!.note));
});

test("sizes and colours must be ones we actually make", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["XXXXL", "Black", /size/i],
    ["M", "Neon Green", /Neon Green/],
  ];
  for (const [size, color, expected] of cases) {
    const { ok, problems } = validateAgainstCatalog([{ slug: TEE, size, color, qty: 1 }]);
    assert.equal(ok.length, 0, `${size}/${color} should be refused`);
    assert.match(problems[0].reason, expected);
  }
});

test("an unknown slug is refused rather than ignored", () => {
  const { ok, problems } = validateAgainstCatalog([{ slug: "free-money-tee", size: "M", color: "Black", qty: 1 }]);
  assert.equal(ok.length, 0);
  assert.match(problems[0].reason, /no such product/);
});

test("the launch collection is exactly the three briefed pieces", () => {
  assert.deepEqual(launchSlugs().sort(), ["propbetedge-hoodie", "propbetedge-logo-tee", "propbetedge-mug"]);
  for (const slug of launchSlugs()) {
    const def = bySlug(slug)!;
    assert.equal(def.collection, "propbetedge", `${slug} must be house-branded`);
    assert.equal(def.line, "house", `${slug} must sit in the house line`);
    assert.ok(!def.blocked, `${slug} must have a resolvable blank`);
  }
  /* Prices are part of the brief, so they are asserted rather than trusted. */
  assert.equal(bySlug("propbetedge-logo-tee")!.retail_price, 3200);
  assert.equal(bySlug("propbetedge-hoodie")!.retail_price, 6500);
  assert.equal(bySlug("propbetedge-mug")!.retail_price, 1900);
});

test("nothing was deleted to make the launch small", () => {
  assert.equal(PRODUCTS.length, 24, "held-back designs must stay in the catalog, keeping their slugs");
  assert.equal(PRODUCTS.filter((p) => p.status === "launch").length, 3);
  assert.equal(PRODUCTS.filter((p) => p.status === "unreleased").length, 21);
});

test("the launch pieces carry the house mark and no rights-holder lettering", () => {
  for (const slug of launchSlugs()) {
    const def = bySlug(slug)!;
    assert.equal(def.mark, "house");
    const text = `${def.name} ${def.blurb} ${def.description} ${def.art} ${(def.lines ?? []).join(" ")}`;
    assert.ok(!/\bUFC\b/.test(text), `${slug} puts "UFC" on the product`);
    for (const line of def.lines ?? []) {
      assert.match(line, /^PROPBETEDGE$/, `${slug} may only set our own wordmark`);
    }
  }
});

test("arithmetic on the cart is done in whole cents", () => {
  const lines = [
    { slug: TEE, size: "M", color: "Black", qty: 2 },
    { slug: "propbetedge-mug", size: "11 oz", color: "White", qty: 1 },
  ];
  const { ok } = validateAgainstCatalog(lines);
  assert.equal(ok.length, 2);
  assert.equal(subtotalCents(ok), 3200 * 2 + 1900);
  assert.ok(Number.isInteger(subtotalCents(ok)));
  assert.equal(countUnits(lines), 3);
});

test("quantity edits and removals behave", () => {
  let lines = [{ slug: TEE, size: "M", color: "Black", qty: 1 }];
  const key = lineKey(lines[0]);
  lines = setQty(lines, key, 4);
  assert.equal(lines[0].qty, 4);
  lines = setQty(lines, key, 500);
  assert.equal(lines[0].qty, MAX_QTY, "an edited quantity is clamped too");
  lines = setQty(lines, key, 0);
  assert.equal(lines.length, 0, "zero removes the line");
});
