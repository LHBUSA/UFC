"use client";

import { useEffect, useRef, useState } from "react";
import { VIDEO_TYPE_LABEL } from "@/lib/videoLabels";
import { LANG_LABEL, type VideoLang } from "@/lib/videoPolicy";

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

/* YouTube player error codes that mean the embed cannot play here:
 * 100 removed/private, 101/150 embedding not allowed for this video or
 * region. They arrive through the IFrame API message channel once we send
 * the "listening" handshake to the player. */
const BLOCKED_CODES = new Set([100, 101, 150]);

/* Poster-first, privacy-enhanced YouTube embed. The player is created only
 * on click (no autoplay, no third-party requests before consent); the frame
 * keeps a fixed 16:9 box so opening the player never shifts layout. If the
 * embed is refused (region restriction, embedding disabled, removed), the
 * card falls back to the poster with a clear message and a Watch on YouTube
 * CTA instead of a dead black box. */
export function OfficialVideo({ video, feature = false, lang = "unknown", blocked = false }: { video: OfficialVideoData; feature?: boolean; lang?: VideoLang; blocked?: boolean }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<null | "blocked" | "unavailable">(blocked ? "blocked" : null);
  const frame = useRef<HTMLIFrameElement>(null);
  const thumb = video.thumbnail_url || `https://i.ytimg.com/vi/${video.provider_video_id}/hqdefault.jpg`;
  const hq = feature ? `https://i.ytimg.com/vi/${video.provider_video_id}/maxresdefault.jpg` : thumb;
  const label = VIDEO_TYPE_LABEL[String(video.video_type || "other")] || "Official video";
  const when = fresh(video.published_at);
  const dur = duration(video.duration_sec);

  useEffect(() => {
    if (!open) return;
    const onMessage = (e: MessageEvent) => {
      if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
      let data: { event?: string; info?: unknown } | null = null;
      try { data = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!data || data.event !== "onError") return;
      const code = Number(data.info);
      setFailed(BLOCKED_CODES.has(code) ? "blocked" : "unavailable");
      setOpen(false);
    };
    window.addEventListener("message", onMessage);
    /* Handshake so the player starts posting events (IFrame API protocol). */
    const t = window.setInterval(() => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: video.provider_video_id, channel: "widget" }), "*"), 500);
    const stop = window.setTimeout(() => window.clearInterval(t), 6000);
    return () => { window.removeEventListener("message", onMessage); window.clearInterval(t); window.clearTimeout(stop); };
  }, [open, video.provider_video_id]);

  return (
    <article className={`official-video${feature ? " feature" : ""}${failed ? " failed" : ""}`}>
      <div className="official-video-frame">
        {open && !failed ? (
          <iframe
            ref={frame}
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.provider_video_id)}?rel=0&modestbranding=1&autoplay=1&enablejsapi=1&origin=${typeof window !== "undefined" ? encodeURIComponent(window.location.origin) : ""}`}
            title={video.title}
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; autoplay"
            allowFullScreen
          />
        ) : failed ? (
          <div className="official-video-fallback" role="status">
            <img src={thumb} alt="" width={1280} height={720} loading="lazy" decoding="async" />
            <div className="official-video-fallback-copy">
              <b>{failed === "blocked" ? "Not available for embedded playback in your region." : "This video is not available for embedded playback."}</b>
              <a href={video.url} target="_blank" rel="noopener" className="btn gold">Watch on YouTube ↗</a>
            </div>
            <span className="official-video-label">{label}</span>
            <span className="official-video-lang" title={LANG_LABEL[lang]}>{LANG_LABEL[lang] === "Language unlisted" ? "—" : LANG_LABEL[lang].toUpperCase()}</span>
          </div>
        ) : (
          <button type="button" className="official-video-poster" onClick={() => setOpen(true)} aria-label={`Play ${video.title}`}>
            <img src={hq} alt="" width={1280} height={720} loading={feature ? "eager" : "lazy"} decoding="async" onError={(e) => { const el = e.currentTarget; if (el.src !== thumb) el.src = thumb; }} />
            <span className="official-video-play" aria-hidden="true"><i /></span>
            <span className="official-video-label">{label}</span>
            <span className="official-video-lang" title={LANG_LABEL[lang]}>{lang === "unknown" ? "—" : LANG_LABEL[lang].toUpperCase()}</span>
            <span className="official-video-source">YouTube · {video.channel_name}</span>
            {dur && <span className="official-video-duration">{dur}</span>}
          </button>
        )}
      </div>
      <div className="official-video-copy">
        <span className="official-video-meta"><b>{label}</b>{when ? <> · <time dateTime={video.published_at || undefined}>{when}</time></> : null} · {video.channel_name} · <span className={`official-video-langtag ${lang}`}>{LANG_LABEL[lang]}</span></span>
        <h3>{video.title}</h3>
        <a href={video.url} target="_blank" rel="noopener">Watch on YouTube ↗</a>
      </div>
    </article>
  );
}
