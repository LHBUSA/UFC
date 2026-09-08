#!/usr/bin/env node
/**
 * Build the Printful-ready print files for the launch collection.
 *
 *   node scripts/store/build_print_files.mjs
 *
 * These are the files that get uploaded to the provider and printed onto
 * cloth. They are a different artefact from web/public/store/img/*, which are
 * storefront previews showing a garment shape: a print file contains the
 * artwork alone, on nothing, at the exact pixel dimensions the provider's
 * print area demands.
 *
 * Three properties, each of which has a way of going wrong quietly:
 *
 * 1. TRANSPARENT. There is no background element in the output at all, rather
 *    than a background set to transparent. A white square behind a mark prints
 *    as a white square, and on a black tee that is the whole garment ruined —
 *    discovered when the sample arrives, not when the file is made.
 *
 * 2. THE REAL MARK. Geometry comes from lib/brand-mark.ts, the same source the
 *    site header and favicons use. Nothing here redraws an octagon.
 *
 * 3. NO INVENTED DIMENSIONS. Sizes are read from docs/store_print_areas.json,
 *    which carries a provenance string per placement, and this script REFUSES
 *    to emit a raster for any placement not marked verified. Printful's help
 *    pages describe a product family; we order a specific catalog id, and the
 *    only number that counts is the one its printfiles endpoint returns. Until
 *    the canary supplies that, this writes vector only and says so.
 *
 * Vector (.svg) is always written: it is resolution-independent, so it is
 * correct before the dimensions are known and stays correct after. The .png
 * raster is what Printful actually wants for DTG, and it is what needs the
 * verified size.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "web", "public", "store", "print");
const AREAS = path.join(ROOT, "docs", "store_print_areas.json");

const brand = await import(pathToFileURL(path.join(ROOT, "web", "lib", "brand-mark.ts")).href);
const { PRODUCTS } = await import(pathToFileURL(path.join(ROOT, "web", "lib", "store", "catalog.ts")).href);

const areas = JSON.parse(fs.readFileSync(AREAS, "utf8")).placements;
const allowUnverified = process.argv.includes("--allow-unverified");

fs.mkdirSync(OUT, { recursive: true });

/* Inter, from the fonts the site already serves. Both Inter and Playfair are
 * SIL Open Font License, which permits embedding in printed goods; a system
 * font baked into a raster would not necessarily be. Located by reading the
 * built CSS rather than by guessing a hash. */
function interWoff2() {
  const cssDir = path.join(ROOT, "web", ".next", "static", "css");
  if (!fs.existsSync(cssDir)) return null;
  for (const f of fs.readdirSync(cssDir)) {
    const css = fs.readFileSync(path.join(cssDir, f), "utf8");
    for (const block of css.split("@font-face")) {
      if (!/font-family:\s*Inter[;,}]/.test(block)) continue;
      const m = block.match(/src:url\(\/_next\/static\/media\/([^)]+\.woff2)\)/);
      if (!m) continue;
      const file = path.join(ROOT, "web", ".next", "static", "media", m[1]);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** The artwork, alone, in its own coordinate space. No background. */
function printSvg({ mark, wordmark, color, width, height }) {
  const box = brand.MARK_BOX;
  /* The mark is laid out against the printable area, not against a garment.
   * 46% of the narrow edge keeps a real margin on every side; a print file
   * that fills its area edge to edge is one the provider will scale down
   * anyway, unpredictably. */
  const narrow = Math.min(width, height);
  const markW = narrow * 0.46;
  const k = markW / box;
  const cx = width / 2;
  const cy = wordmark ? height * 0.44 : height / 2;

  const type = wordmark
    ? `<text x="${cx}" y="${(cy + markW * 0.86).toFixed(1)}" text-anchor="middle" ` +
      `font-family="Inter" font-weight="700" font-size="${(narrow * 0.072).toFixed(1)}" ` +
      `letter-spacing="${(narrow * 0.0125).toFixed(2)}" fill="${color}">PROPBETEDGE</text>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    /* No <rect>. Deliberately. See the header. */
    `<g transform="translate(${(cx - markW / 2).toFixed(1)},${(cy - markW / 2).toFixed(1)}) scale(${k.toFixed(5)})">` +
    brand.houseMarkSvgMarkup(color, { ghost: true }) +
    `</g>` +
    type +
    `</svg>`
  );
}

/* One entry per launch piece that needs a file, derived from the catalog so a
 * product added to the launch collection cannot be silently missed. */
const FORM_AREA = { tee: "tee", hoodie: "hoodie", mug: "mug" };
const jobs = PRODUCTS.filter((p) => p.status === "launch").map((p) => ({
  slug: p.slug,
  form: p.form,
  art: p.art,
  wordmark: (p.lines ?? []).length > 0,
  /* Gold on dark cloth, ink on light. Same derivation the previews use, so a
   * print file cannot disagree with the picture the customer was shown. */
  color: /white|natural|sand|ash|cream|bone/i.test(String(p.colors[0]))
    ? brand.BRAND_INK
    : brand.BRAND_GOLD,
}));

const manifest = [];
let vector = 0;
let raster = 0;
const blocked = [];

for (const job of jobs) {
  const area = areas[FORM_AREA[job.form]];
  if (!area) {
    blocked.push(`${job.slug}: no print area recorded for form "${job.form}"`);
    continue;
  }

  /* Vector always. When the size is unknown the SVG is authored in a nominal
   * square and remains correct at any scale, which is the property that makes
   * writing it before the dimensions are known honest rather than sloppy. */
  const w = area.width ?? 2000;
  const h = area.height ?? 2000;
  const svg = printSvg({ ...job, width: w, height: h });
  const svgName = `${job.art}.svg`;
  fs.writeFileSync(path.join(OUT, svgName), svg, "utf8");
  vector += 1;

  const ok = area.verified || allowUnverified;
  manifest.push({
    slug: job.slug,
    form: job.form,
    file_svg: `store/print/${svgName}`,
    file_png: ok ? `store/print/${job.art}.png` : null,
    width: area.width,
    height: area.height,
    dpi: area.dpi,
    placement: area.placement,
    color: job.color,
    wordmark: job.wordmark,
    area_verified: Boolean(area.verified),
    area_source: area.source,
  });

  if (!ok) {
    blocked.push(
      `${job.slug}: ${area.width && area.height ? `${area.width}x${area.height} is recorded but unverified` : "no dimensions recorded"} — ${area.source}`,
    );
    continue;
  }
  raster += 1;
}

fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), files: manifest }, null, 2),
  "utf8",
);

console.log(`${vector} vector print file(s) written to web/public/store/print/`);
for (const m of manifest) {
  console.log(
    `  ${m.file_svg.padEnd(44)} ${String(m.width ?? "?")}x${String(m.height ?? "?")}` +
      `  ${m.area_verified ? "verified" : "UNVERIFIED"}`,
  );
}
if (blocked.length) {
  console.log(`\n${blocked.length} placement(s) produced no raster:`);
  for (const b of blocked) console.log(`  - ${b}`);
  console.log(
    "\nRun the read-only canary's print-areas step against the chosen blanks and\n" +
      "record the numbers in docs/store_print_areas.json with verified: true.\n" +
      "Nothing may be uploaded to the provider until then.",
  );
}
console.log(`\nInter (for the wordmark): ${interWoff2() ? "found in the build output" : "NOT FOUND — build web/ first if a raster is needed"}`);
