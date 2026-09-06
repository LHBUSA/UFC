import { Mark } from "@/components/Brand";

/* Original PropBetEdge championship hardware.
 * This deliberately does NOT reproduce the UFC championship belt artwork.
 * It borrows only the universal visual language of a black strap + gold
 * championship plate, with the PropBetEdge octagon/fighter identity centered.
 */
export function ChampionshipBelt({ size = "card", label = "Champion" }: { size?: "mini" | "card" | "hero"; label?: string }) {
  const width = size === "hero" ? 300 : size === "mini" ? 118 : 190;
  const height = Math.round(width * .43);
  return (
    <div className={`pbe-belt pbe-belt-${size}`} role="img" aria-label={`${label} championship belt`}>
      <svg viewBox="0 0 320 138" width={width} height={height} aria-hidden="true">
        <defs>
          <linearGradient id="belt-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f3d77a" />
            <stop offset=".38" stopColor="#d4af37" />
            <stop offset=".7" stopColor="#9d7416" />
            <stop offset="1" stopColor="#e7c45a" />
          </linearGradient>
          <linearGradient id="belt-strap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#211d18" />
            <stop offset="1" stopColor="#090806" />
          </linearGradient>
          <filter id="belt-shadow" x="-20%" y="-30%" width="140%" height="170%">
            <feDropShadow dx="0" dy="7" stdDeviation="6" floodOpacity=".55" />
          </filter>
        </defs>
        <path d="M5 48C42 43 69 38 96 30h128c28 8 55 13 91 18l-9 46c-37-3-62-1-88 7H102c-27-8-52-10-89-7L5 48Z" fill="url(#belt-strap)" stroke="#3e3528" strokeWidth="3" filter="url(#belt-shadow)" />
        <path d="M13 59c31-2 55-5 82-13v39c-24-5-48-7-77-5l-5-21Zm294 0c-31-2-55-5-82-13v39c24-5 48-7 77-5l5-21Z" fill="#15120f" stroke="#69551f" strokeWidth="1.5" />
        <path d="M104 23h112l25 24-9 45-24 23h-96L88 92l-9-45 25-24Z" fill="url(#belt-gold)" stroke="#f3d77a" strokeWidth="2.5" />
        <path d="M112 33h96l19 18-7 34-18 18h-84l-18-18-7-34 19-18Z" fill="#17130d" stroke="#6f5519" strokeWidth="2" />
        <path d="M132 40h56l18 17-5 27-16 13h-50l-16-13-5-27 18-17Z" fill="#0c0a07" stroke="#d4af37" strokeWidth="2" />
        <path d="M35 56h42l10 9-8 15H37l-8-10 6-14Zm208 0h42l6 14-8 10h-42l-8-15 10-9Z" fill="#d4af37" opacity=".82" />
        <path d="M45 62h25l6 5-4 7H45l-5-5 5-7Zm205 0h25l5 7-5 5h-27l-4-7 6-5Z" fill="#12100d" />
        <text x="160" y="116" textAnchor="middle" fill="#5f4712" fontSize="8" fontWeight="900" letterSpacing="2">PROPBETEDGE</text>
      </svg>
      <span className="pbe-belt-mark"><Mark size={size === "hero" ? 56 : size === "mini" ? 26 : 38} title="PropBetEdge championship mark" /></span>
    </div>
  );
}
