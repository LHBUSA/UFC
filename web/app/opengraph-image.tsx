import { ImageResponse } from "next/og";
import { OCTAGON, fighterNodes } from "@/components/Brand";
import { OgEmblem } from "@/components/og";
import { ogFonts, OG_SIZE } from "@/lib/og";

export const runtime = "edge";
export const alt = "PropBetEdge UFC — Fight Intelligence";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG() {
  const fonts = await ogFonts();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "60px 72px", background: "linear-gradient(135deg, #14110d 0%, #1d1914 60%, #2a241c 100%)", color: "#f5f1eb", fontFamily: "Playfair, Georgia, serif", position: "relative" }}>
        <svg width="760" height="760" viewBox="0 0 64 64" style={{ position: "absolute", right: -160, top: -120, opacity: 0.06 }}>
          <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1.5" />
          {fighterNodes()}
        </svg>
        <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
          <OgEmblem size={168} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontFamily: "Mono, monospace" }}>
            <div style={{ fontSize: 44, letterSpacing: 9, color: "#d4af37", fontWeight: 600 }}>PROPBETEDGE</div>
            <div style={{ fontSize: 24, letterSpacing: 7, color: "#b8b3a8" }}>FIGHT INTELLIGENCE</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1, letterSpacing: -2.5 }}>Every card. Every fighter.</div>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1, letterSpacing: -2.5, color: "#d4af37" }}>Every round.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: "#b8b3a8", fontFamily: "Mono, monospace", letterSpacing: 2 }}>
          <div>{`UFC · CARDS · FIGHTERS · RANKINGS · NEWSROOM`}</div>
          <div>ufc.propbetedge.ai</div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 10, background: "#d4af37" }} />
      </div>
    ),
    { ...size, fonts },
  );
}
