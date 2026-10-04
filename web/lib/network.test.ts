// Learn (learn.propbetedge.ai) is a first-party PropBetEdge network destination in the UFC footer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CURRENT_SPORT, NETWORK, NETWORK_PRODUCTS } from "./network.ts";
import { ALL_ACCESS_URL } from "./pbe-membership.js";

test("network registry carries canonical Learn", () => {
  assert.deepEqual(NETWORK.learn, { label: "Learn", href: "https://learn.propbetedge.ai/" });
});

test("footer PropBetEdge column renders Learn from the registry, same-tab, once", () => {
  const shell = readFileSync(new URL("../components/Shell.tsx", import.meta.url), "utf8");
  const col = shell.slice(shell.indexOf("<h4>PropBetEdge</h4>"), shell.indexOf("<h4>Fight Intelligence</h4>"));
  assert.ok(col.includes("<a href={NETWORK.learn.href}>{NETWORK.learn.label}</a>"), "footer link, no target/rel");
  assert.equal(shell.split("NETWORK.learn.href").length - 1, 1, "footer only; not in the header");
  assert.ok(!/learn\.propbetedge\.ai/.test(shell), "the URL lives only in lib/network.ts");
  for (const s of ["All Access", "NETWORK.news", "NETWORK.store", "Manage billing", "Discord"]) assert.ok(col.includes(s), s);
});

test("network sports follow the family order; the footer rail renders them from the registry", () => {
  assert.deepEqual(NETWORK.sports.map((s) => s.key), ["mlb", "nfl", "nba", "wnba", "nhl", "ufc", "tennis", "soccer", "golf", "f1"]);
  const soccer = NETWORK.sports.find((s) => s.key === "soccer")!;
  assert.equal(soccer.label, "Soccer");
  assert.equal(soccer.name, "Soccer Intelligence");
  assert.equal(soccer.href, "https://soccer.propbetedge.ai/");
  const shell = readFileSync(new URL("../components/Shell.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes("NETWORK.sports.map("), "footer rail reads the registry");
  assert.ok(!/soccer\.propbetedge\.ai/.test(shell), "the Soccer URL lives only in lib/network.ts");
});

// Family parity (owner decision 2026-10-03): lib/family.json is vendored from
// LHBUSA/propbetedge-workers shared/network/family.json (generated; never hand-edit).
type FamilyEntry = { key: string; kind: string; label: string; name: string; url: string };
const family = JSON.parse(readFileSync(new URL("./family.json", import.meta.url), "utf8")) as {
  organization: string; sports: FamilyEntry[]; products: FamilyEntry[]; network: FamilyEntry[]; all_access_line: string; retired_hosts: string[];
};

test("family parity: sports set, order and URLs match the canonical registry (self may be relative)", () => {
  assert.deepEqual(NETWORK.sports.map((s) => s.key), family.sports.map((s) => s.key));
  for (const f of family.sports) {
    const local = NETWORK.sports.find((s) => s.key === f.key)!;
    if (f.key === CURRENT_SPORT) assert.ok(local.href === "/" || local.href === f.url, `${f.key} self link`);
    else assert.equal(local.href, f.url, f.key);
  }
  assert.equal(NETWORK.sports.find((s) => s.key === "f1")!.name, "F1 Intelligence");
});

test("family parity: Predictions is a product, never a sport", () => {
  assert.deepEqual(NETWORK_PRODUCTS.map((p) => [p.key, p.name, p.href]), family.products.map((p) => [p.key, p.name, p.url]));
  assert.ok(!NETWORK.sports.some((s) => (s.key as string) === "predictions" || /predictions\./.test(s.href)), "not in the sports rail");
  assert.equal(NETWORK.sports.length, 10, "ten sports; Predictions is not counted");
});

test("family parity: network URLs (hub, All Access, Learn)", () => {
  const url = (k: string) => family.network.find((n) => n.key === k)!.url;
  assert.equal(NETWORK.news.href, url("hub"));
  assert.equal(ALL_ACCESS_URL, url("all_access"));
  assert.equal(NETWORK.learn.href, url("learn"));
});

test("footer: exactly one F1 and one Predictions anchor, canonical https, no retired hosts", () => {
  const shell = readFileSync(new URL("../components/Shell.tsx", import.meta.url), "utf8");
  const footer = shell.slice(shell.indexOf("export function Footer()"));
  assert.ok(footer.includes("NETWORK_PRODUCTS.map("), "Intelligence row reads the registry");
  assert.equal(footer.split("NETWORK.sports.map(").length - 1, 1, "sports rail rendered once");
  assert.equal(footer.split("NETWORK_PRODUCTS.map(").length - 1, 1, "Intelligence row rendered once");
  assert.ok(footer.indexOf('className="net-intel"') > footer.indexOf('className="net"'), "own row, after the sports rail");
  const reg = readFileSync(new URL("./network.ts", import.meta.url), "utf8");
  assert.equal(reg.split('"https://f1.propbetedge.ai/"').length - 1, 1);
  assert.equal(reg.split('"https://predictions.propbetedge.ai/"').length - 1, 1);
  for (const host of family.retired_hosts) assert.ok(!reg.includes(host) && !shell.includes(host), host);
  assert.ok(!/http:\/\//.test(reg), "https only");
});

test("schema: the one PropBetEdge organization id", () => {
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.equal(family.organization, "https://propbetedge.ai/#organization");
  assert.ok(layout.includes('"@id": `${SITE.parent}/#organization`'));
  assert.ok(!/\/#org`/.test(layout));
});
