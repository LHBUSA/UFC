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
 *
 * ---------------------------------------------------------------------------
 * v2: the mark is the product
 *
 * v1 drew one octagon on every piece. Fourteen products, fourteen identical
 * glyphs, and a shop where the Fight DNA tee and the mug were distinguishable
 * only by their silhouette. That is not a preview of anything: it shows the
 * garment and hides the design, which is the half a customer is buying.
 *
 * So each design draws its own mark now, and the garment it sits on is drawn
 * in the colourway the product actually leads with. Everything is still flat
 * vector, a diagram of the piece and honest about being one. Nothing here
 * attempts a photograph, a fabric texture, or a shadow that would read as
 * one.
 *
 * No embedded fonts. A web font cannot load inside an SVG referenced by an
 * <img>, so the type falls back to whatever the reader has, and the stacks
 * below are chosen to resolve everywhere rather than to be exactly right
 * anywhere.
 */

export const IMAGE_VERSION = "v2";
export const IMAGE_W = 480;
export const IMAGE_H = 600;

export type ArtForm = "tee" | "hoodie" | "cap" | "mug";
/** Which way round the ink and the cloth are. Derived from the product's lead
 * colourway, never chosen separately, so a preview cannot show gold on a
 * garment we only sell in white. */
export type ArtTone = "dark" | "light";
/** The mark a design carries. One per visual idea, not one per product: the
 * Fight DNA tee, hoodie, cap and mug all draw `dna`. */
export type MarkKind = "house" | "dna" | "tape" | "variance" | "rounds" | "strikes" | "grid" | "type";

import { BRAND_GOLD, BRAND_INK, MARK_BOX, houseMarkSvgMarkup } from "../brand-mark.ts";

const GOLD = BRAND_GOLD;
const INK = BRAND_INK;
const CLOTH_DARK = { body: "#2a241c", shade: "#1c1712", seam: "rgba(255,245,220,.26)" };
const CLOTH_LIGHT = { body: "#efe8dc", shade: "#d6ccba", seam: "rgba(20,17,13,.32)" };
const GROUND_TOP = "#100e0b";
const GROUND_BOTTOM = "#1a1611";

const SERIF = "Georgia,&#39;Times New Roman&#39;,&#39;Iowan Old Style&#39;,serif";
const MONO = "&#39;DejaVu Sans Mono&#39;,Menlo,Consolas,&#39;Courier New&#39;,monospace";

/* ---- garments ------------------------------------------------------------
 *
 * Drawn front-on at 480x600. Every silhouette is symmetric about x=240, which
 * is worth stating because it is the only thing keeping the sleeve numbers
 * honest: 432 pairs with 48, 400 with 80, 352 with 128.
 */

type Garment = {
  /** Filled outline. */
  body: string;
  /** Stroked details drawn over the body: seams, ribbing, pockets. */
  detail: string;
  /** Drawn before the body, so it sits behind it: a hood, a mug handle.
   * Stroked rather than filled, in the cloth colour with the seam outside it,
   * because a handle drawn only in the seam colour disappears against the
   * backdrop and the mug reads as a paper cup. */
  behind?: { d: string; width: number };
  /** Where the mark sits, and how wide it may be. */
  place: { x: number; y: number; w: number };
};

