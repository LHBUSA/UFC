"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Wire, WireItem } from "@/lib/wire";

const LIVE_MIN = 120;
const BREAKING_MIN = 30;
const URGENT = new Set(["card_change", "withdrawal", "replacement", "injury", "weight_miss", "bout_moved", "result", "suspension"]);
const POLL_MS = 45000;

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function freshness(items: WireItem[], now: number) {
  const newest = items.map((i) => i.published_at).filter(Boolean).sort().reverse()[0] || null;
  const minutes = newest ? Math.max(0, Math.round((now - new Date(newest).getTime()) / 60000)) : null;
  const urgent = items.some((i) => i.published_at && (now - new Date(i.published_at).getTime()) / 60000 <= BREAKING_MIN && i.taxonomy && URGENT.has(i.taxonomy));
  return { minutes, live: minutes != null && minutes <= LIVE_MIN, urgent };
}

export function LiveWireRail({ initial, api }: { initial: Wire; api: string }) {
  const [items, setItems] = useState<WireItem[]>(initial.items);
  const [now, setNow] = useState<number>(() => new Date(initial.meta.generated_at).getTime() || Date.now());
  const [paused, setPaused] = useState(false);
  const failures = useRef(0);
  /* Fight Week / Pregame own their local navigator; the wire stays in flow
   * there so the page never carries three stacked sticky bars. */
  const pathname = usePathname() || "/";
  const quiet = /^\/(fight-week|pregame)(\/|$)/.test(pathname);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(api, { headers: { accept: "application/json" }, cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { ok: boolean; data?: WireItem[] };
        if (j?.ok && Array.isArray(j.data) && j.data.length) { setItems(j.data); failures.current = 0; }
      } catch {
        failures.current += 1; /* keep current items; never blank the rail */
      }
      setNow(Date.now());
    };
    const start = () => { if (!timer) timer = setInterval(tick, POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.hidden) stop(); else { tick(); start(); } };
    start();
    document.addEventListener("visibilitychange", onVis);
    const clock = setInterval(() => setNow(Date.now()), 60000);
    return () => { stop(); clearInterval(clock); document.removeEventListener("visibilitychange", onVis); };
  }, [api]);

  const f = useMemo(() => freshness(items, now), [items, now]);
  const label = f.live ? "UFC Live Wire" : "Latest UFC";
  const duration = Math.max(60, items.length * 9);

  /* Marquee duplication is intentional (CASE A): the belt renders the same
   * 20 items twice so the loop is seamless. Row "a" is the single semantic
   * copy; row "b" is a visual clone with aria-hidden and tabIndex -1, so
   * assistive tech and the tab order see each story once. Items are fetched
   * once (server render + one client poll), never twice per render, and no
   * element ids are used inside the belt, so no duplicate ids exist. */
  const row = (keyPrefix: string, ariaHidden = false) => (
    <ul className="wire-track" aria-hidden={ariaHidden || undefined} style={{ animationDuration: `${duration}s` }}>
      {items.map((it) => {
        const urgent = it.taxonomy && URGENT.has(it.taxonomy);
        /* Our own coverage is marked, not disguised as another wire item: a
         * reader deciding whether to click deserves to know whose analysis is
         * on the other side of the link. */
        const own = Boolean(it.internal_url);
        const inner = (
          <>
            <span className={`wire-tag${urgent ? " hot" : ""}${own ? " own" : ""}`}>{own ? "PropBetEdge" : (it.taxonomy || it.source?.name || "wire").replace(/_/g, " ")}</span>
            <span className="wire-title">{it.title}</span>
            <span className="wire-meta">{it.source?.name ? `${it.source.name} · ` : ""}{ago(it.published_at, now)}</span>
          </>
        );
        return (
          <li key={`${keyPrefix}-${it.id}`} className={own ? "wire-own" : undefined}>
            {it.internal_url ? <Link href={it.internal_url} tabIndex={ariaHidden ? -1 : 0}>{inner}</Link>
              : it.source_url ? <a href={it.source_url} rel="noopener nofollow" target="_blank" tabIndex={ariaHidden ? -1 : 0}>{inner}</a>
              : <span>{inner}</span>}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className={`wire-rail${paused ? " paused" : ""}${f.live ? " live" : ""}${quiet ? " static" : ""}`} role="region" aria-label={label}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="wire-badge">
        <i className={`wire-dot${f.live ? (f.urgent ? " hot" : " on") : ""}`} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="wire-view">
        <div className="wire-belt">
          {row("a")}
          {row("b", true)}
        </div>
      </div>
      <Link href="/news" className="wire-more">Newsroom →</Link>
    </div>
  );
}
