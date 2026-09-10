/* Image variant system.
 *
 * One portrait record, many surfaces. Every surface asks for a slot and gets
 * the best stored derivative plus a safe focal position, instead of hoping a
 * CSS `object-position: top center` happens to keep the face in frame.
 *
 * Slots
 *   avatar  square, safe face crop (thumb / sq derivative)
 *   card    portrait card crop (card / tall derivative)
 *   hero    wide cinematic crop (hero derivative or the source portrait)
 *   og      share-safe crop (card, face-centered)
 *   desk    Pregame Desk panel: tall portrait with the head in the upper third
 *   rail    content-rail crop (card, lower-third-safe)
 *
 * Framing metadata (focal point, detected head box, art-directed derivatives)
 * comes from ufc_images when the art-direction columns exist; when they do
 * not, the slot defaults below keep heads in frame for the portrait pipeline's
 * 4:5 card.jpg / portrait.jpg outputs. ESPN display-only headshots are flagged
 * so the UI can stage them instead of cover-cropping a transparent PNG. */
import { mediaUrl, type PortraitSet } from "@/lib/db";

export type ArtSlot = "avatar" | "card" | "hero" | "og" | "desk" | "rail";

export type Framing = {
  focal_x: number | null;
  focal_y: number | null;
  face_box: { x: number; y: number; w: number; h: number } | null;
  framing_status: string | null;
  framing_confidence: number | null;
  framing_at: string | null;
  derivatives: Record<string, { key?: string; w?: number; h?: number; mode?: string; focal?: { x: number; y: number }; face?: { x: number; y: number; w: number; h: number } | null }> | null;
};

export type Variant = {
  src: string;
  objectPosition: string;
  width: number;
  height: number;
  mode: "cover" | "staged" | "badge";
  confidence: "high" | "medium" | "low";
  slot: ArtSlot;
  source_url: string | null;
  attribution: string | null;
  license: string | null;
  verified_at: string | null;
};

/* Which stored derivative each slot prefers, in order. */
const DERIVATIVE_PREFERENCE: Record<ArtSlot, string[]> = {
  avatar: ["sq", "tall", "card"],
  card: ["tall", "card"],
  hero: ["hero", "wide", "card"],
  og: ["sq", "tall", "card"],
  desk: ["tall", "hero_m", "card"],
  rail: ["card", "wide", "tall"],
};

/* Focal defaults per slot when no detector data exists (x%, y%). The portrait
 * pipeline composes card.jpg with the head in the upper third, so a focal
 * slightly below the top keeps hair and chin inside tall frames. */
const SLOT_DEFAULT_FOCAL: Record<ArtSlot, string> = {
  avatar: "50% 24%",
  card: "50% 18%",
  hero: "50% 26%",
  og: "50% 30%",
  desk: "50% 16%",
  rail: "50% 22%",
};

const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10}%`;

export function pickVariant(img: PortraitSet | null | undefined, slot: ArtSlot, framing?: Framing | null): Variant | null {
  if (!img) return null;
  /* Staged as a badge: ESPN headshots (transparent studio PNGs). A reviewed
   * Commons photo that is hotlinked rather than stored is still a photograph
   * and is cropped like one. */
  const displayOnly = img.kind === "display_fallback" || img.source_family === "espn";
  const attribution = img.attribution_text || (img.author ? `${img.author}${img.license ? ` · ${img.license}` : ""}` : null);
  const base = { slot, source_url: img.source_url, attribution, license: img.license, verified_at: framing?.framing_at || null };

  /* ESPN / provider headshots: small transparent PNGs. Never cover-crop them
   * into a tall frame; stage them as a badge over a branded backdrop. */
  if (displayOnly) return { ...base, src: img.card, objectPosition: "50% 50%", width: 350, height: 254, mode: "badge", confidence: "medium" };

  /* Art-directed derivative for this slot, when the framing run produced one. */
  const derivs = framing?.derivatives || null;
  if (derivs) {
    for (const key of DERIVATIVE_PREFERENCE[slot]) {
      const d = derivs[key];
      if (d?.key) {
        const focal = d.focal ? `${pct(d.focal.x)} ${pct(d.focal.y)}` : SLOT_DEFAULT_FOCAL[slot];
        return { ...base, src: mediaUrl(d.key), objectPosition: focal, width: d.w || 800, height: d.h || 1000, mode: d.mode === "staged" ? "staged" : "cover", confidence: framing?.framing_status === "ok" ? "high" : "medium" };
      }
    }
  }

  /* Stored siblings (portrait / card / thumb) with a detector focal when known. */
  const focal = framing && framing.focal_x != null && framing.focal_y != null ? `${pct(Number(framing.focal_x))} ${pct(Number(framing.focal_y))}` : SLOT_DEFAULT_FOCAL[slot];
  const conf: Variant["confidence"] = framing?.framing_status === "ok" ? "high" : framing?.framing_status === "no_face" ? "low" : "medium";
  const src = slot === "avatar" ? img.thumb : slot === "hero" ? img.portrait : img.card;
  const size = slot === "avatar" ? { width: 200, height: 200 } : slot === "hero" ? { width: 1200, height: 1500 } : { width: 800, height: 1000 };
  return { ...base, src, objectPosition: focal, ...size, mode: "cover", confidence: conf };
}

/* Composition decision for a two-fighter module. */
export function composeDesk(a: Variant | null, b: Variant | null): "duo" | "single-a" | "single-b" | "fallback" {
  const good = (v: Variant | null) => Boolean(v && v.mode !== "badge" && v.confidence !== "low");
  if (good(a) && good(b)) return "duo";
  if (good(a)) return "single-a";
  if (good(b)) return "single-b";
  return "fallback";
}
