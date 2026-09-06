/* Shared JSX for server-rendered OG cards (satori). Inline styles only,
 * flex layouts only, no CSS variables.
 *
 * Share-card hierarchy: the fighter emblem leads, then PROPBETEDGE / FIGHT
 * INTELLIGENCE, then the contextual content — so a shared link reads as UFC
 * PropBetEdge before anyone reads the domain. */
import { OCTAGON, OCTAGON_INNER, fighterNodes } from "./Brand";
import { GOLD, PAPER, DIM, INK } from "@/lib/site";

export function OgEmblem({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <polygon points={OCTAGON} fill="#0d0b08" stroke={GOLD} strokeWidth="3.4" strokeLinejoin="round" />
      <polygon points={OCTAGON_INNER} fill="none" stroke={GOLD} strokeOpacity=".3" strokeWidth="1.1" strokeLinejoin="round" />
      {fighterNodes()}
    </svg>
  );
}

export function OgBrand({ kicker, emblem = 96 }: { kicker?: string; emblem?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
      <OgEmblem size={emblem} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: "Mono, monospace" }}>
        <div style={{ fontSize: 30, letterSpacing: 6, color: GOLD, fontWeight: 600 }}>PROPBETEDGE</div>
        <div style={{ fontSize: 18, letterSpacing: 5, color: DIM }}>FIGHT INTELLIGENCE</div>
      </div>
      {kicker && (
        <div style={{ display: "flex", marginLeft: "auto", fontSize: 18, letterSpacing: 3, color: DIM, fontFamily: "Mono, monospace", whiteSpace: "nowrap", overflow: "hidden", maxWidth: 520 }}>
          {(kicker.length > 52 ? `${kicker.slice(0, 50)}…` : kicker).toUpperCase()}
        </div>
      )}
    </div>
  );
}

export function OgFrame({ children, kicker, footer }: { children: React.ReactNode; kicker: string; footer?: string }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "48px 64px 52px", background: "linear-gradient(135deg, #14110d 0%, #1d1914 60%, #2a241c 100%)", color: PAPER, fontFamily: "Playfair, Georgia, serif", position: "relative" }}>
      <svg width="720" height="720" viewBox="0 0 64 64" style={{ position: "absolute", right: -150, top: -110, opacity: 0.06 }}>
        <polygon points={OCTAGON} fill="none" stroke={GOLD} strokeWidth="1.5" />
        {fighterNodes()}
      </svg>
      <OgBrand kicker={kicker} />
      {children}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, color: DIM, fontFamily: "Mono, monospace", letterSpacing: 2 }}>
        <div>{footer || "UFC · CARDS · FIGHTERS · RANKINGS · NEWSROOM"}</div>
        <div>ufc.propbetedge.ai</div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 10, background: GOLD }} />
    </div>
  );
}

export function OgFace({ src, name, size = 260, align = "left" }: { src?: string | null; name: string; size?: number; align?: "left" | "right" }) {
  const initials = name.trim().split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "left" ? "flex-start" : "flex-end", gap: 14, width: size + 40 }}>
      <div style={{ width: size, height: size, borderRadius: 24, overflow: "hidden", border: `2px solid ${GOLD}`, background: "#2a241c", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        {src ? <img src={src} width={size} height={size} style={{ objectFit: "cover", objectPosition: "center 32%", width: size, height: size }} alt="" /> : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", position: "relative" }}>
            <svg width={size * 0.8} height={size * 0.8} viewBox="0 0 64 64" style={{ position: "absolute", opacity: 0.35 }}><polygon points={OCTAGON} fill="none" stroke={GOLD} strokeWidth="1.8" />{fighterNodes()}</svg>
            <div style={{ fontSize: size * 0.32, color: GOLD, fontWeight: 800 }}>{initials}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export const OG_BG = INK;
