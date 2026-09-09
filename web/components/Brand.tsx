/* PropBetEdge UFC brand system: the parent PropBetEdge identity stays primary
 * while the gold fighter/octagon acts as the UFC product badge. The fighter
 * drawing is shared by favicons, app icons and UFC-specific editorial
 * surfaces, and remains part of the global header lockup. */
import Link from "next/link";
import { SITE } from "@/lib/site";

/* The geometry lives in lib/brand-mark.ts and is re-exported here so the many
 * existing importers of `@/components/Brand` keep working. One set of
 * coordinates, used by the header, icons, OG images, store previews and print
 * files. */
export { OCTAGON, OCTAGON_INNER, FIGHTER, fighterSvgMarkup } from "@/lib/brand-mark";
import { FIGHTER, OCTAGON, OCTAGON_INNER } from "@/lib/brand-mark";

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

export function FighterGlyph({ color = "#d4af37", scale = 1 }: { color?: string; scale?: number }) {
  return <>{fighterNodes(color, scale)}</>;
}

export function Mark({ size = 28, className, title = "PropBetEdge UFC fighter mark" }: { size?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title} focusable="false">
      <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="3.2" strokeLinejoin="round" />
      <polygon points={OCTAGON_INNER} fill="none" stroke="#d4af37" strokeOpacity=".35" strokeWidth="1.2" strokeLinejoin="round" />
      <FighterGlyph />
    </svg>
  );
}

export function Logo({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link href={href} className="brand" aria-label="PropBetEdge UFC home">
      <img className="brand-mark" src={SITE.logo.mark160} alt="" width={compact ? 57 : 68} height={compact ? 22 : 27} decoding="async" fetchPriority="high" />
      <span className="brand-word">PropBet<em>Edge</em></span>
      <strong className="brand-tag">UFC</strong>
      <Mark size={compact ? 18 : 21} className="oct brand-product-mark" />
    </Link>
  );
}
