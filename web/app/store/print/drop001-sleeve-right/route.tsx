import { ImageResponse } from "next/og";
import { OCTAGON, OCTAGON_INNER, fighterNodes } from "@/components/Brand";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/** Stable Printful right-sleeve artwork for Drop 001. */
export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "transparent",
        }}
      >
        <svg width="360" height="720" viewBox="0 0 64 64">
          <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="3.2" strokeLinejoin="round" />
          <polygon points={OCTAGON_INNER} fill="none" stroke="#d4af37" strokeOpacity=".35" strokeWidth="1.2" strokeLinejoin="round" />
          {fighterNodes("#d4af37")}
        </svg>
      </div>
    ),
    {
      width: 450,
      height: 1800,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
