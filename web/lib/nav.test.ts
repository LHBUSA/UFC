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

test("desktop primary order: Fight Week, PBE PICKS, Schedule, Fighters, Rankings, News (Fight Simulator joins after PBE PICKS once live)", () => {
  assert.deepEqual(navFor("primary").map((n) => n.label), ["Fight Week", "PBE PICKS", "Schedule", "Fighters", "Rankings", "News"]);
  const all = NAV.filter((n) => (n.place || "primary") === "primary").map((n) => n.label);
  assert.deepEqual(all, ["Fight Week", "PBE PICKS", "FIGHT SIMULATOR", "Schedule", "Fighters", "Rankings", "News"], "the reserved slot sits directly after PBE PICKS");
});

test("Fight Simulator slot: pending, LABS badge, flagship treatment, never rendered while app/simulator/page.tsx is absent", () => {
  const sim = NAV.find((n) => n.href === "/simulator");
  assert.ok(sim, "slot reserved");
  assert.equal(sim!.pending, true);
  assert.equal(sim!.badge, "LABS");
  assert.equal(sim!.flagship, true);
  assert.equal(sim!.place, "primary");
  assert.ok(!navFor("primary").some((n) => n.href === "/simulator"), "pending slot is filtered out of the bar");
  assert.ok(!navFor("more").some((n) => n.href === "/simulator"), "and out of More");
  const routeExists = existsSync(fileURLToPath(new URL("app/simulator/page.tsx", web)));
  assert.equal(routeExists, false, "when the Phase 4 route ships, drop pending in lib/site.ts (the preservation check enforces this)");
  /* NavLinks renders every primary/more list through navFor, so a pending item cannot leak as a link. */
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

test("mobile drawer: primary items first (the simulator appears there first-class once live), then More; no All Access row", () => {
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

test("rendered desktop bar: exact link order, PBE PICKS flagship, More holds Store, no simulator link, no All Access", async () => {
  const html = await renderNav("desktop");
  const bar = html.slice(0, html.indexOf("nav-more") > 0 ? html.indexOf("nav-more") : html.length);
  assert.deepEqual(hrefs(bar), ["/fight-week", "/algo/card", "/events", "/fighters", "/rankings", "/news"]);
  assert.match(html, /class="nav-pbe-picks"[^>]*>[^]*?PBE PICKS[^]*?<span class="nav-pro">PRO<\/span>/);
  assert.ok(hrefs(html).includes("/store"), "Store reachable from the More menu");
  assert.ok(!hrefs(html).includes("/simulator"), "no dead Fight Simulator link");
  assert.doesNotMatch(html, /All Access|propbetedge\.ai\/pro|FIGHT SIMULATOR/);
});

test("rendered mobile drawer: primary routes first, then More (with Store); no simulator link, no All Access row", async () => {
  const html = await renderNav("mobile");
  const i = html.indexOf('class="mnav-group"');
  assert.ok(i > 0, "More group rendered");
  assert.deepEqual(hrefs(html.slice(0, i)), ["/fight-week", "/algo/card", "/events", "/fighters", "/rankings", "/news"]);
  assert.ok(hrefs(html.slice(i)).includes("/store"));
  assert.ok(!hrefs(html).includes("/simulator"));
  assert.doesNotMatch(html, /All Access|propbetedge\.ai\/pro|FIGHT SIMULATOR/);
});

test("rendered: flipping the slot live (pending off) places FIGHT SIMULATOR directly after PBE PICKS with the LABS badge", async () => {
  const sim = NAV.find((n) => n.href === "/simulator") as { pending?: boolean };
  sim.pending = false;
  try {
    const html = await renderNav("desktop");
    const bar = html.slice(0, html.indexOf("nav-more"));
    assert.deepEqual(hrefs(bar), ["/fight-week", "/algo/card", "/simulator", "/events", "/fighters", "/rankings", "/news"]);
    const simTag = bar.match(/<a[^>]*href="\/simulator"[^>]*>/)![0];
    assert.match(simTag, /class="nav-pbe-picks"/);
    assert.match(simTag, /data-nav-badge="LABS"/);
    assert.match(bar, /FIGHT SIMULATOR<\/span><span class="nav-pro">LABS<\/span>/);
    const mobile = await renderNav("mobile");
    assert.deepEqual(hrefs(mobile.slice(0, mobile.indexOf('class="mnav-group"'))).slice(0, 3), ["/fight-week", "/algo/card", "/simulator"], "first-class in the drawer, never in More");
  } finally { sim.pending = true; }
});
