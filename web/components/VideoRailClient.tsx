"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { OfficialVideo, type OfficialVideoData } from "@/components/OfficialVideo";
import { LANG_LABEL, type LangFilter, type VideoLang } from "@/lib/videoPolicy";
import { curateFightWeekVideos, type CurationVideo } from "@/lib/videoCuration";

/* Client half of the video rail: the language filter (All · English ·
 * Spanish · Portuguese) and the layout variants. Rows arrive already ranked
 * by the server policy (English-first, embeddable, viewable, official,
 * fresh, relevant). The filter defaults to the server's suggestion (English
 * when enough English clips exist, otherwise All) and can be preset from
 * ?lang=en|es|pt|all — a content-language state, not site translation. */
export type RailVideo = OfficialVideoData & CurationVideo & { typeLabel: string };

const FILTERS: Array<[LangFilter, string]> = [["all", "All"], ["en", "English"], ["es", "Spanish"], ["pt", "Portuguese"]];

export function VideoRailClient({ videos, title, eyebrow, attribution, variant, feature, max, defaultLang, phase = "pre" }: { videos: RailVideo[]; title: string; eyebrow: string; attribution: string; variant: "desk" | "timeline" | "rail"; feature: boolean; max: number; defaultLang: LangFilter; phase?: "pre" | "post" }) {
  const params = useSearchParams();
  const [lang, setLang] = useState<LangFilter>(defaultLang);
  const [showAll, setShowAll] = useState(false);
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
    /* A curated fight-week desk, not the event's inventory: lib/videoCuration.ts
     * picks the best clip per stage under per-type, same-hour and total caps.
     * Everything else stays one click away, grouped by stage. */
    const desk = curateFightWeekVideos(videos, { lang, phase });
    const [lead, ...rest] = desk.curated;
    const groups = new Map<string, RailVideo[]>();
    for (const v of desk.remainder) groups.set(v.typeLabel, [...(groups.get(v.typeLabel) || []), v]);
    const folded = [...desk.variants.values()].reduce((n, x) => n + x.length, 0);
    const card = (v: RailVideo, isFeature = false) => <OfficialVideo key={v.id} feature={isFeature} video={v} lang={v.lang} blocked={v.blocked} />;
    return (
      <section className="video-rail video-timeline" aria-label={title}>
        {head}
        {desk.fellBack && lang !== "all" ? <p className="video-lang-note">No {LANG_LABEL[lang as VideoLang]} clips are attached here yet, so every language is shown. Each card carries its language label.</p> : null}
        <div className={`video-rail-grid has-feature video-curated${showAll ? " expanded" : ""}`}>
          {lead && card(lead, true)}
          {rest.map((v) => card(v))}
        </div>
        {folded > 0 && <p className="video-lang-note">{folded} localized version{folded === 1 ? "" : "s"} of these programmes {folded === 1 ? "is" : "are"} folded into one card each. Pick a language to watch that version.</p>}
        {desk.remainder.length > 0 && (
          <div className="video-more">
            <button type="button" className="video-more-btn" aria-expanded={showAll} aria-controls="video-all" onClick={() => setShowAll((x) => !x)}>
              {showAll ? "Hide the full list" : `See all official videos`} <small>{desk.remainder.length} more{desk.lang !== "all" ? ` in ${LANG_LABEL[desk.lang as VideoLang]}` : ""}</small>
            </button>
            {showAll && (
              <div className="video-groups" id="video-all">
                {[...groups.entries()].map(([label, items]) => (
                  <div className="video-group" key={label}><h4>{label} <small>{items.length}</small></h4><div className="video-group-grid">{items.map((v) => card(v))}</div></div>
                ))}
              </div>
            )}
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
