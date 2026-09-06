import { ImageResponse } from "next/og";
import { resolveFighter } from "@/lib/resolve";
import { getImagesForFighters, getFighterBouts } from "@/lib/db";
import { ogFonts, OG_SIZE } from "@/lib/og";
import { OgFrame, OgFace } from "@/components/og";
import { fmtHeight, fmtReach, fmtRecord, stanceLabel, age, archiveSummary } from "@/lib/format";
import { GOLD, DIM, PAPER, FAINT } from "@/lib/site";

export const runtime = "edge";
export const alt = "UFC fighter profile";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const [fonts, f] = await Promise.all([ogFonts(), resolveFighter((await params).slug)]);
  const [imgs, bouts] = f ? await Promise.all([getImagesForFighters([f.id]), getFighterBouts(f.id)]) : [new Map(), []];
  const img = f ? imgs.get(f.id) : null;
  const s = f ? archiveSummary(f.id, bouts) : null;
  const stats: Array<[string, string]> = f ? [
    ["RECORD", fmtRecord(f)], ["AGE", age(f.dob)?.toString() || "—"], ["HEIGHT", fmtHeight(f.height_in)], ["REACH", fmtReach(f.reach_in)], ["STANCE", stanceLabel(f.stance).toUpperCase()],
    ...(s && s.fights ? [["FINISHES", `${s.ko + s.sub} of ${s.w} wins`] as [string, string]] : []),
  ] : [];
  return new ImageResponse(
    (
      <OgFrame kicker="Fighter profile" footer="RECORD · TALE OF THE TAPE · FIGHT HISTORY · ROUND STATS">
        <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
          <OgFace src={img?.card} name={f?.name || "?"} size={300} />
          <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
            {f?.nickname && <div style={{ fontSize: 26, fontStyle: "italic", color: GOLD }}>{`“${f.nickname}”`}</div>}
            <div style={{ fontSize: f && f.name.length > 18 ? 56 : 72, fontWeight: 800, letterSpacing: -2, lineHeight: 1, color: PAPER }}>{f?.name || "Fighter"}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 28, marginTop: 10 }}>
              {stats.map(([k, v]) => (
                <div key={k} style={{ display: "flex", flexDirection: "column", borderLeft: `2px solid ${GOLD}`, paddingLeft: 12 }}>
                  <div style={{ fontSize: 30, color: PAPER, fontFamily: "Mono, monospace", fontWeight: 600 }}>{v}</div>
                  <div style={{ fontSize: 14, color: FAINT, fontFamily: "Mono, monospace", letterSpacing: 2 }}>{k}</div>
                </div>
              ))}
            </div>
            {img?.author && <div style={{ fontSize: 14, color: DIM, fontFamily: "Mono, monospace", marginTop: 8 }}>{`Photo: ${img.author}${img.license ? ` · ${img.license}` : ""} · Wikimedia Commons`}</div>}
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
