import type { RefereeProfile } from "@/lib/referees";

/* Shared referee directory pieces. Photo only when the directory holds a
 * rights-cleared image (image_url + license/credit columns in
 * ufc_referee_directory); otherwise a monogram plate — never a stock or
 * unrelated photo. */
export const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

export function RefereePhoto({ r, size = "sm" }: { r: RefereeProfile; size?: "sm" | "lg" }) {
  return <span className={`ref-photo${size === "lg" ? " lg" : ""}`}>{r.image_url ? <img src={r.image_url} alt={r.display_name} loading="lazy" decoding="async" /> : <b aria-hidden="true">{initials(r.display_name)}</b>}</span>;
}

const year = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).getUTCFullYear() : null);

export function tenureLine(r: RefereeProfile): string | null {
  const a = year(r.first_event_date), b = year(r.last_event_date);
  if (!a || !b) return null;
  return a === b ? `${a}` : `${a}–${b}`;
}
