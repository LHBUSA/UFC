"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { OfficialVideo, type OfficialVideoData } from "@/components/OfficialVideo";
import { LANG_LABEL, type LangFilter, type VideoLang } from "@/lib/videoPolicy";

/* Client half of the video rail: the language filter (All · English ·
 * Spanish · Portuguese) and the layout variants. Rows arrive already ranked
 * by the server policy (English-first, embeddable, viewable, official,
 * fresh, relevant). The filter defaults to the server's suggestion (English
 * when enough English clips exist, otherwise All) and can be preset from
 * ?lang=en|es|pt|all — a content-language state, not site translation. */
export type RailVideo = OfficialVideoData & { id: string; lang: VideoLang; blocked: boolean; typeLabel: string };

const FILTERS: Array<[LangFilter, string]> = [["all", "All"], ["en", "English"], ["es", "Spanish"], ["pt", "Portuguese"]];

export function VideoRailClient({ videos, title, eyebrow, attribution, variant, feature, max, defaultLang }: { videos: RailVideo[]; title: string; eyebrow: string; attribution: string; variant: "desk" | "timeline" | "rail"; feature: boolean; max: number; defaultLang: LangFilter }) {
  const params = useSearchParams();
  const [lang, setLang] = useState<LangFilter>(defaultLang);
  useEffect(() => { const q = params?.get("lang"); if (q === "en" || q === "es" || q === "pt" || q === "all") setLang(q); }, [params]);

  const counts = useMemo(() => ({ all: videos.length, en: videos.filter((v) => v.lang === "en").length, es: videos.filter((v) => v.lang === "es").length, pt: videos.filter((v) => v.lang === "pt").length }), [videos]);
  const list = useMemo(() => (lang === "all" ? videos : videos.filter((v) => v.lang === lang)), [videos, lang]);
  const shown = list.length ? list : videos;
  const fellBack = !list.length && lang !== "all";

  const head = (
    <div className="video-rail-head">
      <div><div className="eyebrow">{eyebrow}</div><h3>{title}</h3></div>
      <div className="video-rail-tools">
        <div className="video-lang" role="group" aria-label="Content language">
          {FILTERS.map(([k, label]) => <button key={k} type="button" className={lang === k ? "on" : ""} aria-pressed={lang === k} onClick={() => setLang(k)}>{label}{k !== "all" && counts[k] > 0 && <small>{counts[k]}</small>}</button>)}
        </div>
        <span className="video-rail-note">{attribution}</span>
      </div>
    </div>
  );
  const fallbackNote = fellBack ? <p className="video-lang-note">No {LANG_LABEL[lang as VideoLang]} clips are attached here yet, so every language is shown. Each card carries its language label.</p> : null;

  if (variant === "timeline") {
    const groups = new Map<string, RailVideo[]>();
    for (const v of shown) groups.set(v.typeLabel, [...(groups.get(v.typeLabel) || []), v]);
    const lead = shown.slice(0, 4);
    return (
      <section className="video-rail video-timeline" aria-label={title}>
        {head}{fallbackNote}
        <div className="video-rail-grid has-feature">
          {lead[0] && <OfficialVideo feature video={lead[0]} lang={lead[0].lang} blocked={lead[0].blocked} />}
          {lead.slice(1).map((v) => <OfficialVideo key={v.id} video={v} lang={v.lang} blocked={v.blocked} />)}
        </div>
        {shown.length > 4 && (
          <div className="video-groups">
            {[...groups.entries()].map(([label, items]) => {
              const rest = items.filter((v) => !lead.some((x) => x.id === v.id));
              if (!rest.length) return null;
              return <div className="video-group" key={label}><h4>{label} <small>{rest.length}</small></h4><div className="video-group-grid">{rest.slice(0, 6).map((v) => <OfficialVideo key={v.id} video={v} lang={v.lang} blocked={v.blocked} />)}</div></div>;
            })}
          </div>
        )}
      </section>
    );
  }
  if (variant === "desk") {
    const [lead, ...rest] = shown;
    return (
      <section className="video-rail video-desk" aria-label={title}>
        {head}{fallbackNote}
        <div className="video-desk-grid">
          {lead && <OfficialVideo feature video={lead} lang={lead.lang} blocked={lead.blocked} />}
          <div className="video-desk-side">{rest.slice(0, 4).map((v) => <OfficialVideo key={v.id} video={v} lang={v.lang} blocked={v.blocked} />)}</div>
        </div>
      </section>
    );
  }
  const [lead, ...rest] = shown;
  return (
    <section className="video-rail" aria-label={title}>
      {head}{fallbackNote}
      <div className={`video-rail-grid${feature ? " has-feature" : ""}`}>
        {lead && <OfficialVideo feature={feature} video={lead} lang={lead.lang} blocked={lead.blocked} />}
        {rest.slice(0, Math.max(0, max - 1)).map((v) => <OfficialVideo key={v.id} video={v} lang={v.lang} blocked={v.blocked} />)}
      </div>
    </section>
  );
}