const GARMENTS: Record<ArtForm, Garment> = {
  tee: {
    body:
      "M186,140 Q240,178 294,140 L340,152 L432,196 L400,282 L352,262 L352,528 " +
      "Q352,540 340,540 L140,540 Q128,540 128,528 L128,262 L80,282 L48,196 L140,152 Z",
    detail: "M180,132 Q240,172 300,132 M406,272 L358,252 M74,272 L122,252 M128,514 L352,514",
    place: { x: 240, y: 306, w: 152 },
  },
  hoodie: {
    /* The hood is a wide, flat dome behind the shoulders, and the body is
     * drawn over its lower half so the two read as one garment. Two earlier
     * attempts failed differently: a peak rising out of the neck read as a
     * cowl, and a narrow dome clear of the shoulder line read as a balloon
     * behind the model's head.
     *
     * The sleeves run almost to the hem. Ending them at mid-torso left the
     * widest thing in the silhouette three quarters of the way up, which is
     * a poncho, and no amount of pocket detail argued otherwise. */
    behind: { d: "M148,250 Q148,134 240,134 Q332,134 332,250 Z", width: 0 },
    body:
      "M182,178 Q240,216 298,178 L344,190 L410,238 L386,486 L356,470 L356,556 " +
      "Q356,568 344,568 L136,568 Q124,568 124,556 L124,470 L94,486 L70,238 L136,190 Z",
    detail:
      "M182,176 Q240,214 298,176 M170,196 Q240,150 310,196 " +
      "M214,194 L210,276 M266,194 L270,276 " +
      "M156,420 L324,420 L318,486 L162,486 Z " +
      "M124,540 L356,540 M386,470 L358,458 M94,470 L122,458 " +
      /* Sleeve seams. Without them the sleeve and the torso share one
       * unbroken edge and the top two thirds read as a single wide
       * mass, which is why the earlier drafts kept looking like capes. */
      "M344,192 L356,466 M136,192 L124,466",
    place: { x: 240, y: 318, w: 146 },
  },
  cap: {
    /* Squat, because a crown as tall as it is wide reads as a helmet. The
     * bill is its own shape with its own outline for the same reason. */
    body:
      "M106,338 Q106,208 240,208 Q374,208 374,338 Z " +
      "M92,338 Q240,324 388,338 Q404,342 396,364 Q240,394 84,364 Q76,342 92,338 Z",
    detail:
      "M240,210 L240,336 M170,220 Q188,282 178,336 M310,220 Q292,282 302,336 " +
      "M92,338 Q240,352 388,338",
    place: { x: 240, y: 284, w: 112 },
  },
  mug: {
    /* Straight-sided. A body that tapers to the base is a paper cup, and the
     * handle is what makes the difference legible at card size. */
    behind: { d: "M326,260 Q394,260 394,320 Q394,380 326,380", width: 20 },
    body: "M152,196 L328,196 L328,468 Q328,486 310,486 L170,486 Q152,486 152,468 Z",
    detail: "M152,198 Q240,228 328,198",
    place: { x: 240, y: 348, w: 130 },
  },
};

/* ---- marks ---------------------------------------------------------------
 *
 * Each returns SVG drawn about the origin, inside a box `w` wide. The caller
 * translates it onto the garment. Nothing here knows what it is printed on,
 * which is why one `dna` covers four products.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const n = (v: number) => Number(v.toFixed(2));

/**
 * Type set to fit the mark box.
 *
 * The size is a starting point, not a promise. "I HAVE A SPREADSHEET FOR
 * THIS" at the nominal size ran off both sides of the mug and off the page,
 * so each line is measured against the box and shrunk if it does not fit.
 *
 * Measured by estimate rather than by metrics, because there are no metrics
 * to have: the font is whatever the reader's machine resolves the stack to,
 * and it is not known at build time. The per-character factors below are
 * deliberately generous — a line set slightly small is a design choice, a
 * line set slightly wide is a line hanging off a garment.
 */
function fitted(line: string, size: number, maxW: number, font: string): number {
  const per = font === MONO ? 0.78 : 0.8;
  const est = line.length * per * size;
  return est <= maxW ? size : Math.max(size * 0.45, maxW / (line.length * per));
}

function typeLines(
  lines: readonly string[],
  ink: string,
  y0: number,
  size: number,
  maxW: number,
  font = SERIF,
  opacity = "1",
): string {
  return lines
    .map((line, i) => {
      /* Baselines step by the nominal size so two lines stay evenly spaced
       * even when only one of them had to shrink. */
      const fs = fitted(line, size, maxW, font);
      return (
        `<text x="0" y="${n(y0 + i * size * 1.34)}" text-anchor="middle" font-family="${font}" ` +
        `font-size="${n(fs)}" letter-spacing="${n(fs * 0.15)}" fill="${ink}" opacity="${opacity}">${esc(line)}</text>`
      );
    })
    .join("");
}

/**
 * The house mark: the real one.
 *
 * This used to draw an octagon and a diamond invented in this file, which was
 * a recreated approximation sitting next to the actual brand in the header.
 * It now renders lib/brand-mark.ts — the same coordinates as the site logo,
 * the favicons and the print files — scaled from its native 64-unit box into
 * whatever room the garment gives it.
 *
 * The ghost octagon is dropped below a certain size: a 1.2-unit line at 35%
 * opacity is invisible on a cap panel and unstitchable in embroidery, and a
 * detail that survives only on the largest garment is a detail that makes the
 * small ones look wrong.
 */
