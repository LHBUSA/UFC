/**
 * Design previews, drawn as inline SVG from the brand tokens.
 *
 * These are explicitly NOT product photographs and the page says so. Printful
 * generates real garment mockups from the uploaded artwork, and those replace
 * these the moment a product has actually been provisioned. Shipping a
 * photo-realistic fake would imply a physical object nobody has ever seen, in
 * a shop that holds no inventory, which is the exact impression this store
 * must not create.
 *
 * Vector, so the collection page costs no image bandwidth and stays sharp at
 * any size, and so it cannot be mistaken for a photograph at any size either.
 */
import type { Form } from "@/lib/store/types";

const GOLD = "#d4af37";
const PAPER = "#f5f1eb";
const INK = "#14110d";

function octagonPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(" ");
}

/* The garment silhouettes. Deliberately flat and diagrammatic: a shape that
 * says "tee" without pretending to be a photograph of one. */
const SHAPES: Record<Form, string> = {
  tee: "M92 74 L142 52 Q160 46 168 62 L196 108 L170 126 L156 106 L156 250 Q156 258 148 258 L92 258 Q84 258 84 250 L84 106 L70 126 L44 108 L72 62 Q80 46 98 52 Z",
  hoodie:
    "M92 76 L140 54 Q160 48 168 64 L198 112 L172 130 L158 110 L158 252 Q158 260 150 260 L90 260 Q82 260 82 252 L82 110 L68 130 L42 112 L72 64 Q80 48 100 54 Z M108 54 Q120 74 132 54",
  cap: "M56 176 Q56 106 120 106 Q184 106 184 176 L196 176 Q206 176 206 186 L206 194 Q206 202 196 202 L56 202 Q46 202 46 194 L46 186 Q46 176 56 176 Z",
  mug: "M62 108 L172 108 L166 244 Q165 254 154 254 L80 254 Q69 254 68 244 Z M172 138 Q212 138 212 172 Q212 206 172 206",
};

/* Where the artwork sits on each shape, and how big. */
const ART: Record<Form, { x: number; y: number; w: number }> = {
  tee: { x: 120, y: 150, w: 46 },
  hoodie: { x: 120, y: 158, w: 44 },
  cap: { x: 120, y: 158, w: 34 },
  mug: { x: 117, y: 178, w: 44 },
};

export function StoreArt({
  form,
  label,
  tone = "gold",
  className = "",
}: {
  form: Form;
  label: string;
  tone?: "gold" | "paper";
  className?: string;
}) {
  const stroke = tone === "gold" ? GOLD : PAPER;
  const art = ART[form];
  return (
    <svg className={`st-art ${className}`} viewBox="0 0 240 300" role="img" aria-label={`${label} — design preview, not a photograph`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={`st-g-${form}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#221d17" />
          <stop offset="100%" stopColor="#171310" />
        </linearGradient>
      </defs>
      <rect width="240" height="300" fill={INK} />
      <path d={SHAPES[form]} fill={`url(#st-g-${form})`} stroke="rgba(255,245,220,.16)" strokeWidth="1.5" strokeLinejoin="round" />
      <g transform={`translate(${art.x},${art.y})`}>
        <polygon points={octagonPoints(art.w / 2)} fill="none" stroke={stroke} strokeWidth="1.6" opacity=".9" />
        <circle cx="0" cy="0" r={art.w * 0.1} fill={stroke} />
      </g>
    </svg>
  );
}
