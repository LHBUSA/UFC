import { ImageResponse } from "next/og";
import { OCTAGON, OCTAGON_INNER, fighterNodes } from "@/components/Brand";

export const runtime = "edge";

export function GET() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at 30% 18%, #31291e 0%, #14110d 54%, #080705 100%)", position: "relative" }}>
      <svg width="150" height="150" viewBox="0 0 64 64">
        <polygon points={OCTAGON} fill="#0d0b08" stroke="#d4af37" strokeWidth="3.7" strokeLinejoin="round" />
        <polygon points={OCTAGON_INNER} fill="none" stroke="#e9c75a" strokeOpacity=".26" strokeWidth="1.1" strokeLinejoin="round" />
        {fighterNodes()}
      </svg>
    </div>,
    { width: 192, height: 192, headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
  );
}
