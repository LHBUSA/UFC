import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Printful-ready front artwork for Drop 001.
 *
 * The garment mockup already uses the canonical parent-network asset at
 * SITE.logo.full600. This endpoint places that exact approved asset on the
 * live 1800x1800 Printful front canvas, with no garment/background baked in.
 * Keeping the print URL on ufc.propbetedge.ai gives fulfillment a stable,
 * versioned URL instead of an operator-uploaded one-off file.
 */
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
        <img
          src={SITE.logo.full600}
          width={1380}
          height={720}
          alt=""
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    {
      width: 1800,
      height: 1800,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
