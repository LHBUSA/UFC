import { ImageResponse } from "next/og";
import { getVoice } from "@/lib/voices";
import { SITE, GOLD, DIM, PAPER } from "@/lib/site";
import { OgFrame, OgFace } from "@/components/og";
import { ogFonts, OG_SIZE } from "@/lib/og";

export const runtime = "edge";
export const alt = "PropBetEdge UFC — Inside the Fight Game";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function VoiceOG({ params }: { params: Promise<{ key: string }> }) {
  const [fonts, { key }] = await Promise.all([ogFonts(), params]);
  const voice = getVoice(key);
  const image = voice?.image ? `${SITE.url}${voice.image.src}` : null;
  return new ImageResponse(
    (
      <OgFrame kicker="Notable voices · Inside the Fight Game" footer="EDITORIAL DISCOVERY · NOT AN ENDORSEMENT OR PARTNERSHIP">
        <div style={{ display: "flex", alignItems: "center", gap: 52 }}>
          <OgFace src={image} name={voice?.name || "MMA voice"} size={300} />
          <div style={{ display: "flex", flexDirection: "column", gap: 15, flex: 1 }}>
            <div style={{ fontSize: 20, color: GOLD, fontFamily: "Mono, monospace", letterSpacing: 3, textTransform: "uppercase" }}>{voice?.role || "MMA media"}</div>
            <div style={{ fontSize: voice && voice.name.length > 18 ? 56 : 70, fontWeight: 800, letterSpacing: -2, lineHeight: 1, color: PAPER }}>{voice?.name || "Inside the Fight Game"}</div>
            <div style={{ fontSize: 23, color: DIM, lineHeight: 1.36, fontFamily: "Inter, sans-serif", maxWidth: 690 }}>{voice?.descriptor || "Conversations, analysis and perspective from around mixed martial arts."}</div>
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
