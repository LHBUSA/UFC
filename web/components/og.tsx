/* Shared JSX for server-rendered OG cards (satori). Inline styles only,
 * flex layouts only, no CSS variables. */
import { OCTAGON, BOLT } from "./Brand";
import { GOLD, PAPER, DIM, INK } from "@/lib/site";

export function OgFrame({ children, kicker, footer }: { children: React.ReactNode; kicker: string; footer?: string }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "56px 64px", background: "linear-gradient(135deg, #14110d 0%, #1d1914 60%, #2a241c 100%)", color: PAPER, fontFamily: "Playfair, Georgia, serif", position: "relative" }}>
      <svg width="620" height="620" viewBox="0 0 64 64" style={{ position: "absolute", right: -120, top: -80, opacity: 0.07 }}>
        <polygon points={OCTAGON} fill="none" stroke={GOLD} strokeWidth="1.5" />
      </svg>
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 22, letterSpacing: 4, color: GOLD, fontFamily: "Mono, monospace" }}>
        <svg width="44" height="44" viewBox="0 0 64 64"><polygon points={OCTAGON} fill="none" stroke={GOLD} strokeWidth="3.2" /><polygon points={BOLT} fill={GOLD} /></svg>
        <span style={{ whiteSpace: "nowrap" }}>PROPBETEDGE · UFC</span>
        <span style={{ color: DIM, whiteSpace: "nowrap", overflow: "hidden" }}>{`· ${kicker.length > 48 ? `${kicker.slice(0, 46)}…` : kicker}`.toUpperCase()}</span>
      </div>
      {children}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, color: DIM, fontFamily: "Mono, monospace", letterSpacing: 2 }}>
        <div>{footer || "FIGHT INTELLIGENCE"}</div>
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
            <svg width={size * 0.8} height={size * 0.8} viewBox="0 0 64 64" style={{ position: "absolute", opacity: 0.5 }}><polygon points={OCTAGON} fill="none" stroke={GOLD} strokeWidth="1.8" /></svg>
            <div style={{ fontSize: size * 0.32, color: GOLD, fontWeight: 800 }}>{initials}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export const OG_BG = INK;