function house(w: number, ink: string, lines: readonly string[]): string {
  /* Restrained on purpose. The brief is a small premium mark, not a chest
   * billboard: at 0.44 of the mark box the octagon sits at roughly the width
   * of a breast pocket on a printed tee, which is where this kind of mark
   * belongs. It grows slightly when there is no wordmark under it, because a
   * lone symbol needs a little more presence to read as deliberate. */
  const draw = w * (lines.length ? 0.4 : 0.46);
  const k = draw / MARK_BOX;
  const lift = lines.length ? w * 0.1 : w * 0.02;
  return (
    `<g transform="translate(${n(-draw / 2)},${n(-draw / 2 - lift)}) scale(${n(k)})">` +
    houseMarkSvgMarkup(ink, { ghost: draw >= 64 }) +
    `</g>` +
    typeLines(lines, ink, w * 0.3, w * 0.085, w)
  );
}

/** Two strands and their rungs. At card size it has to read as a helix
 * without a caption, which is the whole job: Fight DNA should look like Fight
 * DNA on a shelf. */
function dna(w: number, ink: string, lines: readonly string[]): string {
  const half = w * 0.44;
  const amp = w * 0.19;
  /* Under two full turns. At 2.2 the crossings landed close enough together
   * that the strands read as a row of pointed ovals rather than as a helix,
   * which is the one thing this mark has to do without a caption. */
  const turns = 1.5;
  const steps = 72;
  const top = -w * 0.2;
  const strand = (phase: number) => {
    const pts: string[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = -half + (2 * half * i) / steps;
      const y = amp * Math.sin(((x + half) / (2 * half)) * turns * 2 * Math.PI + phase);
      pts.push(`${i === 0 ? "M" : "L"}${n(x)},${n(y + top)}`);
    }
    return pts.join(" ");
  };
  const rungs: string[] = [];
  for (let i = 1; i < 12; i += 1) {
    const x = -half + (2 * half * i) / 12;
    const t = ((x + half) / (2 * half)) * turns * 2 * Math.PI;
    const y1 = amp * Math.sin(t) + top;
    const y2 = amp * Math.sin(t + Math.PI) + top;
    rungs.push(
      `<line x1="${n(x)}" y1="${n(y1)}" x2="${n(x)}" y2="${n(y2)}" stroke="${ink}" ` +
        `stroke-width="${n(w * 0.013)}" opacity="${Math.abs(y1 - y2) < amp * 0.7 ? ".28" : ".85"}"/>`,
    );
  }
  return (
    `<path d="${strand(0)}" fill="none" stroke="${ink}" stroke-width="${n(w * 0.026)}" stroke-linecap="round"/>` +
    `<path d="${strand(Math.PI)}" fill="none" stroke="${ink}" stroke-width="${n(w * 0.026)}" stroke-linecap="round"/>` +
    rungs.join("") +
    typeLines(lines, ink, w * 0.2, w * 0.1, w)
  );
}

/** A measuring rule with its graduations, and the reach span beneath it. The
 * tape is where every preview starts, so it is drawn as a tape. */
function tape(w: number, ink: string, lines: readonly string[]): string {
  const half = w * 0.44;
  const y = -w * 0.2;
  const ticks: string[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const x = -half + (2 * half * i) / 24;
    const tall = i % 4 === 0;
    ticks.push(
      `<line x1="${n(x)}" y1="${n(y)}" x2="${n(x)}" y2="${n(y - (tall ? w * 0.1 : w * 0.05))}" ` +
        `stroke="${ink}" stroke-width="${n(w * (tall ? 0.014 : 0.008))}" opacity="${tall ? ".95" : ".55"}"/>`,
    );
  }
  const arrowY = y + w * 0.12;
  const a = w * 0.026;
  return (
    `<line x1="${n(-half)}" y1="${n(y)}" x2="${n(half)}" y2="${n(y)}" stroke="${ink}" stroke-width="${n(w * 0.016)}"/>` +
    ticks.join("") +
    `<line x1="${n(-half + a * 1.6)}" y1="${n(arrowY)}" x2="${n(half - a * 1.6)}" y2="${n(arrowY)}" stroke="${ink}" stroke-width="${n(w * 0.01)}"/>` +
    `<path d="M${n(-half)},${n(arrowY)} l${n(a * 1.6)},${n(-a)} l0,${n(a * 2)} Z" fill="${ink}"/>` +
    `<path d="M${n(half)},${n(arrowY)} l${n(-a * 1.6)},${n(-a)} l0,${n(a * 2)} Z" fill="${ink}"/>` +
    typeLines(lines, ink, w * 0.2, w * 0.098, w) +
    /* The sub-line only exists to caption the caption. With no caption there
     * is nothing to sub, and on a cap panel it was the line that ran onto the
     * bill. */
    (lines.length
      ? typeLines(
          ["REACH · STANCE · HEIGHT"],
          ink,
          w * 0.2 + w * 0.098 * 1.34 * lines.length + w * 0.02,
          w * 0.058,
          w,
          MONO,
          ".72",
        )
      : "")
  );
}

