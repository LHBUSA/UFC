/**
 * Product artwork, as one SVG string builder.
 *
 * There is a single code path on purpose. The storefront and the shared
 * catalog API must show the same image, and the surest way to guarantee that
 * is for both to reference the same file: this module writes it (via
 * scripts/store/build_images.mjs) and the pages link to it. Nothing renders
 * the artwork a second way, so nothing can drift.
 *
 * These are design previews, not product photographs, and every surface that
 * shows one says so. Printful generates real garment mockups from uploaded
 * artwork; those replace these once a product is actually provisioned.
 * Shipping something photo-realistic would imply a physical object nobody has
 * seen, from a shop holding no inventory.
 *
 * The filename carries a version. Image URLs handed to another site are
 * permanent by contract: a changed design becomes -v2 rather than new bytes
 * at the old path, because a consumer may have cached or hot-linked it.
 */

export const IMAGE_VERSION = "v1";
export const IMAGE_W = 240;
export const IMAGE_H = 300;

export type ArtForm = "tee" | "hoodie" | "cap" | "mug";
export type ArtTone = "gold" | "paper";

const TONES: Record<ArtTone, string> = { gold: "#d4af37", paper: "#f5f1eb" };
const INK = "#14110d";

/* Flat and diagrammatic on purpose: a shape that reads as "tee" without
 * pretending to be a photograph of one. */
const SHAPES: Record<ArtForm, string> = {
  tee: "M92 74 L142 52 Q160 46 168 62 L196 108 L170 126 L156 106 L156 250 Q156 258 148 258 L92 258 Q84 258 84 250 L84 106 L70 126 L44 108 L72 62 Q80 46 98 52 Z",
  hoodie:
    "M92 76 L140 54 Q160 48 168 64 L198 112 L172 130 L158 110 L158 252 Q158 260 150 260 L90 260 Q82 260 82 252 L82 110 L68 130 L42 112 L72 64 Q80 48 100 54 Z M108 54 Q120 74 132 54",
  cap: "M56 176 Q56 106 120 106 Q184 106 184 176 L196 176 Q206 176 206 186 L206 194 Q206 202 196 202 L56 202 Q46 202 46 194 L46 186 Q46 176 56 176 Z",
  mug: "M62 108 L172 108 L166 244 Q165 254 154 254 L80 254 Q69 254 68 244 Z M172 138 Q212 138 212 172 Q212 206 172 206",
};

/* Where the mark sits on each shape, and how big. */
const PLACEMENT: Record<ArtForm, { x: number; y: number; w: number }> = {
  tee: { x: 120, y: 150, w: 46 },
  hoodie: { x: 120, y: 158, w: 44 },
  cap: { x: 120, y: 158, w: 34 },
  mug: { x: 117, y: 178, w: 44 },
};

function octagon(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(" ");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The permanent, versioned path for a product's preview image. */
export function imagePath(slug: string): string {
  return `/store/img/${slug}-${IMAGE_VERSION}.svg`;
}

export function artSvg({ form, tone, label }: { form: ArtForm; tone: ArtTone; label: string }): string {
  const stroke = TONES[tone];
  const p = PLACEMENT[form];
  const id = `g-${form}-${tone}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${IMAGE_W} ${IMAGE_H}" width="${IMAGE_W}" height="${IMAGE_H}" role="img" aria-label="${esc(label)} — design preview, not a photograph">
  <title>${esc(label)} — design preview, not a photograph</title>
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#221d17"/><stop offset="100%" stop-color="#171310"/></linearGradient></defs>
  <rect width="${IMAGE_W}" height="${IMAGE_H}" fill="${INK}"/>
  <path d="${SHAPES[form]}" fill="url(#${id})" stroke="rgba(255,245,220,.16)" stroke-width="1.5" stroke-linejoin="round"/>
  <g transform="translate(${p.x},${p.y})">
    <polygon points="${octagon(p.w / 2)}" fill="none" stroke="${stroke}" stroke-width="1.6" opacity=".9"/>
    <circle cx="0" cy="0" r="${(p.w * 0.1).toFixed(2)}" fill="${stroke}"/>
  </g>
</svg>
`;
}
