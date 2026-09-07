/* Typed reader over the generated enrichment packets.
 *
 * scripts/referees/* and scripts/hof/* write one source packet per subject to
 * data/<type>/<slug>.json and roll them into web/lib/generated/enrichment.json.
 * The web imports that single static file — no runtime filesystem access, so
 * it works unchanged on Vercel. Every claim in a packet carries its value,
 * source, method and verification time; this module only reads them.
 *
 * A missing packet, a missing claim or a missing image is normal and must
 * render as "unavailable", never as a guess. */
import data from "@/lib/generated/enrichment.json";

export type Claim<T> = { value: T; source: string | null; method: string; verified_at: string };

export type MediaBlock = {
  subject_type: string; subject_id: string; subject_name: string;
  source_url: string; source_page_url: string; source_name: string;
  license_type: string; license_text: string | null; license_url: string | null;
  author: string | null; attribution: string;
  source_width: number | null; source_height: number | null;
  focal_x: number; focal_y: number; crop_hint: string; preferred_aspect: string;
  confidence: "high" | "medium" | "low"; verified_at: string; kind: string; method: string;
  commercial_display_status: "approved" | "review_required" | "blocked";
  derivatives: { avatar?: string; card?: string; profile?: string };
};

export type MediaSearch = { searched_at: string; wikidata: string | null; found: boolean; rejected: Array<{ file: string; reason: string }> };

export type RefereePacket = {
  subject_type: "referee"; slug: string; name: string;
  identity: { checked_at: string; wikipedia: string | null; wikidata: string | null; resolved: boolean; note: string | null };
  facts: Record<string, Claim<unknown> | null>;
  bio: { text: string | null; source_url: string | null; source_name: string | null; license: string | null; verified_at: string | null };
  metrics: null | {
    sample_bouts: number; main_event_assignments: number;
    method_distribution: Record<string, number>; round_distribution: Record<string, number>;
    avg_fight_seconds: number | null; timed_sample: number;
    stoppage_time_seconds: null | { p25: number; median: number; p75: number; sample: number };
    notable: Array<{ fight: string; event: string; date: string | null; method: string; round: number | null }>;
    origin: string; computed_at: string; note: string;
  };
  media: MediaBlock | null; media_search: MediaSearch | null; sources: string[];
};

export type HofPacket = {
  subject_type: "hof_inductee"; slug: string; name: string; wing: string;
  identity: { checked_at: string; wikipedia: string | null; wikidata: string | null; resolved: boolean; note: string | null };
  facts: Record<string, Claim<unknown> | null>;
  bio: { text: string | null; source_url: string | null; source_name: string | null; license: string | null; verified_at: string | null };
  archive: null | { archive_status: "linked" | "missing"; fighter_id?: string; fighter_name?: string; espn_athlete_id?: string | null; ufcstats_id?: string | null; method?: string; matched_on?: string; record?: { w: number | null; l: number | null; d: number | null; nc: number | null }; note?: string };
  media: MediaBlock | null; media_search: MediaSearch | null; sources: string[];
};

const DB = data as unknown as { generated_at: string; referees: Record<string, RefereePacket>; hof: Record<string, HofPacket> };

export const enrichmentGeneratedAt = DB.generated_at;
export function refereePacket(slug: string): RefereePacket | null { return DB.referees[slug] || null; }
export function hofPacket(slug: string): HofPacket | null { return DB.hof[slug] || null; }
export function allRefereePackets(): RefereePacket[] { return Object.values(DB.referees); }
export function allHofPackets(): HofPacket[] { return Object.values(DB.hof); }

/* Read a claim's value, or null when the fact was never verified. */
export function val<T>(c: Claim<T> | null | undefined): T | null { return c && c.value != null ? c.value : null; }
export function claimSource(c: Claim<unknown> | null | undefined): string | null { return c?.source || null; }

/* Portrait for a subject at a slot. Only an approved or review-flagged image
 * with a real derivative is returned; anything else leaves the monogram. */
export function portrait(p: { media: MediaBlock | null } | null, slot: "avatar" | "card" | "profile" = "card"): { src: string; alt: string; attribution: string; sourcePage: string; license: string; status: string } | null {
  const m = p?.media;
  if (!m || m.commercial_display_status === "blocked") return null;
  const src = m.derivatives?.[slot] || m.derivatives?.card || m.derivatives?.profile || m.derivatives?.avatar;
  if (!src) return null;
  return { src, alt: m.subject_name, attribution: m.attribution, sourcePage: m.source_page_url, license: m.license_type, status: m.commercial_display_status };
}

export type FightWingEntry = {
  slug: string; title: string; wing: "fight";
  fighters: Array<{ name: string | null; fighter_id: string | null; archive_status: string; espn_athlete_id: string | null }>;
  meeting: number | null;
  event: { name: string; year: string; event_id: string | null; event_date: string | null };
  result: null | { winner: string | null; method: string; method_raw: string; round: number | null; time_sec: number | null; is_title: boolean; scheduled_rounds: number | null; source: string; verified_at: string };
  result_note: string | null;
  significance: { value: string; source: string; method: string; verified_at: string };
  induction: { wing: string; source: string; note: string };
  sources: string[];
};

/* Fight Wing lives in its own generated file; it is a bout-shaped record, not
 * a person, so it deliberately does not reuse the inductee packet shape. */
export function fightWing(): FightWingEntry[] {
  const fw = (data as unknown as { fights?: { fights?: FightWingEntry[] } }).fights;
  return fw?.fights || [];
}
