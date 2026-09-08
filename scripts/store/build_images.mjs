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
const { artSvg, imagePath, IMAGE_VERSION } = await import(pathToFileURL(path.join(ROOT, "web", "lib", "store", "art.ts")).href);

fs.mkdirSync(OUT, { recursive: true });

let written = 0;
for (const p of PRODUCTS) {
  /* Ink artwork sits on light garments and reads in paper; gold on dark. The
   * tone is derived from the print file name so the preview matches what is
   * actually printed rather than being chosen separately. */
  const tone = p.art.endsWith("-ink") ? "paper" : "gold";
  const svg = artSvg({ form: p.form, tone, label: p.name });
  const file = path.join(OUT, path.basename(imagePath(p.slug)));
  fs.writeFileSync(file, svg, "utf8");
  written += 1;
  console.log(`  ${path.basename(file).padEnd(44)} ${p.form.padEnd(7)} ${tone.padEnd(6)} ${svg.length} bytes`);
}

console.log(`\n${written} preview images written to web/public/store/img/ at version ${IMAGE_VERSION}.`);
console.log("These are design previews, not photographs, and every surface that shows one says so.");
