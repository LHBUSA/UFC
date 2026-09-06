import { ImageResponse } from "next/og";
import { resolveEvent } from "@/lib/resolve";
import { getEventBouts, getImagesForFighters } from "@/lib/db";
import { ogFonts, OG_SIZE } from "@/lib/og";
import { OgFrame, OgFace } from "@/components/og";
import { fmtDate, fmtRecord, locationLine, weightClassLabel, winnerOf, METHOD_LABEL } from "@/lib/format";
import { GOLD, DIM, PAPER } from "@/lib/site";

export const runtime = "edge";
export const alt = "UFC event card";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const [fonts, e] = await Promise.all([ogFonts(), resolveEvent((await params).slug)]);
  const bouts = e ? await getEventBouts(e.id) : [];
  const main = bouts.find((b) => b.status !== "cancelled") || null;
  const imgs = main ? await getImagesForFighters([main.fighter_a.id, main.fighter_b.id]) : new Map();
  const w = main ? winnerOf(main) : null;
  return new ImageResponse(
    (
      <OgFrame kicker={e ? fmtDate(e.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "Event"} footer={e ? (locationLine(e) || "UFC").toUpperCase() : undefined}>
        {main ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
            <OgFace src={imgs.get(main.fighter_a.id)?.card} name={main.fighter_a.name} size={250} />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, flex: 1 }}>
              <div style={{ fontSize: 22, color: GOLD, fontFamily: "Mono, monospace", letterSpacing: 3 }}>{(weightClassLabel(main.weight_class, main.is_womens) + (main.is_title ? " TITLE" : " MAIN EVENT")).toUpperCase()}</div>
              <div style={{ fontSize: 40, fontWeight: 800, textAlign: "center", lineHeight: 1.05 }}>{main.fighter_a.name}</div>
              <div style={{ fontSize: 44, fontStyle: "italic", color: GOLD, fontWeight: 800 }}>{w ? "def." : "vs"}</div>
              <div style={{ fontSize: 40, fontWeight: 800, textAlign: "center", lineHeight: 1.05 }}>{w ? (w.id === main.fighter_a.id ? main.fighter_b.name : main.fighter_a.name) : main.fighter_b.name}</div>
              <div style={{ fontSize: 20, color: DIM, fontFamily: "Mono, monospace" }}>{w && main.result ? `${w.name} · ${METHOD_LABEL[main.result.method]}${main.result.round ? ` R${main.result.round}` : ""}` : `${fmtRecord(main.fighter_a)}  ·  ${fmtRecord(main.fighter_b)}`}</div>
            </div>
            <OgFace src={imgs.get(main.fighter_b.id)?.card} name={main.fighter_b.name} size={250} align="right" />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 30, color: GOLD, fontFamily: "Mono, monospace", letterSpacing: 3 }}>CARD ANNOUNCEMENT PENDING</div>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: e && e.name.length > 34 ? 44 : 56, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.05, color: PAPER }}>{e?.name || "UFC event"}</div>
          {bouts.length > 0 && <div style={{ fontSize: 20, color: DIM, fontFamily: "Mono, monospace", letterSpacing: 2 }}>{`${bouts.filter((b) => b.status !== "cancelled").length} BOUTS · ${e?.card_status === "complete" ? "FULL RESULTS & ROUND STATS" : "FULL CARD, TALE OF THE TAPE, MATCHUPS"}`}</div>}
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
