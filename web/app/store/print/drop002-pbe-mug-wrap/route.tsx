import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Printful-ready wrap artwork for the Drop 002 black glossy mug.
 *
 * The black blank supplies the background; Printful explicitly recommends a
 * transparent source file for this product. The artwork therefore contains
 * only the same canonical full PBE mark used on the hoodie, centred with
 * generous wrap-safe space on both sides.
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
          width={2050}
          height={810}
          alt=""
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    {
      /* 2.43:1 follows the black glossy 11 oz wrap aspect ratio. Higher than
       * the provider template resolution so Printful can downsample cleanly. */
      width: 2880,
      height: 1184,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
