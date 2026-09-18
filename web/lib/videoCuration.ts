/* Fight Week video curation: the consumer selection over an event's video inventory.
 *
 * The inventory is not the experience. One card collects 100+ linked uploads in
 * a week (142 for UFC 331): localized Korean clips on the main channel, a dozen
 * Shorts inside one hour of a press conference, the same Embedded episode in
 * three languages. Rendering "the rows attached to the event" turns the page
 * into a video wall. This module picks the handful a reader came for and leaves
 * every other row reachable behind an explicit "See all official videos".
 *
 * Pure and deterministic: same rows in, same cards out, in the same order. No
 * clock, no randomness. Nothing is deleted or rewritten; this only chooses.
 *
 * ORDER OF OPERATIONS (each step only ever narrows):
 *   1. eligibility   blocked-in-region and unembeddable rows never reach the
 *                    curated set. Playability outranks everything after it.
 *   2. language      the reader's language; All when that language is absent.
 *   3. variants      (All only) one card per editorial item that exists in
 *                    several languages: English, then the reader's, then others.
 *   4. stages        best clip of each fight-week stage, in editorial order,
 *                    then a second pass, under a per-type cap, a same-hour cap
 *                    and a total cap.
 */
import type { LangFilter, VideoLang } from "./videoPolicy.ts";

export type CurationVideo = {
  id: string;
  title: string;
  video_type: string;
  published_at: string | null;
  lang: VideoLang;
  /** Known region block for the policy region. */
  blocked: boolean;
  /** false = embedding disabled; null = never checked. */
  embeddable: boolean | null;
  /** The YouTube Data API answered the region question (playable, not merely unverified). */
  verified: boolean;
  /** 1 = UFC / ESPN MMA, 2 = Fight Pass + regional English, 3 = localized channels. */
  tier: number;
  fighter_ids: string[];
  bout_id: string | null;
};

/* Editorial order for a fight week, most wanted first. */
export const STAGE_ORDER = [
  "embedded_episode", "countdown", "press_conference", "media_day", "weigh_in", "faceoff",
  "fight_preview", "interview", "full_fight", "highlights", "post_fight", "analysis", "other",
] as const;
/* Once the card has happened the aftermath leads; the build-up stays, behind it. */
export const STAGE_ORDER_POST = [
  "post_fight", "highlights", "full_fight", "interview", "analysis",
  "embedded_episode", "countdown", "press_conference", "weigh_in", "faceoff", "media_day", "fight_preview", "other",
] as const;

export const CURATION_DEFAULTS = {
  /** Cards on first render. */
  max: 9,
  /** No stage may hold more than this many of them. */
  perType: 2,
  /** Unclassified uploads ("Official video") are the long tail, never the page. */
  other: 2,
  /** Uploads published inside one clock hour: a burst gets this many cards, total. */
  perHour: 3,
} as const;

export type CurationOptions = { lang?: LangFilter; phase?: "pre" | "post"; max?: number; perType?: number; other?: number; perHour?: number };

export type Curation<T extends CurationVideo> = {
  /** What the surface renders first, in display order. */
  curated: T[];
  /** Every other eligible row in the active language, newest stage first: the "See all" inventory. */
  remainder: T[];
  /** The language actually applied (the request falls back to All when it has no clips). */
  lang: LangFilter;
  fellBack: boolean;
  /** Localized variants folded under a curated/remainder card (All view only), by representative id. */
  variants: Map<string, T[]>;
  /** Rows withheld by policy: region-blocked or not embeddable. */
  suppressed: number;
};

export const isEligible = (v: Pick<CurationVideo, "blocked" | "embeddable">) => !v.blocked && v.embeddable !== false;

const ts = (s: string | null) => { const n = s ? Date.parse(s) : NaN; return Number.isFinite(n) ? n : 0; };
const hourBucket = (s: string | null) => (s ? s.slice(0, 13) : "unknown");

