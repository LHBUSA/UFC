"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "pbe:ufc:fight-week-backdrop";

const BACKDROPS = [
  { id: "walkout", label: "Walkout", src: "/media/fight-week-walkout.svg" },
  { id: "cage", label: "Cage", src: "/media/fight-week-cage-front.svg" },
  { id: "arena", label: "Arena", src: "/media/fight-week-arena-wide.svg" },
  { id: "lights", label: "Under lights", src: "/media/fight-week-under-lights.svg" },
] as const;

export function FightWeekBackdropSwitcher() {
  const pathname = usePathname();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [poster, setPoster] = useState<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<(typeof BACKDROPS)[number]["id"]>("walkout");

  const active = useMemo(
    () => BACKDROPS.find((item) => item.id === activeId) ?? BACKDROPS[0],
    [activeId],
  );

  useEffect(() => {
    if (pathname !== "/") {
      setHost(null);
      setPoster(null);
      return;
    }

    const posterEl = document.querySelector<HTMLElement>(".hero .poster");
    const hostEl = posterEl?.parentElement ?? null;
    if (!posterEl || !hostEl) return;

    hostEl.classList.add("fw-poster-host");
    setHost(hostEl);
    setPoster(posterEl);

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && BACKDROPS.some((item) => item.id === stored)) {
        setActiveId(stored as (typeof BACKDROPS)[number]["id"]);
      }
    } catch {
      // Storage is a convenience only. The default backdrop still works.
    }

    // Warm the alternates after the main poster has mounted so switching is
    // instant without making them render-blocking assets.
    for (const item of BACKDROPS.slice(1)) {
      const img = new Image();
      img.decoding = "async";
      img.src = item.src;
    }

    return () => {
      hostEl.classList.remove("fw-poster-host");
      posterEl.style.removeProperty("--fw-poster-bg");
      delete posterEl.dataset.backdrop;
    };
  }, [pathname]);

  useEffect(() => {
    if (!poster) return;
    poster.style.setProperty("--fw-poster-bg", `url("${active.src}")`);
    poster.dataset.backdrop = active.id;
  }, [active, poster]);

  const choose = (id: (typeof BACKDROPS)[number]["id"]) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private browsing/storage restrictions should never block the control.
    }
  };

  if (!host) return null;

  return createPortal(
    <div className="fw-bg-picker" role="group" aria-label="Choose Fight Week backdrop">
      <span className="fw-bg-picker-label">Backdrop</span>
      <div className="fw-bg-options">
        {BACKDROPS.map((item) => {
          const selected = item.id === active.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`fw-bg-option${selected ? " active" : ""}`}
              aria-label={`Use ${item.label} backdrop`}
              aria-pressed={selected}
              title={item.label}
              onClick={() => choose(item.id)}
            >
              <span aria-hidden="true" style={{ backgroundImage: `url("${item.src}")` }} />
              <em>{item.label}</em>
            </button>
          );
        })}
      </div>
    </div>,
    host,
  );
}
