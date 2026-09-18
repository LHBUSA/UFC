import { Suspense } from "react";
import type { OfficialVideoRow } from "@/lib/db";
import { VIDEO_TYPE_LABEL } from "@/lib/videoLabels";
import { VideoRailClient, type RailVideo } from "@/components/VideoRailClient";
import { channelTier, defaultLanguage, rankVideos, regionBlocked, regionVerified, videoLanguage, type LangFilter } from "@/lib/videoPolicy";
import { curateFightWeekVideos } from "@/lib/videoCuration";

/* Publisher-hosted official video, poster-first. Renders nothing when the
 * normalized video layer has no allowlisted rows for this surface — an empty
 * rail is never shown. Video bytes stay on YouTube; PropBetEdge stores only
 * identity links.
 *
 * Selection policy (lib/videoPolicy.ts): English-first by default, then
 * embeddable, viewable, official tier, freshness, relevance. Every card shows
 * its content language; a language filter sits in the rail head.
 *
 * `variant`:
 *   desk    homepage VIDEO DESK — one lead + a supporting grid
 *   timeline event page — a CURATED fight-week desk (lib/videoCuration.ts): the
 *           best clip per stage under per-type, same-hour and total caps, with
 *           the rest of the event's inventory behind "See all official videos"
 *   rail    fighter / article / profile — tight row */
export function toRailVideo(v: OfficialVideoRow): RailVideo {
  return {
    id: v.id, provider_video_id: v.provider_video_id, title: v.title, channel_name: v.channel_name || "UFC", url: v.url, thumbnail_url: v.thumbnail_url, published_at: v.published_at, video_type: v.video_type, duration_sec: v.duration_sec,
    lang: videoLanguage(v), blocked: regionBlocked(v), typeLabel: VIDEO_TYPE_LABEL[v.video_type] || "Official video",
    embeddable: v.embeddable ?? null, verified: v.embeddable === true && regionVerified(v), tier: channelTier(v), fighter_ids: v.fighter_ids || [], bout_id: v.bout_id || null,
  };
}

export function VideoRail({ videos, title = "Official video", eyebrow = "From the official channel", feature = true, note, variant = "rail", max = 4, prefer, phase = "pre" }: {
  videos: OfficialVideoRow[]; title?: string; eyebrow?: string; feature?: boolean; note?: string; variant?: "desk" | "timeline" | "rail"; max?: number; prefer?: LangFilter; phase?: "pre" | "post";
}) {
  if (!videos.length) return null;
  const attribution = note || "Embedded from the publisher's official YouTube channel · not hosted by PropBetEdge · no endorsement implied";
  const defaultLang = prefer || defaultLanguage(videos);
  /* The timeline is curated on the client per chosen language, so it takes the raw inventory; the other variants take the policy order. */
  const ordered = variant === "timeline" ? videos : rankVideos(videos, defaultLang);
  const rows = ordered.map(toRailVideo);
  return (
    <Suspense fallback={null}>
      <VideoRailClient videos={rows} title={title} eyebrow={eyebrow} attribution={attribution} variant={variant} feature={feature} max={max} defaultLang={defaultLang} phase={phase} />
    </Suspense>
  );
}

/** The event videos a timeline shows on first render, as rows. JSON-LD advertises these and nothing else. */
export function curatedEventVideos(videos: OfficialVideoRow[], phase: "pre" | "post" = "pre"): OfficialVideoRow[] {
  const byId = new Map(videos.map((v) => [v.id, v]));
  return curateFightWeekVideos(videos.map(toRailVideo), { lang: defaultLanguage(videos), phase }).curated.map((r) => byId.get(r.id)!);
}

export function videoJsonLd(videos: OfficialVideoRow[]) {
  return videos.slice(0, 4).map((v) => ({
    "@type": "VideoObject",
    name: v.title,
    description: v.description || v.title,
    thumbnailUrl: v.thumbnail_url || `https://i.ytimg.com/vi/${v.provider_video_id}/hqdefault.jpg`,
    uploadDate: v.published_at || undefined,
    duration: v.duration_sec ? `PT${Math.floor(v.duration_sec / 60)}M${v.duration_sec % 60}S` : undefined,
    embedUrl: `https://www.youtube-nocookie.com/embed/${v.provider_video_id}`,
    url: v.url,
    inLanguage: ["unknown", "other"].includes(videoLanguage(v)) ? undefined : videoLanguage(v),
    publisher: { "@type": "Organization", name: v.channel_name || "UFC" },
  }));
}
