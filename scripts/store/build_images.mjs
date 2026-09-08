#!/usr/bin/env node
/**
 * Write the product preview images.
 *
 *   node scripts/store/build_images.mjs
 *
 * One file per product at web/public/store/img/<slug>-<version>.svg. These
 * URLs are handed to the other storefront through the shared catalog API, so
 * they are permanent by contract: a redesign becomes -v2 rather than new
 * bytes at the old path, because a consumer may have cached it.
 *
 * Committed rather than generated at build time, so the bytes a reviewer sees
 * are the bytes that ship, and so the other site is never pointed at a file
 * that only exists if a build step ran.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "web", "public", "store", "img");

/* pathToFileURL: a Windows absolute path is not a valid ESM specifier. */
const { PRODUCTS } = await import(pathToFileURL(path.join(ROOT, "web", "lib", "store", "catalog.ts")).href);
const { artSvg, imagePath, toneFor, IMAGE_VERSION } = await import(
  pathToFileURL(path.join(ROOT, "web", "lib", "store", "art.ts")).href
);

fs.mkdirSync(OUT, { recursive: true });

let written = 0;
for (const p of PRODUCTS) {
  /* The tone comes from the colourway the product leads with, not from a
   * second decision taken here. A preview showing gold type on a garment we
   * only sell in white is a preview of a product that does not exist. */
  const tone = toneFor(p.colors);
  const svg = artSvg({ form: p.form, tone, mark: p.mark, lines: p.lines ?? [], label: p.name });
  const file = path.join(OUT, path.basename(imagePath(p.slug)));
  fs.writeFileSync(file, svg, "utf8");
  written += 1;
  console.log(
    `  ${path.basename(file).padEnd(46)} ${p.form.padEnd(7)} ${p.mark.padEnd(9)} ${tone.padEnd(6)} ${svg.length} bytes`,
  );
}

/* Files from a superseded version are removed rather than left beside the
 * current ones.
 *
 * The permanence rule protects a URL somebody may have cached, and it still
 * holds: these are previews from a branch that has never been promoted, so
 * nothing outside this repository has ever been able to fetch them. What is
 * left behind if they stay is a directory where half the files draw a design
 * that no longer exists, and the next person to read it cannot tell which
 * half. Deleting a published version is a different question, and this loop
 * would be the wrong place to answer it. */
const keep = new Set(PRODUCTS.map((p) => path.basename(imagePath(p.slug))));
let removed = 0;
for (const f of fs.readdirSync(OUT)) {
  if (!f.endsWith(".svg") || keep.has(f)) continue;
  fs.rmSync(path.join(OUT, f));
  removed += 1;
  console.log(`  superseded, removed: ${f}`);
}

console.log(`
${written} preview images written to web/public/store/img/ at version ${IMAGE_VERSION}${
  removed ? `, ${removed} superseded file(s) removed` : ""
}.`);
console.log("These are design previews, not photographs, and every surface that shows one says so.");
