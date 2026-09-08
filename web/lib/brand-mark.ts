/**
 * The PropBetEdge mark, as geometry.
 *
 * This is the canonical source. It was extracted from components/Brand.tsx
 * rather than redrawn, and Brand.tsx now imports it back, so the header logo,
 * the favicons, the OG images, the store previews and the print files are all
 * the same coordinates. A mark that exists twice is a mark that differs
 * eventually, and the difference shows up on a garment, which is the one place
 * it cannot be corrected by a deploy.
 *
 * Two rules about what is in here:
 *
 * 1. No text. The wordmark is set in Inter, which is a font, not geometry, and
 *    baking letterforms into this file would freeze a typographic decision in
 *    the wrong place. Callers that need type say so themselves.
 *
 * 2. No UFC badge. The site logo carries a gold "UFC" chip beside the
 *    wordmark; that is a rights-holder's lettering and it must never reach a
 *    printed product. It is deliberately absent from every function here, so a
 *    print file physically cannot contain it.
 *
 * The drawing is an octagon with a fighter inside it. Both are ours: plain
 * geometry and a stick figure, carrying no promotion's trade dress, no red,
 * and no registered logo.
 */

/** The mark is drawn in a 64x64 box. Everything below is in that space. */
export const MARK_BOX = 64;

export const OCTAGON = "55.1,22.4 55.1,41.6 41.6,55.1 22.4,55.1 8.9,41.6 8.9,22.4 22.4,8.9 41.6,8.9";
export const OCTAGON_INNER = "50.5,24.3 50.5,39.7 39.7,50.5 24.3,50.5 13.5,39.7 13.5,24.3 24.3,13.5 39.7,13.5";

export const FIGHTER = {
  head: { cx: 34.5, cy: 17.5, r: 4.2 },
  torso: "M29 24 L40.5 24 L39.5 36 L31 36 Z",
  rearArm: "M30.5 25.5 L25 29 L30 22.5",
  leadArm: "M40 25.5 L46.5 28.5 L43.5 21",
  rearLeg: "M32 35.5 L27 41.5 L24 49",
  leadLeg: "M38.5 35.5 L43.5 41 L46 49",
  armWidth: 4.8,
  legWidth: 5.2,
} as const;

/** Brand colours. Gold on dark cloth, ink on light. */
export const BRAND_GOLD = "#d4af37";
export const BRAND_INK = "#14110d";
export const BRAND_PAPER = "#f5f1eb";

/** The fighter alone, as SVG markup in the 64x64 space. */
export function fighterSvgMarkup(color: string = BRAND_GOLD): string {
  const f = FIGHTER;
  return (
    `<g fill="${color}" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="${f.head.cx}" cy="${f.head.cy}" r="${f.head.r}" stroke="none"/>` +
    `<path d="${f.torso}" stroke-width="1.2"/>` +
    `<path d="${f.rearArm}" fill="none" stroke-width="${f.armWidth}"/>` +
    `<path d="${f.leadArm}" fill="none" stroke-width="${f.armWidth}"/>` +
    `<path d="${f.rearLeg}" fill="none" stroke-width="${f.legWidth}"/>` +
    `<path d="${f.leadLeg}" fill="none" stroke-width="${f.legWidth}"/>` +
    `</g>`
  );
}

/**
 * The full house mark: octagon, ghost octagon, fighter. Nothing else.
 *
 * `ghost` is the faint inner octagon. It is 35% opacity at screen sizes and is
 * dropped for embroidery, where a 1.2-unit line at 35% is not a thing a
 * needle can do — it either stitches at full weight or it does not exist.
 */
export function houseMarkSvgMarkup(
  color: string = BRAND_GOLD,
  { ghost = true }: { ghost?: boolean } = {},
): string {
  return (
    `<polygon points="${OCTAGON}" fill="none" stroke="${color}" stroke-width="3.2" stroke-linejoin="round"/>` +
    (ghost
      ? `<polygon points="${OCTAGON_INNER}" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="1.2" stroke-linejoin="round"/>`
      : "") +
    fighterSvgMarkup(color)
  );
}

/**
 * A standalone SVG document containing only the mark, on nothing.
 *
 * Transparent by construction: there is no background rect to forget to
 * remove. A print file with a black square behind the artwork prints a black
 * square, and on a black shirt nobody notices until the sample arrives.
 */
export function houseMarkDocument({
  size = 512,
  color = BRAND_GOLD,
  ghost = true,
  title = "PropBetEdge mark",
}: { size?: number; color?: string; ghost?: boolean; title?: string } = {}): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_BOX} ${MARK_BOX}" ` +
    `width="${size}" height="${size}" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    houseMarkSvgMarkup(color, { ghost }) +
    `</svg>`
  );
}
