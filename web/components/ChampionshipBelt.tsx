import { OCTAGON, fighterNodes } from "@/components/Brand";

/* Original PropBetEdge championship hardware.
 *
 * Deliberately NOT a reproduction of UFC championship-belt artwork. It uses
 * only the universal language of a dark strap with a gold center plate, and
 * the plate carries the PropBetEdge octagon/fighter identity. Geometry is
 * symmetric and simple so it stays crisp from 118px to 300px wide. */
export function ChampionshipBelt({ size = "card", label = "Champion" }: { size?: "mini" | "card" | "hero"; label?: string }) {
  const width = size === "hero" ? 320 : size === "mini" ? 118 : 200;
  const height = Math.round(width * 0.375);
  const id = `belt-${size}`;
  return (
    <div className={`pbe-belt pbe-belt-${size}`} role="img" aria-label={`${label} — PropBetEdge championship mark`}>
      <svg viewBox="0 0 320 120" width={width} height={height} aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f6df8a" /><stop offset=".45" stopColor="#d4af37" /><stop offset="1" stopColor="#8f6a14" /></linearGradient>
          <linearGradient id={`${id}-gold2`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e9c75a" /><stop offset="1" stopColor="#a47c1c" /></linearGradient>
          <linearGradient id={`${id}-strap`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2a241c" /><stop offset=".5" stopColor="#15120e" /><stop offset="1" stopColor="#0a0907" /></linearGradient>
          <radialGradient id={`${id}-plate`} cx=".5" cy=".35" r=".7"><stop offset="0" stopColor="#1d1914" /><stop offset="1" stopColor="#0a0907" /></radialGradient>
        </defs>
        <rect x="6" y="38" width="308" height="44" rx="6" fill={`url(#${id}-strap)`} stroke="#3a3124" strokeWidth="1.5" />
        <rect x="6" y="41" width="308" height="1.5" fill="rgba(255,245,220,.10)" />
        <rect x="6" y="77" width="308" height="1.5" fill="rgba(0,0,0,.5)" />
        <rect x="14" y="46" width="292" height="28" rx="4" fill="none" stroke="#d4af37" strokeOpacity=".28" strokeWidth="1" strokeDasharray="3 3" />
        <path d="M44 44h38l8 8v16l-8 8H44l-8-8V52z" fill={`url(#${id}-gold2)`} stroke="#f3d77a" strokeWidth="1.2" />
        <path d="M50 50h26l5 5v10l-5 5H50l-5-5V55z" fill={`url(#${id}-plate)`} stroke="#6a5118" strokeWidth="1" />
        <path d="M238 44h38l8 8v16l-8 8h-38l-8-8V52z" fill={`url(#${id}-gold2)`} stroke="#f3d77a" strokeWidth="1.2" />
        <path d="M244 50h26l5 5v10l-5 5h-26l-5-5V55z" fill={`url(#${id}-plate)`} stroke="#6a5118" strokeWidth="1" />
        <g transform="translate(160 60)">
          <polygon points="-52,-22 -22,-52 22,-52 52,-22 52,22 22,52 -22,52 -52,22" fill={`url(#${id}-gold)`} stroke="#f6df8a" strokeWidth="2" />
          <polygon points="-45,-19 -19,-45 19,-45 45,-19 45,19 19,45 -19,45 -45,19" fill={`url(#${id}-plate)`} stroke="#7a5c18" strokeWidth="1.2" />
          <polygon points="-38,-16 -16,-38 16,-38 38,-16 38,16 16,38 -16,38 -38,16" fill="none" stroke="#d4af37" strokeOpacity=".35" strokeWidth="1" />
          <g transform="translate(-32 -32)">
            <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="3" strokeLinejoin="round" />
            {fighterNodes()}
          </g>
        </g>
      </svg>
    </div>
  );
}