/** A distribution, drawn as bars with the curve laid over them. The line only
 * lands if the shape is actually a distribution, so the heights come from a
 * gaussian rather than from whatever looked right. */
function variance(w: number, ink: string, lines: readonly string[]): string {
  const bars = 13;
  const half = w * 0.42;
  const bw = ((2 * half) / bars) * 0.66;
  const maxH = w * 0.28;
  const base = -w * 0.06;
  const g = (i: number) => Math.exp(-Math.pow((i - (bars - 1) / 2) / (bars * 0.19), 2) / 2);
  const rects: string[] = [];
  const curve: string[] = [];
  for (let i = 0; i < bars; i += 1) {
    const cx = -half + ((2 * half) / bars) * (i + 0.5);
    const h = maxH * g(i);
    rects.push(
      `<rect x="${n(cx - bw / 2)}" y="${n(base - h)}" width="${n(bw)}" height="${n(h)}" ` +
        `fill="${ink}" opacity="${n(0.28 + 0.55 * g(i))}"/>`,
    );
    curve.push(`${i === 0 ? "M" : "L"}${n(cx)},${n(base - h - w * 0.032)}`);
  }
  return (
    rects.join("") +
    `<path d="${curve.join(" ")}" fill="none" stroke="${ink}" stroke-width="${n(w * 0.016)}" stroke-linejoin="round" opacity=".9"/>` +
    `<line x1="${n(-half)}" y1="${n(base)}" x2="${n(half)}" y2="${n(base)}" stroke="${ink}" stroke-width="${n(w * 0.012)}"/>` +
    typeLines(lines, ink, w * 0.14, w * 0.092, w)
  );
}

/** Five blocks, because a fight is three or five and never one. The filled
 * ones are rounds that were scored; the outlines are rounds that did not
 * happen. */
function rounds(w: number, ink: string, lines: readonly string[]): string {
  const count = 5;
  const gap = w * 0.028;
  const bw = (w * 0.86 - gap * (count - 1)) / count;
  const bh = w * 0.19;
  const x0 = -w * 0.43;
  const top = -w * 0.24;
  const filled = [true, true, false, true, false];
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = x0 + i * (bw + gap);
    parts.push(
      `<rect x="${n(x)}" y="${n(top)}" width="${n(bw)}" height="${n(bh)}" rx="${n(w * 0.012)}" ` +
        (filled[i]
          ? `fill="${ink}" opacity=".9"/>`
          : `fill="none" stroke="${ink}" stroke-width="${n(w * 0.014)}" opacity=".7"/>`),
    );
    parts.push(
      `<text x="${n(x + bw / 2)}" y="${n(top + bh + w * 0.082)}" text-anchor="middle" font-family="${MONO}" ` +
        `font-size="${n(w * 0.056)}" fill="${ink}" opacity=".7">R${i + 1}</text>`,
    );
  }
  return parts.join("") + typeLines(lines, ink, w * 0.16, w * 0.098, w);
}

/** A count rule: the stat that settles the argument, drawn the way a
 * scorecard draws it. */
function strikes(w: number, ink: string, lines: readonly string[]): string {
  const half = w * 0.44;
  const y = -w * 0.22;
  const h = w * 0.072;
  const fill = 0.68;
  const ticks: string[] = [];
  for (let i = 1; i < 10; i += 1) {
    const x = -half + ((2 * half) / 10) * i;
    ticks.push(
      `<line x1="${n(x)}" y1="${n(y + h + w * 0.018)}" x2="${n(x)}" y2="${n(y + h + w * 0.055)}" ` +
        `stroke="${ink}" stroke-width="${n(w * 0.008)}" opacity=".5"/>`,
    );
  }
  return (
    `<rect x="${n(-half)}" y="${n(y)}" width="${n(2 * half)}" height="${n(h)}" rx="${n(h / 2)}" ` +
    `fill="none" stroke="${ink}" stroke-width="${n(w * 0.012)}" opacity=".55"/>` +
    `<rect x="${n(-half)}" y="${n(y)}" width="${n(2 * half * fill)}" height="${n(h)}" rx="${n(h / 2)}" fill="${ink}" opacity=".9"/>` +
    ticks.join("") +
    typeLines(lines, ink, w * 0.1, w * 0.098, w) +
    (lines.length
      ? typeLines(
          ["LANDED / ATTEMPTED"],
          ink,
          w * 0.1 + w * 0.098 * 1.34 * lines.length + w * 0.02,
          w * 0.058,
          w,
          MONO,
          ".72",
        )
      : "")
  );
}

