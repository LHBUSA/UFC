import type { OfficialVideoRow } from "@/lib/db";
import { OfficialVideo } from "@/components/OfficialVideo";

/* Publisher-hosted official video, poster-first. Renders nothing when the
 * normalized video layer has no allowlisted rows for this surface — an empty
 * rail is never shown. Video bytes stay on YouTube; PropBetEdge stores only
 * identity links. */
export function VideoRail({ videos, title = "Official video", eyebrow = "From the official channel", feature = true, note }: {
  videos: OfficialVideoRow[]; title?: string; eyebrow?: string; feature?: boolean; note?: string;
}) {
  if (!videos.length) return null;
  const [lead, ...rest] = videos;
  return (
    <section className="video-rail" aria-label={title}>
      <div className="video-rail-head">
        <div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3></div>
        <span className="video-rail-note">{note || "Embedded from the publisher's official YouTube channel · not hosted by PropBetEdge"}</span>
      </div>
      <div className={`video-rail-grid${feature ? " has-feature" : ""}`}>
        <OfficialVideo feature={feature} video={{ provider_video_id: lead.provider_video_id, title: lead.title, channel_name: lead.channel_name || "UFC", url: lead.url, thumbnail_url: lead.thumbnail_url, published_at: lead.published_at, video_type: lead.video_type }} />
        {rest.slice(0, 3).map((v) => <OfficialVideo key={v.id} video={{ provider_video_id: v.provider_video_id, title: v.title, channel_name: v.channel_name || "UFC", url: v.url, thumbnail_url: v.thumbnail_url, published_at: v.published_at, video_type: v.video_type }} />)}
      </div>
    </section>
  );
}

export function videoJsonLd(videos: OfficialVideoRow[]) {
  return videos.slice(0, 4).map((v) => ({
    "@type": "VideoObject",
    name: v.title,
    description: v.description || v.title,
    thumbnailUrl: v.thumbnail_url || `https://i.ytimg.com/vi/${v.provider_video_id}/hqdefault.jpg`,
    uploadDate: v.published_at || undefined,
    embedUrl: `https://www.youtube-nocookie.com/embed/${v.provider_video_id}`,
    url: v.url,
    publisher: { "@type": "Organization", name: v.channel_name || "UFC" },
  }));
}
