import { Suspense } from "react";
import type { OfficialVideoRow } from "@/lib/db";
import { VIDEO_TYPE_LABEL } from "@/lib/videoLabels";
import { VideoRailClient, type RailVideo } from "@/components/VideoRailClient";
import { defaultLanguage, rankVideos, regionBlocked, videoLanguage, type LangFilter } from "@/lib/videoPolicy";

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
 *   timeline event page — grouped by fight-week stage
 *   rail    fighter / article / profile — tight row */
export function VideoRail({ videos, title = "Official video", eyebrow = "From the official channel", feature = true, note, variant = "rail", max = 4, prefer }: {
  videos: OfficialVideoRow[]; title?: string; eyebrow?: string; feature?: boolean; note?: string; variant?: "desk" | "timeline" | "rail"; max?: number; prefer?: LangFilter;
}) {
  if (!videos.length) return null;
  const attribution = note || "Embedded from the publisher's official YouTube channel · not hosted by PropBetEdge · no endorsement implied";
  const defaultLang = prefer || defaultLanguage(videos);
  /* Timeline keeps its stage order inside the language the reader chose; the other variants take the policy order. */
  const ordered = variant === "timeline" ? videos : rankVideos(videos, defaultLang);
  const rows: RailVideo[] = ordered.map((v) => ({
    id: v.id, provider_video_id: v.provider_video_id, title: v.title, channel_name: v.channel_name || "UFC", url: v.url, thumbnail_url: v.thumbnail_url, published_at: v.published_at, video_type: v.video_type, duration_sec: v.duration_sec,
    lang: videoLanguage(v), blocked: regionBlocked(v), typeLabel: VIDEO_TYPE_LABEL[v.video_type] || "Official video",
  }));
  return (
    <Suspense fallback={null}>
      <VideoRailClient videos={rows} title={title} eyebrow={eyebrow} attribution={attribution} variant={variant} feature={feature} max={max} defaultLang={defaultLang} />
    </Suspense>
  );
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
    inLanguage: videoLanguage(v) === "unknown" ? undefined : videoLanguage(v),
    publisher: { "@type": "Organization", name: v.channel_name || "UFC" },
  }));
}
