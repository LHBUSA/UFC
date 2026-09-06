/* PropBetEdge UFC brand system: a gold octagon (the cage) carrying the
 * PropBetEdge bolt (the "E" in the parent mark). Vector, theme-safe, and
 * legible from 16px favicon to 1200px OG card. */
import Link from "next/link";
import { SITE } from "@/lib/site";

export const OCTAGON = "55.1,22.4 55.1,41.6 41.6,55.1 22.4,55.1 8.9,41.6 8.9,22.4 22.4,8.9 41.6,8.9";
export const BOLT = "37,13 22,35.5 31,35.5 27,51 42,28.5 33,28.5";

export function Mark({ size = 28, className, title = "PropBetEdge UFC" }: { size?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title} focusable="false">
      <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="3.2" strokeLinejoin="round" />
      <polygon points="50.5,24.3 50.5,39.7 39.7,50.5 24.3,50.5 13.5,39.7 13.5,24.3 24.3,13.5 39.7,13.5" fill="none" stroke="#d4af37" strokeOpacity=".35" strokeWidth="1.2" strokeLinejoin="round" />
      <polygon points={BOLT} fill="#d4af37" />
    </svg>
  );
}

/* Canonical PropBetEdge network mark (the chrome PBE lettering shared with
 * propbetedge.ai and nfl.propbetedge.ai) + wordmark + UFC product tag. The
 * octagon/bolt Mark stays as the UFC-specific icon. */
export function Logo({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link href={href} className="brand" aria-label="PropBetEdge UFC home">
      <img className="brand-mark" src={SITE.logo.mark160} alt="PropBetEdge" width={72} height={28} decoding="async" fetchPriority="high" />
      <span className="brand-word">PropBet<em>Edge</em></span>
      <strong className="brand-tag">UFC</strong>
      {!compact && <Mark size={22} className="oct" />}
    </Link>
  );
}
