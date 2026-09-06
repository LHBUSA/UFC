import { ImageResponse } from "next/og";
import { OCTAGON, BOLT } from "@/components/Brand";

export const runtime = "edge";
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at 30% 18%, #31291e 0%, #14110d 54%, #080705 100%)", position: "relative" }}>
      <svg width="150" height="150" viewBox="0 0 64 64">
        <polygon points={OCTAGON} fill="#0d0b08" stroke="#d4af37" strokeWidth="3.7" strokeLinejoin="round" />
        <polygon points="50.5,24.3 50.5,39.7 39.7,50.5 24.3,50.5 13.5,39.7 13.5,24.3 24.3,13.5 39.7,13.5" fill="none" stroke="#e9c75a" strokeOpacity=".26" strokeWidth="1.1" strokeLinejoin="round" />
        <polygon points={BOLT} fill="#d4af37" stroke="#f2d66a" strokeWidth=".5" strokeLinejoin="round" />
        <circle cx="50" cy="14" r="3" fill="#c1273d" stroke="#f5f1eb" strokeWidth="1" />
      </svg>
    </div>,
    { width: 192, height: 192, headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
  );
}
