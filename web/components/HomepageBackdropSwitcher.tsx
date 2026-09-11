"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "pbe:ufc:homepage-backdrop:v2";

const BACKDROPS = [
  { id: "fight-night", label: "Fight night", src: "/media/home-bg-fight-night.webp" },
  { id: "walkout", label: "Walkout", src: "/media/home-bg-walkout.webp" },
  { id: "lights", label: "Under lights", src: "/media/home-bg-under-lights.webp" },
  { id: "cage", label: "Cage", src: "/media/home-bg-cage.webp" },
] as const;

type BackdropId = (typeof BACKDROPS)[number]["id"];

export function HomepageBackdropSwitcher() {
  const pathname = usePathname();
  const [hero, setHero] = useState<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<BackdropId>("fight-night");

  const active = useMemo(
    () => BACKDROPS.find((item) => item.id === activeId) ?? BACKDROPS[0],
    [activeId],
  );

  useEffect(() => {
    if (pathname !== "/") {
      setHero(null);
      return;
    }

    const heroEl = document.querySelector<HTMLElement>(".hero");
    if (!heroEl) return;

    heroEl.classList.add("home-scene-enabled");
    setHero(heroEl);

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && BACKDROPS.some((item) => item.id === stored)) {
        setActiveId(stored as BackdropId);
      }
    } catch {
      // Storage is optional; the default image remains deterministic.
    }

    for (const item of BACKDROPS) {
      const img = new Image();
      img.decoding = "async";
      img.src = item.src;
    }

    return () => {
      heroEl.classList.remove("home-scene-enabled");
    };
  }, [pathname]);

  const choose = (id: BackdropId) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private browsing/storage restrictions should not break the control.
    }
  };

  if (!hero || pathname !== "/") return null;

  return createPortal(
    <>
      <div
        className="home-scene-stage"
        aria-hidden="true"
        style={{ backgroundImage: `url("${active.src}")` }}
      />
      <div className="home-scene-picker" role="group" aria-label="Choose homepage fight-night background">
        <span className="home-scene-label">Scene</span>
        <div className="home-scene-options">
          {BACKDROPS.map((item) => {
            const selected = item.id === active.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`home-scene-option${selected ? " active" : ""}`}
                aria-label={`Use ${item.label} homepage background`}
                aria-pressed={selected}
                title={item.label}
                onClick={() => choose(item.id)}
              >
                <span className="home-scene-thumb" aria-hidden="true" style={{ backgroundImage: `url("${item.src}")` }} />
                <span className="home-scene-name">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>,
    hero,
  );
}
