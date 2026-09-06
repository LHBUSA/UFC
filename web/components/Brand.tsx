/* PropBetEdge UFC brand system: a gold octagon (the cage) carrying the
 * PropBetEdge fighter — a silhouette in guard stance. Vector, theme-safe, and
 * legible from 16px favicon to 1200px OG card. The same primitives feed the
 * DOM mark, the static favicon/brand SVGs, the generated app icons and every
 * server-rendered share card, so the identity is one drawing everywhere. */
import Link from "next/link";

export const OCTAGON = "55.1,22.4 55.1,41.6 41.6,55.1 22.4,55.1 8.9,41.6 8.9,22.4 22.4,8.9 41.6,8.9";
export const OCTAGON_INNER = "50.5,24.3 50.5,39.7 39.7,50.5 24.3,50.5 13.5,39.7 13.5,24.3 24.3,13.5 39.7,13.5";

/* Fighter silhouette, drawn in the 64×64 octagon space: head, torso, both
 * arms in a high guard, staggered stance. Limbs are round-capped strokes so
 * the figure stays readable when rasterised small. */
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

/* The fighter as SVG children. Returned as a plain array of primitive
 * elements (not a component and not a <g>): satori serialises an <svg>
 * subtree without executing nested components, so OG cards and app icons
 * would otherwise render an empty octagon. Call it as {fighterNodes()}. */
export function fighterNodes(color = "#d4af37", scale = 1) {
  const limb = { fill: "none", stroke: color, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return [
    <circle key="head" cx={FIGHTER.head.cx} cy={FIGHTER.head.cy} r={FIGHTER.head.r} fill={color} />,
    <path key="torso" d={FIGHTER.torso} fill={color} stroke={color} strokeWidth={1.2 * scale} strokeLinejoin="round" />,
    <path key="rear-arm" d={FIGHTER.rearArm} {...limb} strokeWidth={FIGHTER.armWidth * scale} />,
    <path key="lead-arm" d={FIGHTER.leadArm} {...limb} strokeWidth={FIGHTER.armWidth * scale} />,
    <path key="rear-leg" d={FIGHTER.rearLeg} {...limb} strokeWidth={FIGHTER.legWidth * scale} />,
    <path key="lead-leg" d={FIGHTER.leadLeg} {...limb} strokeWidth={FIGHTER.legWidth * scale} />,
  ];
}

/* DOM convenience wrapper (never use inside satori-rendered <svg>). */
export function FighterGlyph({ color = "#d4af37", scale = 1 }: { color?: string; scale?: number }) {
  return <>{fighterNodes(color, scale)}</>;
}

/* Static SVG markup of the same drawing, for files that cannot be React
 * (public/brand/mark.svg, app/icon.svg). Kept here so a future redraw only
 * happens in one place. */
export function fighterSvgMarkup(color = "#d4af37"): string {
  const f = FIGHTER;
  return `<g fill="${color}" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">`
    + `<circle cx="${f.head.cx}" cy="${f.head.cy}" r="${f.head.r}" stroke="none"/>`
    + `<path d="${f.torso}" stroke-width="1.2"/>`
    + `<path d="${f.rearArm}" fill="none" stroke-width="${f.armWidth}"/>`
    + `<path d="${f.leadArm}" fill="none" stroke-width="${f.armWidth}"/>`
    + `<path d="${f.rearLeg}" fill="none" stroke-width="${f.legWidth}"/>`
    + `<path d="${f.leadLeg}" fill="none" stroke-width="${f.legWidth}"/>`
    + `</g>`;
}

export function Mark({ size = 28, className, title = "PropBetEdge UFC" }: { size?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title} focusable="false">
      <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="3.2" strokeLinejoin="round" />
      <polygon points={OCTAGON_INNER} fill="none" stroke="#d4af37" strokeOpacity=".35" strokeWidth="1.2" strokeLinejoin="round" />
      <FighterGlyph />
    </svg>
  );
}

/* The fighter/octagon is the canonical UFC product icon. The broader network
 * raster mark remains available to intentionally network-branded surfaces
 * such as the footer, but it does not compete with the UFC identity here. */
export function Logo({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link href={href} className="brand" aria-label="PropBetEdge UFC home">
      <Mark size={compact ? 25 : 30} className="brand-mark oct" />
      <span className="brand-word">PropBet<em>Edge</em></span>
      <strong className="brand-tag">UFC</strong>
    </Link>
  );
}
