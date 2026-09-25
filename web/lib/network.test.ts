// Learn (learn.propbetedge.ai) is a first-party PropBetEdge network destination in the UFC footer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NETWORK } from "./network.ts";

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
