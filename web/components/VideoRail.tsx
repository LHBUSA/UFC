import type { OfficialVideoRow } from "@/lib/db";
import { OfficialVideo } from "@/components/OfficialVideo";
import { VIDEO_TYPE_LABEL } from "@/lib/videoLabels";

const toData = (v: OfficialVideoRow) => ({ provider_video_id: v.provider_video_id, title: v.title, channel_name: v.channel_name || "UFC", url: v.url, thumbnail_url: v.thumbnail_url, published_at: v.published_at, video_type: v.video_type, duration_sec: v.duration_sec });

/* Publisher-hosted official video, poster-first. Renders nothing when the
 * normalized video layer has no allowlisted rows for this surface — an empty
 * rail is never shown. Video bytes stay on YouTube; PropBetEdge stores only
 * identity links.
 *
 * `variant`:
 *   desk    homepage VIDEO DESK — one lead + a supporting grid
 *   timeline event page — grouped by fight-week stage
 *   rail    fighter / article / profile — tight row */
export function VideoRail({ videos, title = "Official video", eyebrow = "From the official channel", feature = true, note, variant = "rail", max = 4 }: {
  videos: OfficialVideoRow[]; title?: string; eyebrow?: string; feature?: boolean; note?: string; variant?: "desk" | "timeline" | "rail"; max?: number;
}) {
  if (!videos.length) return null;
  const attribution = note || "Embedded from the publisher's official YouTube channel · not hosted by PropBetEdge · no endorsement implied";
  if (variant === "timeline") {
    const groups = new Map<string, OfficialVideoRow[]>();
    for (const v of videos) { const k = VIDEO_TYPE_LABEL[v.video_type] || "Official video"; groups.set(k, [...(groups.get(k) || []), v]); }
    return (
      <section className="video-rail video-timeline" aria-label={title}>
        <div className="video-rail-head"><div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3></div><span className="video-rail-note">{attribution}</span></div>
        <div className="video-rail-grid has-feature">
          <OfficialVideo feature video={toData(videos[0])} />
          {videos.slice(1, 4).map((v) => <OfficialVideo key={v.id} video={toData(v)} />)}
        </div>
        {videos.length > 4 && (
          <div className="video-groups">
            {[...groups.entries()].map(([label, list]) => {
              const rest = list.filter((v) => !videos.slice(0, 4).some((x) => x.id === v.id));
              if (!rest.length) return null;
              return <div className="video-group" key={label}><h4>{label} <small>{rest.length}</small></h4><div className="video-group-grid">{rest.slice(0, 6).map((v) => <OfficialVideo key={v.id} video={toData(v)} />)}</div></div>;
            })}
          </div>
        )}
      </section>
    );
  }
  if (variant === "desk") {
    const [lead, ...rest] = videos;
    return (
      <section className="video-rail video-desk" aria-label={title}>
        <div className="video-rail-head"><div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3></div><span className="video-rail-note">{attribution}</span></div>
        <div className="video-desk-grid">
          <OfficialVideo feature video={toData(lead)} />
          <div className="video-desk-side">{rest.slice(0, 4).map((v) => <OfficialVideo key={v.id} video={toData(v)} />)}</div>
        </div>
      </section>
    );
  }
  const [lead, ...rest] = videos;
  return (
    <section className="video-rail" aria-label={title}>
      <div className="video-rail-head"><div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3></div><span className="video-rail-note">{attribution}</span></div>
      <div className={`video-rail-grid${feature ? " has-feature" : ""}`}>
        <OfficialVideo feature={feature} video={toData(lead)} />
        {rest.slice(0, Math.max(0, max - 1)).map((v) => <OfficialVideo key={v.id} video={toData(v)} />)}
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
    duration: v.duration_sec ? `PT${Math.floor(v.duration_sec / 60)}M${v.duration_sec % 60}S` : undefined,
    embedUrl: `https://www.youtube-nocookie.com/embed/${v.provider_video_id}`,
    url: v.url,
    publisher: { "@type": "Organization", name: v.channel_name || "UFC" },
  }));
}
