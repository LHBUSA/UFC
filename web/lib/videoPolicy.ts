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

/* AVAILABILITY POLICY (GitHub issue #19)
 *
 * The site is evaluated for a U.S. reader. Three sources of knowledge, and
 * only two of them are proof:
 *
 *   region_restriction      YouTube Data API contentDetails.regionRestriction.
 *                           PROOF, but only written when discovery used the
 *                           Data API (region_check.method = youtube_data_api).
 *   observed_region_block   a recorded observation that the player refused
 *                           this video in a region ({ regions: ["US"], ... }).
 *                           PROOF of a block; kept separate so a later API read
 *                           never silently erases it.
 *   oEmbed HTTP 200         proves an embed page EXISTS. It says nothing about
 *                           the viewer's country: UFC Brasil's XMK-nCzDxGo
 *                           answered 200 and does not play in the U.S.
 *
 * So a row is "playable" only when a region answer exists and allows the U.S.;
 * a row with no region answer is "unverified" -- it is still offered, poster
 * first, and the player falls back to Watch-on-YouTube if YouTube refuses it.
 * A known block or a disabled embed is suppressed: no player, no JSON-LD. */
export const POLICY_REGION = "US";

type RegionMeta = {
  discovery?: string | null;
  region_restriction?: { allowed?: string[] | null; blocked?: string[] | null } | null;
  observed_region_block?: { regions?: string[] | null } | null;
  region_check?: { method?: string | null } | null;
};
const regionMeta = (v: { source_metadata?: Record<string, unknown> | null }) => (v.source_metadata || {}) as RegionMeta;

export function regionBlocked(v: Pick<OfficialVideoRow, "source_metadata">, region = POLICY_REGION): boolean {
  const m = regionMeta(v);
  const rr = m.region_restriction;
  if (rr && ((Array.isArray(rr.blocked) && rr.blocked.includes(region)) || (Array.isArray(rr.allowed) && rr.allowed.length > 0 && !rr.allowed.includes(region)))) return true;
  const seen = m.observed_region_block?.regions;
  return Array.isArray(seen) && seen.includes(region);
}

/* Unknown region means "assume viewable" for ranking; the client player still
 * falls back gracefully if YouTube refuses the embed. */
export function isViewable(v: Pick<OfficialVideoRow, "source_metadata" | "embeddable">, region = POLICY_REGION): boolean {
  if (v.embeddable === false) return false;
  return !regionBlocked(v, region);
}

/** True only when the YouTube Data API answered the region question for this video. */
export function regionVerified(v: Pick<OfficialVideoRow, "source_metadata">): boolean {
  const m = regionMeta(v);
  return m.region_check?.method === "youtube_data_api" || m.discovery === "youtube_data_api_v3";
}

export type Playability = "playable" | "unverified" | "blocked" | "unembeddable";

export function videoPlayability(v: Pick<OfficialVideoRow, "source_metadata" | "embeddable">, region = POLICY_REGION): Playability {
  if (v.embeddable === false) return "unembeddable";
  if (regionBlocked(v, region)) return "blocked";
  return v.embeddable === true && regionVerified(v) ? "playable" : "unverified";
}

/** Suppressed by policy: never rendered as a player and never advertised in JSON-LD. */
export const renderableByPolicy = (p: Playability) => p === "playable" || p === "unverified";

/* ---- content-plan videos -------------------------------------------------
 *
 * ufc-news-enrich stores a COPY of the resolver's answer on the article
 * (fact_block.content_plan). Provenance -- tier, matched_on, publisher -- is a
 * property of the moment the story was written and stays with the copy.
 * Availability is not: a video can be found region-blocked, rejected or
 * de-embedded after the article is written. So the renderer overlays the live
 * ufc_videos state on the copy and the stricter answer wins. */
export type PlanVideo = {
  id: string; url: string; title: string; publisher?: string; video_id?: string; thumbnail_url?: string;
  embeddable?: boolean | null; video_type?: string; published_at?: string; language?: string | null;
  matched_on?: string; matched_tier?: number; duration_sec?: number | null;
  region_restriction?: RegionMeta["region_restriction"]; observed_region_block?: RegionMeta["observed_region_block"]; region_verified?: boolean;
};
export type LiveVideoState = { provider_video_id: string; embeddable: boolean | null; link_status?: string | null; channel_name?: string | null; source_metadata?: Record<string, unknown> | null };
export type RenderablePlanVideo = PlanVideo & { video_id: string; playability: Playability; lang: VideoLang };

export function planVideoPlayability(v: PlanVideo, live: LiveVideoState | undefined, region = POLICY_REGION): Playability | "rejected" {
  if (live?.link_status === "rejected") return "rejected";
  const embeddable = v.embeddable === false || live?.embeddable === false ? false : (live?.embeddable ?? v.embeddable ?? null);
  const lm = (live?.source_metadata || {}) as RegionMeta;
  const merged: RegionMeta = {
    discovery: lm.discovery ?? null,
    region_restriction: lm.region_restriction ?? v.region_restriction ?? null,
    observed_region_block: { regions: [...(lm.observed_region_block?.regions || []), ...(v.observed_region_block?.regions || [])] },
    region_check: lm.region_check ?? (v.region_verified ? { method: "youtube_data_api" } : null),
  };
  return videoPlayability({ embeddable, source_metadata: merged }, region);
}

/** The plan videos the page will actually render, in plan order. */
export function renderablePlanVideos(videos: PlanVideo[], live: Map<string, LiveVideoState> = new Map(), region = POLICY_REGION): RenderablePlanVideo[] {
  const out: RenderablePlanVideo[] = [];
  for (const v of videos || []) {
    if (!v || !v.video_id) continue;
    const p = planVideoPlayability(v, live.get(v.video_id), region);
    if (p === "rejected" || !renderableByPolicy(p)) continue;
    const lang = videoLanguage({ channel_name: v.publisher || live.get(v.video_id)?.channel_name || null, title: v.title, description: null, source_metadata: v.language ? { language: v.language } : null });
    out.push({ ...v, video_id: v.video_id, playability: p, lang });
  }
  return out;
}

/** What a legacy article's VideoRail (rail variant) shows on first render. */
export function railInitialSelection(videos: OfficialVideoRow[], max: number): OfficialVideoRow[] {
  if (!videos.length) return [];
  const lang = defaultLanguage(videos);
  const ordered = rankVideos(videos, lang);
  const list = filterByLanguage(ordered, lang);
  return (list.length ? list : ordered).slice(0, Math.max(1, max));
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
