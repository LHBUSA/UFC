import { ImageResponse } from "next/og";
import { OCTAGON, BOLT } from "@/components/Brand";

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#14110d" }}>
        <svg width="150" height="150" viewBox="0 0 64 64">
          <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="3.4" strokeLinejoin="round" />
          <polygon points={BOLT} fill="#d4af37" />
        </svg>
      </div>
    ),
    size,
  );
}
