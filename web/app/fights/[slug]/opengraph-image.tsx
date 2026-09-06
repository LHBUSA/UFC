import { ImageResponse } from "next/og";
import { resolveFight } from "@/lib/resolve";
import { getImagesForFighters } from "@/lib/db";
import { ogFonts, OG_SIZE } from "@/lib/og";
import { OgFrame, OgFace } from "@/components/og";
import { fmtDate, fmtRecord, fmtHeight, fmtReach, weightClassLabel, winnerOf, METHOD_LABEL, cardPositionLabel } from "@/lib/format";
import { GOLD, DIM, PAPER, FAINT } from "@/lib/site";

export const runtime = "edge";
export const alt = "UFC matchup: tale of the tape";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const [fonts, hit] = await Promise.all([ogFonts(), resolveFight((await params).slug)]);
  const b = hit?.b, e = hit?.e;
  const imgs = b ? await getImagesForFighters([b.fighter_a.id, b.fighter_b.id]) : new Map();
  const w = b ? winnerOf(b) : null;
  const rows: Array<[string, string, string]> = b ? [
    [fmtRecord(b.fighter_a), "RECORD", fmtRecord(b.fighter_b)],
    [fmtHeight(b.fighter_a.height_in), "HEIGHT", fmtHeight(b.fighter_b.height_in)],
    [fmtReach(b.fighter_a.reach_in), "REACH", fmtReach(b.fighter_b.reach_in)],
  ] : [];
  return new ImageResponse(
    (
      <OgFrame kicker={e ? `${e.name} · ${fmtDate(e.event_date)}` : "Matchup"} footer={b ? `${weightClassLabel(b.weight_class, b.is_womens)}${b.is_title ? " TITLE BOUT" : ""} · ${cardPositionLabel(b.card_position)}`.toUpperCase() : undefined}>
        {b ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: 300 }}>
              <OgFace src={imgs.get(b.fighter_a.id)?.card} name={b.fighter_a.name} size={220} />
              <div style={{ fontSize: 32, fontWeight: 800, textAlign: "center", lineHeight: 1.05, color: w?.id === b.fighter_a.id ? GOLD : PAPER }}>{b.fighter_a.name}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: 1 }}>
              <div style={{ fontSize: 64, fontStyle: "italic", color: GOLD, fontWeight: 800, lineHeight: 1 }}>{w ? "def." : "vs"}</div>
              {w && b.result ? (
                <div style={{ fontSize: 20, color: DIM, fontFamily: "Mono, monospace", textAlign: "center" }}>{`${w.name} · ${METHOD_LABEL[b.result.method]}${b.result.round ? ` R${b.result.round}` : ""}`}</div>
              ) : rows.map(([l, k, r]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "Mono, monospace" }}>
                  <div style={{ width: 120, textAlign: "right", fontSize: 24, color: PAPER }}>{l}</div>
                  <div style={{ width: 90, textAlign: "center", fontSize: 13, color: FAINT, letterSpacing: 2 }}>{k}</div>
                  <div style={{ width: 120, textAlign: "left", fontSize: 24, color: PAPER }}>{r}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: 300 }}>
              <OgFace src={imgs.get(b.fighter_b.id)?.card} name={b.fighter_b.name} size={220} align="right" />
              <div style={{ fontSize: 32, fontWeight: 800, textAlign: "center", lineHeight: 1.05, color: w?.id === b.fighter_b.id ? GOLD : PAPER }}>{b.fighter_b.name}</div>
            </div>
          </div>
        ) : <div style={{ fontSize: 48, fontWeight: 800 }}>Matchup</div>}
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
