/* Official video selection policy — V1 content-language strategy.
 *
 * Every surfaced video is ranked by, in order: language (English-first for
 * the default experience), embeddable, viewable (not region-blocked where we
 * can detect it), official tier, freshness, relevance. Freshness never
 * outranks usability: a 15-hour-old clip that cannot play in-region loses to
 * an older official English clip that can.
 *
 * Language comes from ingest metadata when the pipeline recorded it
 * (source_metadata.language), otherwise from the channel (UFC Brasil → pt,
 * UFC Espanol → es, UFC / ESPN MMA → en) with a light title check for the
 * English channels that occasionally post Spanish/Portuguese-titled clips.
 * Nothing here translates the site; it filters and labels content language.
 * The same state can be driven from the URL (?lang=en|es|pt|all) so language
 * -aware surfacing can grow later without a locale-routed page tree. */
import type { OfficialVideoRow } from "@/lib/db";

export type VideoLang = "en" | "es" | "pt" | "unknown";
export type LangFilter = "all" | "en" | "es" | "pt";

export const LANG_LABEL: Record<VideoLang, string> = { en: "English", es: "Spanish", pt: "Portuguese", unknown: "Language unlisted" };
export const LANG_SHORT: Record<VideoLang, string> = { en: "EN", es: "ES", pt: "PT", unknown: "—" };

/* Channel → default language and tier (docs/videos.md §channels). */
const CHANNEL_LANG: Array<[RegExp, VideoLang]> = [[/brasil|\bbr\b|portugu/i, "pt"], [/espa[nñ]ol|latino|\bes\b/i, "es"], [/^ufc$|ufc fight pass|espn|ufc europe|ufc uk|ufc australia|ufc asia|ufc japan|ufc eurasia|ufc quebec/i, "en"]];
const CHANNEL_TIER: Array<[RegExp, number]> = [[/^ufc$/i, 1], [/espn mma/i, 1], [/ufc fight pass/i, 2], [/^ufc (europe|uk|australia|asia|japan|eurasia|quebec)/i, 2], [/brasil|espa[nñ]ol|latino/i, 3]];

const ES_HINT = /\b(el|la|los|las|del|con|contra|pelea|peleador|entrevista|conferencia|resumen|noche|hoy|semana|previa|mejores|momentos|así|más|será|todo|nuevo)\b|ñ/i;
const PT_HINT = /\b(luta|lutador|lutadora|entrevista|coletiva|melhores|momentos|noite|semana|prévia|contra|não|você|também|história|campeão|pesagem)\b|ção|ções/i;

export function videoLanguage(v: Pick<OfficialVideoRow, "channel_name" | "title" | "description" | "source_metadata">): VideoLang {
  const meta = (v.source_metadata || {}) as { language?: string };
  if (meta.language === "en" || meta.language === "es" || meta.language === "pt") return meta.language;
  const ch = v.channel_name || "";
  const channelLang = CHANNEL_LANG.find(([re]) => re.test(ch))?.[1] || "unknown";
  if (channelLang === "es" || channelLang === "pt") return channelLang;
  /* English channels: trust the channel unless the title itself is clearly Spanish/Portuguese. */
  const title = v.title || "";
  const es = (title.match(ES_HINT) || []).length, pt = (title.match(PT_HINT) || []).length;
  if (channelLang === "en") return pt >= 2 && /ção|não|você/i.test(title) ? "pt" : es >= 2 && /ñ|¿|¡/i.test(title) ? "es" : "en";
  return "unknown";
}

export function channelTier(v: Pick<OfficialVideoRow, "channel_name">): number {
  return CHANNEL_TIER.find(([re]) => re.test(v.channel_name || ""))?.[1] || 3;
}

/* Region restriction only when the ingest recorded it (YouTube Data API
 * contentDetails.regionRestriction). Unknown means "assume viewable"; the
 * client player still falls back gracefully if YouTube refuses the embed. */
export function isViewable(v: Pick<OfficialVideoRow, "source_metadata" | "embeddable">, region = "US"): boolean {
  if (v.embeddable === false) return false;
  const meta = (v.source_metadata || {}) as { region_restriction?: { allowed?: string[]; blocked?: string[] } | null };
  const rr = meta.region_restriction;
  if (!rr) return true;
  if (Array.isArray(rr.blocked) && rr.blocked.includes(region)) return false;
  if (Array.isArray(rr.allowed) && rr.allowed.length && !rr.allowed.includes(region)) return false;
  return true;
}

export function regionBlocked(v: Pick<OfficialVideoRow, "source_metadata">, region = "US"): boolean {
  const meta = (v.source_metadata || {}) as { region_restriction?: { allowed?: string[]; blocked?: string[] } | null };
  const rr = meta.region_restriction;
  if (!rr) return false;
  return (Array.isArray(rr.blocked) && rr.blocked.includes(region)) || (Array.isArray(rr.allowed) && rr.allowed.length > 0 && !rr.allowed.includes(region));
}

const RELEVANCE = ["embedded_episode", "countdown", "press_conference", "weigh_in", "faceoff", "media_day", "fight_preview", "interview", "highlights", "analysis", "post_fight", "full_fight", "other"];

/* Deterministic score; higher is better. */
export function videoScore(v: OfficialVideoRow, prefer: LangFilter = "en", now = Date.now()): number {
  const lang = videoLanguage(v);
  let s = 0;
  if (prefer !== "all") s += lang === prefer ? 1000 : lang === "unknown" ? 400 : 0;
  else s += lang === "en" ? 300 : 200;
  s += v.embeddable === false ? -5000 : v.embeddable === true ? 300 : 150;
  s += isViewable(v) ? 200 : -4000;
  s += (4 - channelTier(v)) * 60;
  const ageH = v.published_at ? Math.max(0, (now - Date.parse(v.published_at)) / 3600e3) : 24 * 30;
  s += Math.max(0, 80 - Math.log2(1 + ageH) * 8);
  const rel = RELEVANCE.indexOf(v.video_type);
  s += rel < 0 ? 0 : (RELEVANCE.length - rel) * 3;
  return s;
}

export function rankVideos(videos: OfficialVideoRow[], prefer: LangFilter = "en"): OfficialVideoRow[] {
  const now = Date.now();
  return [...videos].sort((a, b) => videoScore(b, prefer, now) - videoScore(a, prefer, now));
}

export function filterByLanguage<T extends Pick<OfficialVideoRow, "channel_name" | "title" | "description" | "source_metadata">>(videos: T[], lang: LangFilter): T[] {
  if (lang === "all") return videos;
  return videos.filter((v) => videoLanguage(v) === lang);
}

/* Default filter for a surface: English when at least `min` English clips exist, otherwise All (still labelled). */
export function defaultLanguage(videos: Array<Pick<OfficialVideoRow, "channel_name" | "title" | "description" | "source_metadata">>, min = 2): LangFilter {
  return filterByLanguage(videos, "en").length >= min ? "en" : "all";
}

export function parseLang(v: string | null | undefined): LangFilter | null {
  return v === "en" || v === "es" || v === "pt" || v === "all" ? v : null;
}
