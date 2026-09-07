import type { RefereeProfile } from "@/lib/referees";
import { portrait, refereePacket } from "@/lib/enrichment";

/* Shared referee directory pieces.
 *
 * Portrait precedence: an enrichment packet portrait (licensed Commons image,
 * first-party hosted derivative, full attribution) → a rights-cleared image on
 * the directory row → the monogram plate. The monogram now means the media
 * pipeline searched approved sources and found nothing usable; the packet
 * records the rejected candidates and why. Never a stock or unrelated photo. */
export const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

export function refereeImage(r: RefereeProfile, slot: "avatar" | "card" | "profile" = "card") {
  const p = portrait(refereePacket(r.slug), slot);
  if (p) return p;
  if (r.image_url) return { src: r.image_url, alt: r.display_name, attribution: [r.image_credit, r.image_license].filter(Boolean).join(" · ") || "Rights-cleared image", sourcePage: r.image_source_url || "", license: r.image_license || "", status: "approved" as const };
  return null;
}

export function RefereePhoto({ r, size = "sm" }: { r: RefereeProfile; size?: "sm" | "lg" }) {
  const img = refereeImage(r, size === "lg" ? "profile" : "avatar");
  return (
    <span className={`ref-photo${size === "lg" ? " lg" : ""}`}>
      {img ? <img src={img.src} alt={r.display_name} loading="lazy" decoding="async" /> : <b aria-hidden="true">{initials(r.display_name)}</b>}
    </span>
  );
}

const year = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).getUTCFullYear() : null);

export function tenureLine(r: RefereeProfile): string | null {
  const a = year(r.first_event_date), b = year(r.last_event_date);
  if (!a || !b) return null;
  return a === b ? `${a}` : `${a}–${b}`;
}
