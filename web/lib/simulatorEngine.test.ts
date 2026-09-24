/* The vendored simulator engine and PBE Fight Model feature core are
 * byte-identical (LF-normalised) to their sources. A change to the engine or
 * the model without `node scripts/sync-simulator-engine.mjs` fails here. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { TARGETS } from "../scripts/sync-simulator-engine.mjs";

const web = new URL("../", import.meta.url);
const repo = new URL("../../", import.meta.url);
const lf = (t: string) => t.replace(/\r\n/g, "\n");

test("every vendored file matches its source exactly, and nothing extra is vendored", () => {
  for (const t of TARGETS) {
    for (const f of t.files) {
      const src = lf(readFileSync(new URL(`${t.src}/${f}`, repo), "utf8"));
      const copy = lf(readFileSync(new URL(`${t.dest}/${f}`, web), "utf8"));
      assert.equal(copy, src, `web/${t.dest}/${f} drifted from ${t.src}/${f}: run node scripts/sync-simulator-engine.mjs`);
    }
    const present = readdirSync(new URL(`${t.dest}/`, web)).filter((n) => n.endsWith(".mjs")).sort();
    assert.deepEqual(present, [...t.files].sort(), `web/${t.dest} holds only the synced runtime files`);
  }
});
