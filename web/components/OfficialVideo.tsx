"use client";

import { useState } from "react";

export type OfficialVideoData = {
  provider_video_id: string;
  title: string;
  channel_name: string;
  url: string;
  thumbnail_url?: string | null;
  published_at?: string | null;
  video_type?: string | null;
};

export function OfficialVideo({ video, feature = false }: { video: OfficialVideoData; feature?: boolean }) {
  const [open, setOpen] = useState(false);
  const thumb = video.thumbnail_url || `https://i.ytimg.com/vi/${video.provider_video_id}/hqdefault.jpg`;
  return (
    <article className={`official-video${feature ? " feature" : ""}`}>
      <div className="official-video-frame">
        {open ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.provider_video_id)}?rel=0`}
            title={video.title}
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        ) : (
          <button type="button" className="official-video-poster" onClick={() => setOpen(true)} aria-label={`Play ${video.title}`}>
            <img src={thumb} alt="" width={1280} height={720} loading="lazy" decoding="async" />
            <span className="official-video-play" aria-hidden="true"><i /></span>
            <span className="official-video-source">Official video · {video.channel_name}</span>
          </button>
        )}
      </div>
      <div className="official-video-copy">
        <span>{String(video.video_type || "official video").replaceAll("_", " ")}</span>
        <h3>{video.title}</h3>
        <a href={video.url} target="_blank" rel="noopener">Watch on YouTube →</a>
      </div>
    </article>
  );
}
