"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "pbe:ufc:homepage-backdrop:v3";

const BACKDROPS = [
  { id: "fight-night", label: "Fight night", src: "/media/home-bg-fight-night.webp" },
  { id: "walkout", label: "Walkout", src: "/media/home-bg-walkout.webp" },
  { id: "lights", label: "Under lights", src: "/media/home-bg-under-lights.webp" },
  { id: "cage", label: "Cage", src: "/media/home-bg-cage.webp" },
] as const;

type BackdropId = (typeof BACKDROPS)[number]["id"];

export function HomepageBackdropSwitcher() {
  const pathname = usePathname();
  const [activeId, setActiveId] = useState<BackdropId>("fight-night");

  useEffect(() => {
    if (pathname !== "/") return;

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && BACKDROPS.some((item) => item.id === stored)) {
        setActiveId(stored as BackdropId);
      }
    } catch {
      // Storage is a convenience only; the default scene still renders.
    }

    // Warm all four real image assets after hydration so switching is instant.
    for (const item of BACKDROPS) {
      const img = new Image();
      img.decoding = "async";
      img.src = item.src;
    }
  }, [pathname]);

  if (pathname !== "/") return null;

  const active = BACKDROPS.find((item) => item.id === activeId) ?? BACKDROPS[0];

  const choose = (id: BackdropId) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Storage restrictions must never block the control itself.
    }
  };

  return (
    <>
      <div
        className="home-scene-stage"
        aria-hidden="true"
        style={{ backgroundImage: `url("${active.src}")` }}
      />

      <div className="home-scene-picker" role="group" aria-label="Choose homepage background">
        <span className="home-scene-label">Background</span>
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
                <span
                  className="home-scene-thumb"
                  aria-hidden="true"
                  style={{ backgroundImage: `url("${item.src}")` }}
                />
                <span className="home-scene-name">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
