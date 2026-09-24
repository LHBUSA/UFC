/* UFC primary navigation contract (lib/site.ts NAV + navFor):
 *   desktop bar order, Store in More, All Access out of the bar, and the
 *   Fight Simulator slot reserved but never rendered while its route is
 *   pending (no dead link). The preservation check enforces the route side. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { NAV, navFor } from "./site.ts";

register("../scripts/test-tsx-hooks.mjs", import.meta.url);

const web = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, web), "utf8");

test("desktop primary order: Fight Week, PBE PICKS, FIGHT SIMULATOR, Schedule, Fighters, Rankings, News", () => {
  assert.deepEqual(navFor("primary").map((n) => n.label), ["Fight Week", "PBE PICKS", "FIGHT SIMULATOR", "Schedule", "Fighters", "Rankings", "News"]);
  assert.ok(!NAV.some((n) => n.pending), "no pending slot remains in the registry");
});

test("Fight Simulator ships: route exists, LABS badge, flagship treatment, primary (never More); pending items would still be filtered", () => {
  const sim = NAV.find((n) => n.href === "/simulator");
  assert.ok(sim);
  assert.equal(sim!.pending, undefined);
  assert.equal(sim!.badge, "LABS");
  assert.equal(sim!.flagship, true);
  assert.equal(sim!.place, "primary");
  assert.ok(existsSync(fileURLToPath(new URL("app/simulator/page.tsx", web))), "the route exists (the preservation check refuses a rendered nav item without a page)");
  assert.ok(navFor("primary").some((n) => n.href === "/simulator"));
  assert.ok(!navFor("more").some((n) => n.href === "/simulator"));
  /* The pending mechanism stays: a synthetic pending item is filtered everywhere. */
  (NAV as unknown as Array<Record<string, unknown>>).push({ href: "/labs-next", label: "NEXT", place: "primary", pending: true });
  try { assert.ok(!navFor("primary").some((n) => n.href === "/labs-next")); } finally { (NAV as unknown as unknown[]).pop(); }
  const nav = read("components/NavLinks.tsx");
  assert.match(nav, /const byPlace = navFor;/);
  assert.doesNotMatch(nav, /NAV\.filter/);
});

test("Store is in More (Shop), All Access has no bar slot, PBE PICKS keeps its exact primary entry", () => {
  const store = NAV.find((n) => n.href === "/store");
  assert.deepEqual({ place: store!.place, group: store!.group }, { place: "more", group: "Shop" });
  assert.ok(navFor("more").some((n) => n.href === "/store"));
  assert.ok(!NAV.some((n) => /propbetedge\.ai\/pro/.test(n.href)), "All Access is not a nav entry");
  assert.match(read("lib/site.ts"), /\{ href: "\/algo\/card", label: "PBE PICKS", place: "primary", flagship: true \}/);
});

test("mobile drawer: primary items first (Fight Simulator among them), then More; no All Access row", () => {
  const nav = read("components/NavLinks.tsx");
  assert.match(nav, /variant === "mobile"[^]*primary\.map\(\(n\) => <PrimaryLink[^]*<div className="mnav-group" aria-label="More">/);
  const shell = read("components/Shell.tsx");
  assert.match(shell, /<MobileNav>\s*<NavLinks className="" variant="mobile" \/>/);
});

test("preservation check carries the dead-link guard for pending slots", () => {
  const src = read("scripts/preservation-check.mjs");
  assert.match(src, /is marked pending but its route exists/);
  assert.match(src, /renders but has no page route \(dead link\)/);
});

/* ---- rendered markup (react-dom/server through the SWC test hooks; no server needed) ---- */
async function renderNav(variant: "desktop" | "mobile") {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { NavLinks } = await import("../components/NavLinks.tsx");
  return renderToStaticMarkup(createElement(NavLinks as never, { className: variant === "desktop" ? "nav" : "", variant } as never));
}
const hrefs = (html: string) => [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]);

test("rendered desktop bar: exact link order with FIGHT SIMULATOR after PBE PICKS, More holds Store, no All Access", async () => {
  const html = await renderNav("desktop");
  const bar = html.slice(0, html.indexOf("nav-more") > 0 ? html.indexOf("nav-more") : html.length);
  assert.deepEqual(hrefs(bar), ["/fight-week", "/algo/card", "/simulator", "/events", "/fighters", "/rankings", "/news"]);
  assert.match(html, /class="nav-pbe-picks"[^>]*>[^]*?PBE PICKS[^]*?<span class="nav-pro">PRO<\/span>/);
  assert.match(bar, /FIGHT SIMULATOR<\/span><span class="nav-pro">LABS<\/span>/);
  assert.ok(hrefs(html).includes("/store"), "Store reachable from the More menu");
  assert.doesNotMatch(html, /All Access|propbetedge\.ai\/pro/);
});

test("rendered mobile drawer: Fight Simulator third, above the fold, then More (with Store); no All Access row", async () => {
  const html = await renderNav("mobile");
  const i = html.indexOf('class="mnav-group"');
  assert.ok(i > 0, "More group rendered");
  assert.deepEqual(hrefs(html.slice(0, i)), ["/fight-week", "/algo/card", "/simulator", "/events", "/fighters", "/rankings", "/news"]);
  assert.ok(hrefs(html.slice(i)).includes("/store"));
  assert.ok(!hrefs(html.slice(i)).includes("/simulator"), "never inside More");
  assert.doesNotMatch(html, /All Access|propbetedge\.ai\/pro/);
});


