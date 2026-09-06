import { ImageResponse } from "next/og";
import { OCTAGON, BOLT } from "@/components/Brand";
import { ogFonts, OG_SIZE } from "@/lib/og";
import { SITE } from "@/lib/site";

export const runtime = "edge";
export const alt = "PropBetEdge UFC — Fight Intelligence";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG() {
  const fonts = await ogFonts();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "linear-gradient(135deg, #14110d 0%, #1d1914 60%, #2a241c 100%)", color: "#f5f1eb", fontFamily: "Playfair, Georgia, serif", position: "relative" }}>
        <svg width="620" height="620" viewBox="0 0 64 64" style={{ position: "absolute", right: -120, top: -80, opacity: 0.08 }}>
          <polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1.5" />
        </svg>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 26, letterSpacing: 5, color: "#d4af37", fontFamily: "Mono, monospace" }}>
          <svg width="56" height="56" viewBox="0 0 64 64"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="3.2" /><polygon points={BOLT} fill="#d4af37" /></svg>
          PROPBETEDGE · UFC
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1, letterSpacing: -3 }}>Every card. Every fighter.</div>
          <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1, letterSpacing: -3, color: "#d4af37" }}>Every round.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#b8b3a8", fontFamily: "Mono, monospace", letterSpacing: 2 }}>
          <div>{`${SITE.tagline.toUpperCase()} · CARDS · FIGHTERS · RANKINGS · NEWS`}</div>
          <div>ufc.propbetedge.ai</div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 10, background: "#d4af37" }} />
      </div>
    ),
    { ...size, fonts },
  );
}
