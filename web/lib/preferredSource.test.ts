import test from "node:test";
import assert from "node:assert/strict";
import { preferredSourceTarget, preferredSourceDeeplink, SITE_SOURCE } from "./preferredSource.ts";

test("ufc is a listed source and uses the SDK against itself", () => {
  assert.deepEqual(preferredSourceTarget("ufc.propbetedge.ai"), { source: "ufc.propbetedge.ai", sdk: true });
  assert.equal(SITE_SOURCE, "ufc.propbetedge.ai");
});

test("unlisted and off-production hosts deeplink to the parent", () => {
  for (const h of ["nfl.propbetedge.ai", "ufc-propbetedge-git-main.vercel.app", "localhost"]) {
    assert.deepEqual(preferredSourceTarget(h), { source: "propbetedge.ai", sdk: false }, h);
  }
});

test("deeplink is Google's documented preferences URL", () => {
  assert.equal(preferredSourceDeeplink(SITE_SOURCE), "https://www.google.com/preferences/source?q=ufc.propbetedge.ai");
});