/** A spreadsheet, for the person at the watch party who has the tab open. */
function grid(w: number, ink: string, lines: readonly string[]): string {
  const cols = 5;
  const rows = 4;
  const cw = (w * 0.8) / cols;
  const ch = w * 0.06;
  const x0 = -w * 0.4;
  const y0 = -w * 0.28;
  const cells: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const head = r === 0;
      cells.push(
        `<rect x="${n(x0 + c * cw)}" y="${n(y0 + r * ch)}" width="${n(cw)}" height="${n(ch)}" ` +
          `fill="${ink}" fill-opacity="${head ? ".8" : "0"}" stroke="${ink}" ` +
          `stroke-width="${n(w * 0.006)}" stroke-opacity=".55"/>`,
      );
    }
  }
  /* One cell picked out, because there is always one cell. */
  cells.push(
    `<rect x="${n(x0 + 3 * cw)}" y="${n(y0 + 2 * ch)}" width="${n(cw)}" height="${n(ch)}" fill="${ink}" opacity=".9"/>`,
  );
  return cells.join("") + typeLines(lines, ink, w * 0.1, w * 0.086, w, MONO);
}

const MARKS: Record<MarkKind, (w: number, ink: string, lines: readonly string[]) => string> = {
  house,
  dna,
  tape,
  variance,
  rounds,
  strikes,
  grid,
  type: (w, ink, lines) => typeLines(lines, ink, -w * 0.06, w * 0.128, w),
};

/** The permanent, versioned path for a product's preview image. */
export function imagePath(slug: string): string {
  return `/store/img/${slug}-${IMAGE_VERSION}.svg`;
}

/** Which way round the ink goes, taken from the colourway the product leads
 * with. Derived rather than authored: a preview showing gold type on a
 * garment we only sell in white is a preview of a product that does not
 * exist. */
export function toneFor(colors: readonly string[]): ArtTone {
  const lead = String(colors[0] || "").toLowerCase();
  return /white|natural|sand|ash|cream|paper|bone/.test(lead) ? "light" : "dark";
}

export function artSvg({
  form,
  tone,
  mark,
  lines = [],
  label,
}: {
  form: ArtForm;
  tone: ArtTone;
  mark: MarkKind;
  lines?: readonly string[];
  label: string;
}): string {
  const g = GARMENTS[form];
  const cloth = tone === "light" ? CLOTH_LIGHT : CLOTH_DARK;
  const ink = tone === "light" ? INK : GOLD;
  const uid = `${form}-${tone}`;
  const alt = `${label} — design preview, not a photograph`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${IMAGE_W} ${IMAGE_H}" width="${IMAGE_W}" height="${IMAGE_H}" role="img" aria-label="${esc(alt)}">
  <title>${esc(alt)}</title>
  <defs>
    <linearGradient id="ground-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${GROUND_TOP}"/><stop offset="100%" stop-color="${GROUND_BOTTOM}"/>
    </linearGradient>
    <linearGradient id="cloth-${uid}" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="${cloth.body}"/><stop offset="100%" stop-color="${cloth.shade}"/>
    </linearGradient>
  </defs>
  <rect width="${IMAGE_W}" height="${IMAGE_H}" fill="url(#ground-${uid})"/>${
    g.behind
      ? `
  <path d="${g.behind.d}" fill="${g.behind.width ? "none" : `url(#cloth-${uid})`}" stroke="${cloth.seam}" stroke-width="${g.behind.width + 6}" stroke-linecap="round"/>
  <path d="${g.behind.d}" fill="${g.behind.width ? "none" : `url(#cloth-${uid})`}" stroke="${g.behind.width ? cloth.shade : "none"}" stroke-width="${g.behind.width}" stroke-linecap="round"/>`
      : ""
  }
  <path d="${g.body}" fill="url(#cloth-${uid})" stroke="${cloth.seam}" stroke-width="2" stroke-linejoin="round"/>
  <path d="${g.detail}" fill="none" stroke="${cloth.seam}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <g transform="translate(${g.place.x},${g.place.y})">${MARKS[mark](g.place.w, ink, lines)}</g>
</svg>
`;
}
