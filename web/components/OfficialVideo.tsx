"use client";

import { useState } from "react";
import { VIDEO_TYPE_LABEL } from "@/lib/videoLabels";

export type OfficialVideoData = {
  provider_video_id: string;
  title: string;
  channel_name: string;
  url: string;
  thumbnail_url?: string | null;
  published_at?: string | null;
  video_type?: string | null;
  duration_sec?: number | null;
};

function fresh(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const h = Math.floor(ms / 3600e3);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function duration(sec?: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/* Poster-first, privacy-enhanced YouTube embed. The player is created only
 * on click (no autoplay, no third-party requests before consent); the frame
 * keeps a fixed 16:9 box so opening the player never shifts layout. */
export function OfficialVideo({ video, feature = false }: { video: OfficialVideoData; feature?: boolean }) {
  const [open, setOpen] = useState(false);
  const thumb = video.thumbnail_url || `https://i.ytimg.com/vi/${video.provider_video_id}/hqdefault.jpg`;
  const hq = feature ? `https://i.ytimg.com/vi/${video.provider_video_id}/maxresdefault.jpg` : thumb;
  const label = VIDEO_TYPE_LABEL[String(video.video_type || "other")] || "Official video";
  const when = fresh(video.published_at);
  const dur = duration(video.duration_sec);
  return (
    <article className={`official-video${feature ? " feature" : ""}`}>
      <div className="official-video-frame">
        {open ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.provider_video_id)}?rel=0&modestbranding=1&autoplay=1`}
            title={video.title}
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; autoplay"
            allowFullScreen
          />
        ) : (
          <button type="button" className="official-video-poster" onClick={() => setOpen(true)} aria-label={`Play ${video.title}`}>
            <img src={hq} alt="" width={1280} height={720} loading={feature ? "eager" : "lazy"} decoding="async" onError={(e) => { const el = e.currentTarget; if (el.src !== thumb) el.src = thumb; }} />
            <span className="official-video-play" aria-hidden="true"><i /></span>
            <span className="official-video-label">{label}</span>
            <span className="official-video-source">YouTube · {video.channel_name}</span>
            {dur && <span className="official-video-duration">{dur}</span>}
          </button>
        )}
      </div>
      <div className="official-video-copy">
        <span className="official-video-meta"><b>{label}</b>{when ? <> · <time dateTime={video.published_at || undefined}>{when}</time></> : null} · {video.channel_name}</span>
        <h3>{video.title}</h3>
        <a href={video.url} target="_blank" rel="noopener">Watch on YouTube ↗</a>
      </div>
    </article>
  );
}
