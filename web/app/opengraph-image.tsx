import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const runtime = "edge";
export const alt = "PropBetEdge UFC — Fight Intelligence OS";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OG() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "linear-gradient(135deg, #14110d 0%, #1d1914 60%, #2a241c 100%)", color: "#f5f1eb", fontFamily: "Georgia, serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 28, letterSpacing: 4, color: "#d4af37", fontFamily: "monospace" }}>
          <div style={{ width: 14, height: 14, background: "#d4af37" }} /> PROPBETEDGE · UFC
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 84, fontWeight: 900, lineHeight: 1, letterSpacing: -3 }}>Every card. Every change.</div>
          <div style={{ fontSize: 84, fontWeight: 900, lineHeight: 1, letterSpacing: -3, color: "#d4af37", fontStyle: "italic" }}>Priced before the market moves.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: "#b8b3a8", fontFamily: "monospace" }}>
          <div>{SITE.tagline.toUpperCase()}</div>
          <div>ufc.propbetedge.ai</div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 10, background: "#d4af37" }} />
      </div>
    ),
    size,
  );
}