/** "Episode 4" / "Episódio 4" / "Episodio 4" / "Ep. 4". A strong identifier: it names the item. */
export function episodeNumber(title: string): number | null {
  const m = String(title || "").match(/\b(?:episode|epis[oó]dio|ep)\.?\s*#?\s*(\d{1,2})\b/i);
  return m ? Number(m[1]) : null;
}

/* Types that name a programme (one Countdown, one ceremonial weigh-in), so the
 * same item can exist in several languages. Interviews, highlights, analysis
 * and `other` are never treated as variants of each other: two interviews
 * uploaded in the same hour are two interviews. */
const VARIANT_TYPES = new Set(["embedded_episode", "countdown", "press_conference", "media_day", "weigh_in", "faceoff", "full_fight", "fight_preview", "post_fight"]);
const VARIANT_WINDOW_MS = 48 * 3600e3;

/**
 * The identity of an editorial item across languages, or null when the row is
 * not safely comparable. Conservative by construction: a false duplicate hides
 * a real clip, a missed one shows two legitimate cards.
 *   embedded episode  -> its episode number
 *   everything else   -> the exact set of linked fighters (or the linked bout);
 *                        rows with no linked fighter or bout are never merged.
 */
export function variantKey(v: CurationVideo): string | null {
  if (!VARIANT_TYPES.has(v.video_type)) return null;
  if (v.video_type === "embedded_episode") { const ep = episodeNumber(v.title); return ep == null ? null : `embedded|${ep}`; }
  if (v.bout_id) return `${v.video_type}|bout:${v.bout_id}`;
  const f = [...new Set(v.fighter_ids || [])].sort();
  return f.length ? `${v.video_type}|f:${f.join(",")}` : null;
}

/* Which language version represents an item: English, then the reader's, then the rest. */
function langRank(lang: VideoLang, prefer: LangFilter): number {
  if (lang === "en") return 0;
  if (prefer !== "all" && lang === prefer) return 1;
  return lang === "unknown" ? 3 : 2;
}

/* Quality inside one stage. Playability first (a verified-playable clip beats an
 * unverified one), then the official tier, then recency; for Embedded the
 * latest episode. The id closes every tie so the order never depends on input order. */
function byQuality<T extends CurationVideo>(prefer: LangFilter) {
  return (a: T, b: T) =>
    Number(b.verified) - Number(a.verified) ||
    langRank(a.lang, prefer) - langRank(b.lang, prefer) ||
    a.tier - b.tier ||
    (episodeNumber(b.title) ?? -1) - (episodeNumber(a.title) ?? -1) ||
    ts(b.published_at) - ts(a.published_at) ||
    a.id.localeCompare(b.id);
}

/** Fold localized variants. Only rows in DIFFERENT languages, same key, published within 48h of the representative. */
export function foldVariants<T extends CurationVideo>(videos: T[], prefer: LangFilter): { kept: T[]; variants: Map<string, T[]> } {
  const groups = new Map<string, T[]>();
  const kept: T[] = [];
  for (const v of videos) {
    const k = variantKey(v);
    if (!k) { kept.push(v); continue; }
    groups.set(k, [...(groups.get(k) || []), v]);
  }
  const variants = new Map<string, T[]>();
  for (const rows of groups.values()) {
    const ordered = [...rows].sort(byQuality<T>(prefer));
    const reps: T[] = [];
    for (const v of ordered) {
      const rep = reps.find((r) => r.lang !== v.lang && Math.abs(ts(r.published_at) - ts(v.published_at)) <= VARIANT_WINDOW_MS && !(variants.get(r.id) || []).some((x) => x.lang === v.lang));
      if (rep) variants.set(rep.id, [...(variants.get(rep.id) || []), v]);
      else reps.push(v);
    }
    kept.push(...reps);
  }
  return { kept, variants };
}

export function curateFightWeekVideos<T extends CurationVideo>(videos: readonly T[], options: CurationOptions = {}): Curation<T> {
  const o = { ...CURATION_DEFAULTS, lang: "en" as LangFilter, phase: "pre" as const, ...options };
  const order: readonly string[] = o.phase === "post" ? STAGE_ORDER_POST : STAGE_ORDER;

  const eligible = videos.filter(isEligible);
  const inLang = o.lang === "all" ? eligible : eligible.filter((v) => v.lang === o.lang);
  const fellBack = o.lang !== "all" && inLang.length === 0 && eligible.length > 0;
  const lang: LangFilter = fellBack ? "all" : o.lang;
  const pool = fellBack ? eligible : inLang;

  const { kept, variants } = lang === "all" ? foldVariants(pool, options.lang ?? "en") : { kept: [...pool], variants: new Map<string, T[]>() };

  const stageOf = (v: T) => (order.includes(v.video_type) ? v.video_type : "other");
  const queues = new Map<string, T[]>(order.map((s) => [s, [] as T[]]));
  for (const v of kept) queues.get(stageOf(v))!.push(v);
  for (const q of queues.values()) q.sort(byQuality<T>(lang));

  const curated: T[] = [];
  const perStage = new Map<string, number>();
  const perHour = new Map<string, number>();
  const capFor = (stage: string) => (stage === "other" ? o.other : o.perType);
  /* Two passes over the stages: breadth first (every stage that exists gets its
   * best clip before any stage gets a second), then depth up to the caps. */
  for (let pass = 1; pass <= Math.max(o.perType, o.other) && curated.length < o.max; pass += 1) {
    for (const stage of order) {
      if (curated.length >= o.max) break;
      if ((perStage.get(stage) || 0) >= Math.min(pass, capFor(stage))) continue;
      const q = queues.get(stage)!;
      const i = q.findIndex((v) => (perHour.get(hourBucket(v.published_at)) || 0) < o.perHour);
      if (i < 0) continue;
      const [pick] = q.splice(i, 1);
      curated.push(pick);
      perStage.set(stage, (perStage.get(stage) || 0) + 1);
      perHour.set(hourBucket(pick.published_at), (perHour.get(hourBucket(pick.published_at)) || 0) + 1);
    }
  }
  /* Display order is the editorial order, not the pass order. */
  curated.sort((a, b) => order.indexOf(stageOf(a)) - order.indexOf(stageOf(b)) || byQuality<T>(lang)(a, b));

  const remainder = order.flatMap((s) => queues.get(s)!);
  return { curated, remainder, lang, fellBack, variants, suppressed: videos.length - eligible.length };
}
